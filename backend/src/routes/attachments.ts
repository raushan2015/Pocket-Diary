import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getWorkspaceMembership, WorkspaceAccessError } from '../services/workspace.service.js';
import type { DatabaseContext } from '../db/index.js';
import { MemoNotFoundError } from '../services/memo.service.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);
const STORAGE_ROOT = process.env.ATTACHMENTS_DIR || path.resolve(process.cwd(), '../data/attachments');

interface MemoRow { id: string; workspace_id: string; deleted_at: number | null; }

function resolveMemo(fastify: { dbCtx: DatabaseContext }, memoId: string, userId: string, write: boolean): { memo: MemoRow; workspaceId: string } {
  const memo = fastify.dbCtx.sqlite.prepare(
    'SELECT id, workspace_id, deleted_at FROM memos WHERE id = ?'
  ).get(memoId) as MemoRow | undefined;
  if (!memo || memo.deleted_at !== null) throw new MemoNotFoundError();
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

export const attachmentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get<{ Params: { memoId: string } }>('/memo/:memoId', async (request, reply) => {
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

  fastify.post<{ Params: { memoId: string } }>('/memo/:memoId', async (request, reply) => {
    let storedPath: string | undefined;
    try {
      const { memo, workspaceId } = resolveMemo(fastify, request.params.memoId, request.user!.id, true);
      if (!request.isMultipart()) {
        return reply.status(415).send({ error: 'Unsupported Media Type', message: 'Upload an image using multipart/form-data' });
      }
      const part = await request.file({ limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0 } });
      if (!part) return reply.status(400).send({ error: 'Bad Request', message: 'Choose an image to upload' });
      const ext = ALLOWED_TYPES.get(part.mimetype);
      if (!ext) {
        part.file.resume();
        return reply.status(415).send({ error: 'Unsupported Media Type', message: 'Only JPEG, PNG, and WebP images are supported' });
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

      fastify.dbCtx.sqlite.prepare(
        'INSERT INTO attachments (id, memo_id, workspace_id, file_name, file_size, mime_type, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, memo.id, workspaceId, fileName, fs.statSync(storedPath).size, part.mimetype, storedPath, now);
      const row = fastify.dbCtx.sqlite.prepare(
        'SELECT id, memo_id, file_name, file_size, mime_type, created_at FROM attachments WHERE id = ?'
      ).get(id);
      return reply.status(201).send({ attachment: attachmentDto(row) });
    } catch (error: any) {
      if (storedPath) { try { fs.unlinkSync(storedPath); } catch {} }
      if (error instanceof MemoNotFoundError) return reply.status(404).send({ error: 'Not Found', message: 'Memo not found' });
      if (error instanceof WorkspaceAccessError) return reply.status(error.statusCode).send({ error: 'Forbidden', message: error.message });
      if (error?.code === 'FST_REQ_FILE_TOO_LARGE' || /exceeds the 5 MB limit/i.test(error?.message || '')) {
        return reply.status(413).send({ error: 'Payload Too Large', message: 'Images must be 5 MB or smaller' });
      }
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Image upload failed' });
    }
  });

  fastify.get<{ Params: { id: string } }>('/:id/file', async (request, reply) => {
    try {
      const row = fastify.dbCtx.sqlite.prepare(
        'SELECT a.*, m.deleted_at FROM attachments a JOIN memos m ON m.id = a.memo_id WHERE a.id = ?'
      ).get(request.params.id) as any;
      if (!row || row.deleted_at !== null) return reply.status(404).send({ error: 'Not Found', message: 'Attachment not found' });
      if (!getWorkspaceMembership(fastify.dbCtx.db, request.user!.id, row.workspace_id)) {
        return reply.status(404).send({ error: 'Not Found', message: 'Attachment not found' });
      }
      if (!fs.existsSync(row.storage_path)) return reply.status(404).send({ error: 'Not Found', message: 'Attachment file missing' });
      reply.header('Content-Type', row.mime_type);
      reply.header('Content-Length', String(row.file_size));
      reply.header('Content-Disposition', `inline; filename="${String(row.file_name).replace(/["\\\\\r\n]/g, '_')}"`);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(fs.createReadStream(row.storage_path));
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Unable to retrieve attachment' });
    }
  });

  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
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
