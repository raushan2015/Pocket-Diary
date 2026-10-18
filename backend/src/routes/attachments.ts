import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import {
  SESSION_SECURITY,
  jsonResponse,
  errorResponses,
  ref,
  refArray,
  idParam,
  openapiParams,
  multipartBody,
} from '../openapi.js';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { getWorkspaceMembership, WorkspaceAccessError } from '../services/workspace.service.js';
import type { DatabaseContext } from '../db/index.js';
import { MemoNotFoundError } from '../services/memo.service.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['text/markdown', '.md'],
]);
const STORAGE_ROOT = process.env.ATTACHMENTS_DIR || path.resolve(process.cwd(), '../data/attachments');

/**
 * Magic-byte signatures per allowed MIME type (audit L-6). The client's
 * Content-Type claim is no longer trusted on its own: a file renamed to
 * `.png` but actually carrying script/HTML bytes is rejected at upload.
 * Text types have no signature — they are always served with a restrictive
 * `Content-Disposition: attachment` + `nosniff`, which the images are not.
 */
const MAGIC_SIGNATURES: Record<string, Array<(bytes: Buffer) => boolean>> = {
  'image/jpeg': [(b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  'image/png': [(b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  'image/gif': [(b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  'image/webp': [(b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  'application/pdf': [(b) => b.subarray(0, 5).toString('latin1') === '%PDF-'],
};

function matchesClaimedMime(mimeType: string, filePath: string): boolean {
  const checks = MAGIC_SIGNATURES[mimeType];
  if (!checks) return true; // text/*: no signature to verify — handled via response headers
  let head: Buffer;
  try {
    head = Buffer.alloc(16);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  } catch {
    return false;
  }
  return checks.some((check) => check(head));
}

/** Download-safe types: never rendered inline by the browser (audit L-6). */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

interface MemoRow { id: string; workspace_id: string; deleted_at: number | null; }

function resolveMemo(fastify: { dbCtx: DatabaseContext }, memoId: string, userId: string, write: boolean): { memo: MemoRow; workspaceId: string } {
  const memo = fastify.dbCtx.sqlite.prepare(
    'SELECT id, workspace_id, deleted_at FROM memos WHERE id = ?'
  ).get(memoId) as MemoRow | undefined;
  if (!memo) throw new MemoNotFoundError();
  // Soft-deleted (trashed) notes stay readable so members can inspect their
  // attachments before restoring or purging; writes are rejected (BUG-01).
  if (write && memo.deleted_at !== null) throw new MemoNotFoundError();
  const member = getWorkspaceMembership(fastify.dbCtx.db, userId, memo.workspace_id);
  if (!member) throw new MemoNotFoundError();
  if (write && member.role === 'viewer') throw new WorkspaceAccessError('Viewers cannot add or remove attachments', 403);
  return { memo, workspaceId: memo.workspace_id };
}

function attachmentDto(row: any) {
  return {
    id: row.id,
    memoId: row.memo_id,
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    url: `/api/v1/attachments/${encodeURIComponent(row.id)}/file`,
  };
}

// ---------------------------------------------------------------------------
// OpenAPI metadata (spec-only; see src/openapi.ts)
// ---------------------------------------------------------------------------

const uploadErrors = errorResponses([400, 401, 403, 404, 413, 415, 500]);

const listMeta = {
  tags: ['Attachments'],
  summary: 'List a note\'s attachments',
  description: 'Metadata for every attachment on the note (including trashed notes, so Trash view thumbnails render). Any workspace member may read them.',
  security: SESSION_SECURITY,
  openapi: {
    ...openapiParams({ memoId: idParam('memoId', 'Memo id.') }, ['memoId']),
    responses: {
      200: jsonResponse(
        { type: 'object', required: ['attachments'], properties: { attachments: refArray('Attachment') } },
        'Attachments on the note.',
      ),
      ...errorResponses([401, 403, 404, 500]),
    },
  },
};

const uploadMeta = {
  tags: ['Attachments'],
  summary: 'Upload an attachment',
  description: 'Multipart upload of a single image or document to the note (max 5 MB). The file\'s magic bytes must match the declared type (audit L-6); the workspace storage quota applies (413). Viewers are rejected; trashed notes reject uploads.',
  security: SESSION_SECURITY,
  openapi: {
    ...openapiParams({ memoId: idParam('memoId', 'Memo id.') }, ['memoId']),
    requestBody: multipartBody(
      {
        file: {
          type: 'string',
          format: 'binary',
          description: 'One file. Allowed: JPEG, PNG, WebP, GIF images; PDF, TXT, Markdown documents.',
        },
      },
      ['file'],
      'The multipart/form-data upload (single `file` field).',
    ),
    responses: {
      201: jsonResponse(
        { type: 'object', required: ['attachment'], properties: { attachment: ref('Attachment') } },
        'Attachment stored; its `url` serves the bytes.',
      ),
      ...uploadErrors,
    },
  },
};

const downloadMeta = {
  tags: ['Attachments'],
  summary: 'Download an attachment',
  description: 'Streams the stored file. Images render `inline`; PDFs and text download with `Content-Disposition: attachment` (audit L-6). Membership-checked: other tenants get 404.',
  security: SESSION_SECURITY,
  openapi: {
    ...openapiParams({ id: idParam('id', 'Attachment id.') }, ['id']),
    responses: {
      200: {
        description: 'File bytes with the stored `Content-Type` and a `Content-Disposition` of `inline` (images) or `attachment` (documents).',
        content: {
          'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
        },
        headers: {
          'Content-Type': { schema: { type: 'string' }, description: 'The stored MIME type.' },
          'Content-Disposition': { schema: { type: 'string' }, description: '`inline` for images, `attachment` otherwise (audit L-6).' },
        },
      },
      ...errorResponses([401, 404, 500]),
    },
  },
};

const deleteMeta = {
  tags: ['Attachments'],
  summary: 'Delete an attachment',
  description: 'Removes the attachment row and its file on disk. Viewers are rejected.',
  security: SESSION_SECURITY,
  openapi: {
    ...openapiParams({ id: idParam('id', 'Attachment id.') }, ['id']),
    responses: {
      200: jsonResponse(ref('SimpleSuccess'), 'Attachment deleted.'),
      ...errorResponses([401, 403, 404, 500]),
    },
  },
};

export const attachmentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get<{ Params: { memoId: string } }>('/memo/:memoId', { schema: listMeta }, async (request, reply) => {
    try {
      const { memo } = resolveMemo(fastify, request.params.memoId, request.user!.id, false);
      const rows = fastify.dbCtx.sqlite.prepare(
        'SELECT id, memo_id, file_name, file_size, mime_type, created_at FROM attachments WHERE memo_id = ? AND workspace_id = ? ORDER BY created_at, id'
      ).all(memo.id, memo.workspace_id) as any[];
      return reply.send({ attachments: rows.map(attachmentDto) });
    } catch (error) {
      if (error instanceof MemoNotFoundError) return reply.status(404).send({ error: 'Not Found', message: 'Memo not found' });
      if (error instanceof WorkspaceAccessError) return reply.status(error.statusCode).send({ error: 'Forbidden', message: error.message });
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Unable to list attachments' });
    }
  });

  fastify.post<{ Params: { memoId: string } }>('/memo/:memoId', { schema: uploadMeta }, async (request, reply) => {
    let storedPath: string | undefined;
    try {
      const { memo, workspaceId } = resolveMemo(fastify, request.params.memoId, request.user!.id, true);
      if (!request.isMultipart()) {
        return reply.status(415).send({ error: 'Unsupported Media Type', message: 'Upload an image using multipart/form-data' });
      }
      const part = await request.file({ limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 } });
      if (!part) return reply.status(400).send({ error: 'Bad Request', message: 'Choose an image to upload' });
      const ext = ALLOWED_TYPES.get(part.mimetype);
      if (!ext) {
        part.file.resume();
        return reply.status(415).send({ error: 'Unsupported Media Type', message: 'Only images (JPEG, PNG, WebP, GIF) and documents (PDF, TXT, Markdown) are supported' });
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      const safeBase = path.basename(part.filename || 'image').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'image';
      const fileName = /\.[a-zA-Z0-9]{1,8}$/.test(safeBase) ? safeBase : `${safeBase}${ext}`;
      const directory = path.join(STORAGE_ROOT, workspaceId, memo.id);
      fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
      storedPath = path.join(directory, `${id}${ext}`);
      await pipeline(part.file, fs.createWriteStream(storedPath, { flags: 'wx', mode: 0o640 }));
      if (part.file.truncated) throw new Error('Uploaded image exceeds the 5 MB limit');

      // Audit L-6: verify the file's magic bytes against the claimed type —
      // a mislabeled payload (e.g. HTML/JS bytes named "photo.png") is rejected.
      if (!matchesClaimedMime(part.mimetype, storedPath)) {
        throw new Error('File contents do not match its declared type');
      }

      const fileSize = fs.statSync(storedPath).size;

      // Workspace storage quota enforcement (configurable via STORAGE_QUOTA_GB, audit L-10)
      const currentStorage = fastify.dbCtx.sqlite.prepare(
        'SELECT COALESCE(SUM(file_size), 0) AS total FROM attachments WHERE workspace_id = ?'
      ).get(workspaceId) as { total: number } | undefined;
      const MAX_WORKSPACE_STORAGE = config.storageQuotaBytes;
      if ((currentStorage?.total || 0) + fileSize > MAX_WORKSPACE_STORAGE) {
        throw new Error('Workspace attachment storage quota exceeded');
      }

      fastify.dbCtx.sqlite.prepare(
        'INSERT INTO attachments (id, memo_id, workspace_id, file_name, file_size, mime_type, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, memo.id, workspaceId, fileName, fileSize, part.mimetype, storedPath, now);
      const row = fastify.dbCtx.sqlite.prepare(
        'SELECT id, memo_id, file_name, file_size, mime_type, created_at FROM attachments WHERE id = ?'
      ).get(id);
      return reply.status(201).send({ attachment: attachmentDto(row) });
    } catch (error: any) {
      if (storedPath) { try { fs.unlinkSync(storedPath); } catch {} }
      if (error instanceof MemoNotFoundError) return reply.status(404).send({ error: 'Not Found', message: 'Memo not found' });
      if (error instanceof WorkspaceAccessError) return reply.status(error.statusCode).send({ error: 'Forbidden', message: error.message });
      if (/storage quota exceeded/i.test(error?.message || '')) {
        return reply.status(413).send({ error: 'Payload Too Large', message: 'Workspace storage quota exceeded. Upgrade storage or delete unused attachments.' });
      }
      if (/do not match its declared type/i.test(error?.message || '')) {
        return reply.status(415).send({ error: 'Unsupported Media Type', message: 'File contents do not match its declared type. Upload a real image or document.' });
      }
      if (error?.code === 'FST_REQ_FILE_TOO_LARGE' || /exceeds the 5 MB limit/i.test(error?.message || '')) {
        return reply.status(413).send({ error: 'Payload Too Large', message: 'Images must be 5 MB or smaller' });
      }
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Image upload failed' });
    }
  });

  fastify.get<{ Params: { id: string } }>('/:id/file', { schema: downloadMeta }, async (request, reply) => {
    try {
      const row = fastify.dbCtx.sqlite.prepare(
        'SELECT a.*, m.deleted_at FROM attachments a JOIN memos m ON m.id = a.memo_id WHERE a.id = ?'
      ).get(request.params.id) as any;
      // Soft-deleted (trashed) memos keep serving their attachments to
      // workspace members so Trash view thumbnails render correctly (BUG-01).
      // Cross-tenant access is still prevented via the membership check below.
      if (!row) return reply.status(404).send({ error: 'Not Found', message: 'Attachment not found' });
      if (!getWorkspaceMembership(fastify.dbCtx.db, request.user!.id, row.workspace_id)) {
        return reply.status(404).send({ error: 'Not Found', message: 'Attachment not found' });
      }
      if (!fs.existsSync(row.storage_path)) return reply.status(404).send({ error: 'Not Found', message: 'Attachment file missing' });
      reply.header('Content-Type', row.mime_type);
      reply.header('Content-Length', String(row.file_size));
      // Audit L-6: only images render inline; PDFs and text always download.
      // Together with nosniff this stops a mislabeled file from executing as
      // HTML in the app's origin.
      const disposition = INLINE_TYPES.has(row.mime_type) ? 'inline' : 'attachment';
      reply.header('Content-Disposition', `${disposition}; filename="${String(row.file_name).replace(/["\\\\\r\n]/g, '_')}"`);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(fs.createReadStream(row.storage_path));
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Unable to retrieve attachment' });
    }
  });

  fastify.delete<{ Params: { id: string } }>('/:id', { schema: deleteMeta }, async (request, reply) => {
    try {
      const row = fastify.dbCtx.sqlite.prepare(
        'SELECT id, memo_id, workspace_id, storage_path FROM attachments WHERE id = ?'
      ).get(request.params.id) as any;
      if (!row) return reply.status(404).send({ error: 'Not Found', message: 'Attachment not found' });
      resolveMemo(fastify, row.memo_id, request.user!.id, true);
      fastify.dbCtx.sqlite.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
      try { fs.unlinkSync(row.storage_path); } catch (error: any) { if (error?.code !== 'ENOENT') fastify.log.warn(error, 'Unable to remove attachment file'); }
      return reply.send({ success: true });
    } catch (error) {
      if (error instanceof MemoNotFoundError) return reply.status(404).send({ error: 'Not Found', message: 'Attachment not found' });
      if (error instanceof WorkspaceAccessError) return reply.status(error.statusCode).send({ error: 'Forbidden', message: error.message });
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Unable to delete attachment' });
    }
  });
};
