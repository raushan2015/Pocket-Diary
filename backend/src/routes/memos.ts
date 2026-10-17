import type { FastifyPluginAsync } from 'fastify';
import {
  listMemos,
  getMemoById,
  createMemo,
  updateMemo,
  deleteMemo,
  restoreMemo,
  getMemoVersions,
  reorderMemos,
  emptyTrash,
  MemoNotFoundError,
  MemoConflictError,
  ValidationError,
  type CreateMemoInput,
  type UpdateMemoInput,
  type ListMemosOptions,
} from '../services/memo.service.js';
import {
  getWorkspaceMembership,
  verifyWorkspaceMembership,
  WorkspaceAccessError,
} from '../services/workspace.service.js';
import {
  assertPublicHttpUrl,
  UrlGuardError,
} from '../services/url-guard.js';
import { guardedFetch, type GuardedResponse } from '../services/safe-fetch.js';

interface MemoQuery {
  workspaceId?: string;
  status?: string;
  priority?: string;
  categoryId?: string;
  tagId?: string;
  tagName?: string;
  folderId?: string;
  isFavorite?: boolean | string;
  isPinned?: boolean | string;
  isArchived?: boolean | string;
  hasReminder?: boolean | string;
  includeDeleted?: boolean | string;
  deletedOnly?: boolean | string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

interface MemoParams {
  id: string;
}

interface DeleteMemoQuery {
  permanent?: boolean | string;
}

const idSchema = { type: 'string', minLength: 1, maxLength: 64 };

const tagItemSchema = { type: 'string', minLength: 1, maxLength: 80 };

// Content limit aligned with the JSON body budget (see app.ts). Large embedded
// images are stored as attachments; this cap prevents runaway payloads while
// accommodating imports that embed images as data URIs.
const MEMO_MAX_CONTENT_CHARS = 2_000_000;

const memoBodyBaseSchema = {
  type: 'object',
  properties: {
    workspaceId: { ...idSchema },
    folderId: { type: ['string', 'null'], maxLength: 64 },
    categoryId: { type: ['string', 'null'], maxLength: 64 },
    title: { type: 'string', maxLength: 200 },
    content: { type: 'string', maxLength: MEMO_MAX_CONTENT_CHARS },
    color: { type: 'string', maxLength: 32 },
    theme: { type: 'string', maxLength: 32 },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    status: { type: 'string', enum: ['draft', 'pending', 'in_progress', 'completed', 'archived'] },
    isFavorite: { type: 'boolean' },
    isPinned: { type: 'boolean' },
    isArchived: { type: 'boolean' },
    noteType: { type: 'string', enum: ['text', 'checklist'], maxLength: 32 },
    sortOrder: { type: 'integer', minimum: 0, maximum: 1000000 },
    dueDate: { type: ['integer', 'null'], minimum: 0 },
    reminderTime: { type: ['integer', 'null'], minimum: 0 },
    reminderLocation: { type: ['string', 'null'], maxLength: 300 },
    collaborators: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: true } },
    checklistData: {
      type: ['array', 'null'],
      maxItems: 1000,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 64 },
          text: { type: 'string', maxLength: 5000 },
          checked: { type: 'boolean' },
          completed: { type: 'boolean' },
          sortOrder: { type: 'integer' },
        },
        additionalProperties: true,
      },
    },
    linkPreviews: {
      type: ['array', 'null'],
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          url: { type: 'string', maxLength: 2048 },
          title: { type: 'string', maxLength: 300 },
          description: { type: 'string', maxLength: 1000 },
          imageUrl: { type: 'string', maxLength: 2048 },
          image: { type: 'string', maxLength: 2048 },
          faviconUrl: { type: 'string', maxLength: 2048 },
        },
        additionalProperties: true,
      },
    },
    tags: { type: 'array', maxItems: 50, items: tagItemSchema },
    version: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

const createMemoSchema = {
  body: {
    ...memoBodyBaseSchema,
    required: ['workspaceId'],
  },
};

