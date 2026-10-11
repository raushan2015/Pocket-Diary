import type { FastifyPluginAsync } from 'fastify';
import {
  listMemos,
  getMemoById,
  createMemo,
  updateMemo,
  deleteMemo,
  restoreMemo,
  getMemoVersions,
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
  includeDeleted?: boolean | string;
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
  fastify.get<{ Querystring: MemoQuery }>('/', async (request, reply) => {
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
        includeDeleted: request.query.includeDeleted,
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
  fastify.post<{ Body: CreateMemoInput }>('/', async (request, reply) => {
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
  fastify.patch<{ Params: MemoParams; Body: UpdateMemoInput }>('/:id', async (request, reply) => {
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
};