const updateMemoSchema = {
  body: memoBodyBaseSchema,
};

const listMemosSchema = {
  querystring: {
    type: 'object',
    required: ['workspaceId'],
    properties: {
      workspaceId: idSchema,
      status: { type: 'string', maxLength: 32 },
      priority: { type: 'string', maxLength: 32 },
      categoryId: idSchema,
      tagId: idSchema,
      tagName: { type: 'string', maxLength: 80 },
      folderId: idSchema,
      isFavorite: { type: 'string', enum: ['true', 'false'] },
      isPinned: { type: 'string', enum: ['true', 'false'] },
      isArchived: { type: 'string', enum: ['true', 'false'] },
      hasReminder: { type: 'string', enum: ['true', 'false'] },
      includeDeleted: { type: 'string', enum: ['true', 'false'] },
      deletedOnly: { type: 'string', enum: ['true', 'false'] },
      search: { type: 'string', maxLength: 200 },
      page: { type: 'integer', minimum: 1, maximum: 100000 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      sortBy: { type: 'string', maxLength: 40 },
      sortOrder: { type: 'string', enum: ['asc', 'desc'] },
    },
    additionalProperties: false,
  },
};

const reorderSchema = {
  body: {
    type: 'object',
    required: ['workspaceId', 'memoIds'],
    properties: {
      workspaceId: idSchema,
      memoIds: { type: 'array', minItems: 1, maxItems: 500, items: idSchema },
    },
    additionalProperties: false,
  },
};

const linkPreviewSchema = {
  body: {
    type: 'object',
    required: ['url'],
    properties: { url: { type: 'string', minLength: 8, maxLength: 2048 } },
    additionalProperties: false,
  },
};

export const memoRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // Helper to resolve memo and ensure tenant isolation
  const resolveAccessibleMemo = (memoId: string, userId: string, writeOperation = false) => {
    const raw = fastify.dbCtx.sqlite
      .prepare('SELECT * FROM memos WHERE id = ?')
      .get(memoId) as any;

    if (!raw) {
      throw new MemoNotFoundError('Memo not found');
    }

    // Verify workspace membership for the memo
    const member = getWorkspaceMembership(fastify.dbCtx.db, userId, raw.workspace_id);
    if (!member) {
      // Must not leak memo existence to other tenants: 404 Not Found
      throw new MemoNotFoundError('Memo not found');
    }

    if (writeOperation && member.role === 'viewer') {
      throw new WorkspaceAccessError('Viewers do not have permission to modify memos', 403);
    }

    return { raw, workspaceId: raw.workspace_id, role: member.role };
  };

  // GET /api/v1/memos (List & Full-Text Search)
  fastify.get<{ Querystring: MemoQuery }>('/', {
    schema: listMemosSchema,
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const { workspaceId } = request.query;

      if (!workspaceId) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'workspaceId query parameter is required',
        });
      }

      // Strict tenant isolation: verify user is a member of this workspace
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId);

      const requestedPage = request.query.page === undefined ? 1 : Number(request.query.page);
      const requestedLimit = request.query.limit === undefined ? 50 : Number(request.query.limit);

      if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 100000
        || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'page must be an integer from 1 to 100000 and limit must be an integer from 1 to 100',
        });
      }

      const pageNum = requestedPage;
      const limitNum = requestedLimit;

      const result = listMemos(fastify.dbCtx, {
        workspaceId,
        status: request.query.status,
        priority: request.query.priority,
        categoryId: request.query.categoryId,
        tagId: request.query.tagId,
        tagName: request.query.tagName,
        folderId: request.query.folderId,
        isFavorite: request.query.isFavorite,
        isPinned: request.query.isPinned,
        isArchived: request.query.isArchived,
        hasReminder: request.query.hasReminder,
        includeDeleted: request.query.includeDeleted,
        deletedOnly: request.query.deletedOnly,
        search: request.query.search,
        page: pageNum,
        limit: limitNum,
        sortBy: request.query.sortBy,
        sortOrder: request.query.sortOrder,
      });

      return reply.status(200).send(result);
    } catch (err: unknown) {
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 403 ? 'Forbidden' : 'Bad Request',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to retrieve memos',
      });
    }
  });

  // POST /api/v1/memos (Create Memo)
  fastify.post<{ Body: CreateMemoInput }>('/', {
    schema: createMemoSchema,
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const body = request.body || {};

      if (!body.workspaceId) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'workspaceId is required',
        });
      }

      // Strict tenant isolation and RBAC: viewers cannot create memos
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, body.workspaceId, ['owner', 'admin', 'editor']);

      const memo = createMemo(fastify.dbCtx, body, user.id);
      return reply.status(201).send({ memo });
    } catch (err: unknown) {
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 403 ? 'Forbidden' : 'Bad Request',
          message: err.message,
        });
      }
      if (err instanceof ValidationError) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to create memo',
      });
    }
  });

  // GET /api/v1/memos/:id (Get Single Memo)
  fastify.get<{ Params: MemoParams }>('/:id', async (request, reply) => {
    try {
      const user = request.user!;
      const { id } = request.params;

      const { workspaceId } = resolveAccessibleMemo(id, user.id, false);
      const memo = getMemoById(fastify.dbCtx, id, workspaceId);

      if (!memo) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memo not found',
        });
      }

      return reply.status(200).send({ memo });
    } catch (err: unknown) {
      if (err instanceof MemoNotFoundError) {
        return reply.status(404).send({
          error: 'Not Found',
          message: err.message,
        });
      }
      if (err instanceof WorkspaceAccessError) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memo not found',
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to retrieve memo',
      });
    }
  });

  // PATCH /api/v1/memos/:id (Update with Optimistic Concurrency Control)
  fastify.patch<{ Params: MemoParams; Body: UpdateMemoInput }>('/:id', {
    schema: updateMemoSchema,
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const { id } = request.params;
      const body = request.body || {};

      const { workspaceId } = resolveAccessibleMemo(id, user.id, true);
      const updatedMemo = updateMemo(fastify.dbCtx, id, workspaceId, body, user.id);

      return reply.status(200).send({ memo: updatedMemo });
    } catch (err: unknown) {
      if (err instanceof MemoConflictError) {
        return reply.status(409).send({
          error: 'Conflict',
          message: err.message,
          currentVersion: err.currentVersion,
        });
      }
      if (err instanceof MemoNotFoundError) {
        return reply.status(404).send({
          error: 'Not Found',
          message: err.message,
        });
      }
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 403 ? 'Forbidden' : 'Not Found',
          message: err.message,
        });
      }
      if (err instanceof ValidationError) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to update memo',
      });
    }
  });

  // DELETE /api/v1/memos/:id (Soft Delete or Permanent Hard Delete)
  fastify.delete<{ Params: MemoParams; Querystring: DeleteMemoQuery }>('/:id', async (request, reply) => {
    try {
      const user = request.user!;
      const { id } = request.params;
      const permanent = request.query.permanent === true || request.query.permanent === 'true';

      const { workspaceId } = resolveAccessibleMemo(id, user.id, true);
      if (permanent) {
        const attachmentRows = fastify.dbCtx.sqlite.prepare('SELECT storage_path FROM attachments WHERE memo_id = ?').all(id) as Array<{ storage_path: string }>;
        deleteMemo(fastify.dbCtx, id, workspaceId, true);
        for (const attachment of attachmentRows) {
          try { const fs = await import('node:fs'); fs.unlinkSync(attachment.storage_path); } catch (error: any) { if (error?.code !== 'ENOENT') fastify.log.warn(error, 'Unable to clean up memo attachment'); }
        }
      } else {
        deleteMemo(fastify.dbCtx, id, workspaceId, false);
      }

      return reply.status(200).send({ success: true });
    } catch (err: unknown) {
      if (err instanceof MemoNotFoundError) {
        return reply.status(404).send({
          error: 'Not Found',
          message: err.message,
        });
      }
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 403 ? 'Forbidden' : 'Not Found',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to delete memo',
      });
    }
  });

  // POST /api/v1/memos/:id/restore (Restore Soft-Deleted Memo)
  fastify.post<{ Params: MemoParams }>('/:id/restore', async (request, reply) => {
    try {
      const user = request.user!;
      const { id } = request.params;

      const { workspaceId } = resolveAccessibleMemo(id, user.id, true);
      const restored = restoreMemo(fastify.dbCtx, id, workspaceId);

      return reply.status(200).send({ memo: restored });
    } catch (err: unknown) {
      if (err instanceof MemoNotFoundError) {
        return reply.status(404).send({
          error: 'Not Found',
          message: err.message,
        });
      }
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 403 ? 'Forbidden' : 'Not Found',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to restore memo',
      });
    }
  });

  // GET /api/v1/memos/:id/versions (List Revision History)
  fastify.get<{ Params: MemoParams }>('/:id/versions', async (request, reply) => {
    try {
      const user = request.user!;
      const { id } = request.params;

      const { workspaceId } = resolveAccessibleMemo(id, user.id, false);
      const versions = getMemoVersions(fastify.dbCtx, id, workspaceId);

      return reply.status(200).send({ versions });
    } catch (err: unknown) {
      if (err instanceof MemoNotFoundError) {
        return reply.status(404).send({
          error: 'Not Found',
          message: err.message,
        });
      }
      if (err instanceof WorkspaceAccessError) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Memo not found',
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to retrieve memo versions',
      });
    }
  });

  // POST /api/v1/memos/reorder (Google Keep card drag & drop order)
  // Reordering changes shared state for every member (audit H-4): viewers
  // previously passed the unrestricted membership check and could reshuffle
  // everyone's board.
  fastify.post<{ Body: { workspaceId: string; memoIds: string[] } }>('/reorder', {
    schema: reorderSchema,
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const { workspaceId, memoIds } = request.body || {};
      if (!workspaceId || !Array.isArray(memoIds)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'workspaceId and memoIds array are required',
        });
      }
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId, ['owner', 'admin', 'editor']);
      reorderMemos(fastify.dbCtx, workspaceId, memoIds);
      return reply.status(200).send({ success: true, count: memoIds.length });
    } catch (err: unknown) {
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: 'Forbidden',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to reorder memos',
      });
    }
  });

  // DELETE /api/v1/memos/trash?workspaceId=... — Empty Trash (bulk permanent delete)
  //
  // Permanently removes every soft-deleted memo in the workspace along with
  // its attachment files. Editors and above may empty the trash.
  fastify.delete<{ Querystring: { workspaceId?: string } }>('/trash', {
    schema: {
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: idSchema },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const { workspaceId } = request.query || {};
      if (!workspaceId) {
        return reply.status(400).send({ error: 'Bad Request', message: 'workspaceId is required' });
      }

      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId, ['owner', 'admin', 'editor']);

      const result = emptyTrash(fastify.dbCtx, workspaceId);

      // Best-effort cleanup of attachment files (rows already cascaded away).
      for (const attachmentPath of result.attachmentPaths) {
        try {
          const fs = await import('node:fs');
          fs.unlinkSync(attachmentPath);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') fastify.log.warn(error, 'Unable to clean up attachment file during trash purge');
        }
      }

      return reply.status(200).send({ success: true, deletedCount: result.deletedCount });
    } catch (err: unknown) {
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 403 ? 'Forbidden' : 'Not Found',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to empty trash',
      });
    }
  });

  // POST /api/v1/memos/link-preview (Scrape OpenGraph / Metadata for URLs)
  //
  // SSRF protection (SEC-01 + audit M-11): every target — the initial URL and
  // each redirect hop — must resolve to a public address, and the request is
  // made with guardedFetch(), which connects to the exact validated IPs
  // (Host header + TLS SNI preserved). Private, loopback, link-local and
  // cloud-metadata destinations are rejected with HTTP 400; a DNS-rebinding
  // server can no longer pass validation and then connect elsewhere.
  const LINK_PREVIEW_MAX_HTML_BYTES = 256 * 1024;
  const LINK_PREVIEW_MAX_REDIRECTS = 4;

  fastify.post<{ Body: { url: string } }>('/link-preview', {
    schema: linkPreviewSchema,
  }, async (request, reply) => {
    const fallbackPreview = (targetUrl: string) => {
      const parsed = new URL(targetUrl);
      return {
        url: targetUrl,
        title: parsed.hostname,
        faviconUrl: `${parsed.origin}/favicon.ico`,
      };
    };

    try {
      const { url } = request.body || {};
      if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Valid http or https URL is required',
        });
      }

      // Validate the requested destination before any request leaves the server.
      try {
        await assertPublicHttpUrl(url);
      } catch (err) {
        if (err instanceof UrlGuardError) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: err.message,
          });
        }
        // DNS resolution failed: no request can succeed, so degrade to a
        // hostname-only preview (same behaviour as an unreachable host).
        return reply.send(fallbackPreview(url));
      }

      // Redirects are followed manually so every hop is re-validated against
      // the SSRF guard inside guardedFetch before the server connects to it.
      let res: GuardedResponse;
      try {
        res = await guardedFetch(url, {
          timeoutMs: 4000,
          maxBytes: LINK_PREVIEW_MAX_HTML_BYTES,
        });
      } catch (fetchErr) {
        if (fetchErr instanceof UrlGuardError) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: fetchErr.message,
          });
        }
        return reply.send(fallbackPreview(url));
      }

      let redirects = 0;
      while (res.status >= 300 && res.status < 400) {
        const location = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
        if (!location) break; // malformed redirect — fall through to the !res.ok path
        if (redirects++ >= LINK_PREVIEW_MAX_REDIRECTS) {
          return reply.send(fallbackPreview(url));
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, res.url);
        } catch {
          return reply.send(fallbackPreview(url));
        }
        try {
          res = await guardedFetch(nextUrl, {
            timeoutMs: 4000,
            maxBytes: LINK_PREVIEW_MAX_HTML_BYTES,
          });
        } catch (guardErr) {
          if (guardErr instanceof UrlGuardError) {
            return reply.status(400).send({
              error: 'Bad Request',
              message: 'Private or internal IP addresses are prohibited',
            });
          }
          return reply.send(fallbackPreview(url));
        }
      }

      const parsed = new URL(url);
      if (res.status < 200 || res.status >= 300) {
        return reply.send({
          url,
          title: parsed.hostname,
          faviconUrl: `${parsed.origin}/favicon.ico`,
        });
      }
      const html = res.body;
      const getMeta = (prop: string) => {
          const m = html.match(new RegExp(`<meta\\s+[^>]*(?:property|name)=["'](?:og:)?${prop}["'][^>]*content=["']([^"']+)["']`, 'i'))
            || html.match(new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:)?${prop}["']`, 'i'));
          return m ? m[1].trim() : undefined;
        };

        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = getMeta('title') || (titleMatch ? titleMatch[1].trim() : parsed.hostname);
        const description = getMeta('description');
        let imageUrl = getMeta('image');
        if (imageUrl && !imageUrl.startsWith('http')) {
          try {
            imageUrl = new URL(imageUrl, parsed.origin).href;
          } catch {
            imageUrl = undefined;
          }
        }
        const faviconUrl = `${parsed.origin}/favicon.ico`;

        return reply.send({
          url,
          title: title || parsed.hostname,
          description,
          imageUrl,
          faviconUrl,
        });
    } catch (err: unknown) {
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to generate link preview',
      });
    }
  });
};
