import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import {
  getUserWorkspaces,
  createWorkspace,
  verifyWorkspaceMembership,
  WorkspaceAccessError,
} from '../services/workspace.service.js';

export const workspaceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/v1/workspaces
  fastify.get('/', async (request, reply) => {
    const user = request.user!;
    const workspaces = getUserWorkspaces(fastify.dbCtx.db, user.id);
    return reply.status(200).send({ workspaces });
  });

  // POST /api/v1/workspaces
  fastify.post<{ Body: { name?: string; slug?: string } }>('/', async (request, reply) => {
    try {
      const user = request.user!;
      const { name, slug } = request.body || {};

      if (!name || !name.trim()) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Workspace name is required',
        });
      }

      const workspace = createWorkspace(fastify.dbCtx.db, user.id, { name, slug });
      return reply.status(201).send({ workspace });
    } catch (err: unknown) {
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: 'Bad Request',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to create workspace',
      });
    }
  });

  // GET /api/v1/workspaces/:id/storage
  fastify.get<{ Params: { id: string } }>('/:id/storage', async (request, reply) => {
    try {
      const user = request.user!;
      const workspaceId = request.params.id;
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId);

      const attRow = fastify.dbCtx.sqlite.prepare(
        'SELECT COALESCE(SUM(file_size), 0) AS total FROM attachments WHERE workspace_id = ?'
      ).get(workspaceId) as { total: number } | undefined;

      const memoRow = fastify.dbCtx.sqlite.prepare(
        'SELECT COALESCE(SUM(LENGTH(title) + LENGTH(content)), 0) AS total FROM memos WHERE workspace_id = ? AND deleted_at IS NULL'
      ).get(workspaceId) as { total: number } | undefined;

      const totalBytes = Number(attRow?.total || 0) + Number(memoRow?.total || 0);
      const maxBytes = 10 * 1024 * 1024 * 1024; // 10 GB limit
      const usedMB = (totalBytes / (1024 * 1024)).toFixed(2);
      const usedGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
      const percentUsed = Math.min(100, Math.max(0.1, Number((totalBytes / maxBytes * 100).toFixed(1))));

      return reply.status(200).send({
        totalBytes,
        usedFormatted: totalBytes > 1024 * 1024 * 1024 ? `${usedGB} GB` : `${usedMB} MB`,
        maxBytes,
        maxFormatted: '10 GB',
        percentUsed,
      });
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
        message: 'Failed to retrieve storage metrics',
      });
    }
  });

  // PATCH /api/v1/workspaces/:id
  fastify.patch<{ Params: { id: string }; Body: { name?: string } }>('/:id', async (request, reply) => {
    try {
      const user = request.user!;
      const workspaceId = request.params.id;
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId, ['owner', 'admin']);

      const { name } = request.body || {};
      if (!name || !name.trim()) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Workspace name is required',
        });
      }

      const now = Date.now();
      fastify.dbCtx.sqlite.prepare(
        'UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?'
      ).run(name.trim(), now, workspaceId);

      const updated = fastify.dbCtx.sqlite.prepare(
        'SELECT id, name, slug FROM workspaces WHERE id = ?'
      ).get(workspaceId);

      return reply.status(200).send({ workspace: updated });
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
        message: 'Failed to update workspace',
      });
    }
  });

  // GET /api/v1/workspaces/:id/members
  fastify.get<{ Params: { id: string } }>('/:id/members', async (request, reply) => {
    try {
      const user = request.user!;
      const workspaceId = request.params.id;
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId);

      const rows = fastify.dbCtx.sqlite.prepare(`
        SELECT wm.id, wm.role, wm.created_at as joinedAt, u.id as userId, u.name, u.email
        FROM workspace_members wm
        JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ?
        ORDER BY wm.created_at ASC
      `).all(workspaceId);

      return reply.status(200).send({ members: rows });
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
        message: 'Failed to retrieve workspace members',
      });
    }
  });

  // POST /api/v1/workspaces/:id/members
  fastify.post<{ Params: { id: string }; Body: { email?: string; role?: string } }>('/:id/members', async (request, reply) => {
    try {
      const user = request.user!;
      const workspaceId = request.params.id;
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId, ['owner', 'admin']);

      const { email, role = 'editor' } = request.body || {};
      if (!email || !email.trim()) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'User email is required',
        });
      }

      const targetUser = fastify.dbCtx.sqlite.prepare(
        'SELECT id, name, email FROM users WHERE LOWER(email) = LOWER(?)'
      ).get(email.trim()) as { id: string; name: string; email: string } | undefined;

      if (!targetUser) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'User with this email was not found. Please ask them to register first.',
        });
      }

      const existing = fastify.dbCtx.sqlite.prepare(
        'SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
      ).get(workspaceId, targetUser.id);

      if (existing) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'User is already a member of this workspace',
        });
      }

      const memberId = crypto.randomUUID();
      const now = Date.now();
      const assignedRole = ['owner', 'admin', 'editor', 'viewer'].includes(role) ? role : 'editor';

      fastify.dbCtx.sqlite.prepare(
        'INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(memberId, workspaceId, targetUser.id, assignedRole, now);

      return reply.status(201).send({
        member: {
          id: memberId,
          userId: targetUser.id,
          name: targetUser.name,
          email: targetUser.email,
          role: assignedRole,
          joinedAt: now,
        },
      });
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
        message: 'Failed to add workspace member',
      });
    }
  });

  // GET /api/v1/workspaces/:id/activities
  fastify.get<{ Params: { id: string } }>('/:id/activities', async (request, reply) => {
    try {
      const user = request.user!;
      const workspaceId = request.params.id;
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId);

      const memoEvents = fastify.dbCtx.sqlite.prepare(`
        SELECT 
          mv.id as id,
          'note_edited' as type,
          mv.title as detail,
          mv.created_at as timestamp,
          u.name as userName,
          u.email as userEmail,
          m.id as targetId
        FROM memo_versions mv
        JOIN memos m ON m.id = mv.memo_id
        JOIN users u ON u.id = mv.changed_by
        WHERE m.workspace_id = ?
        ORDER BY mv.created_at DESC
        LIMIT 25
      `).all(workspaceId) as any[];

      const memberEvents = fastify.dbCtx.sqlite.prepare(`
        SELECT 
          wm.id as id,
          'member_joined' as type,
          wm.role as detail,
          wm.created_at as timestamp,
          u.name as userName,
          u.email as userEmail,
          wm.id as targetId
        FROM workspace_members wm
        JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ?
        ORDER BY wm.created_at DESC
        LIMIT 25
      `).all(workspaceId) as any[];

      const noteCreations = fastify.dbCtx.sqlite.prepare(`
        SELECT 
          m.id as id,
          'note_created' as type,
          m.title as detail,
          m.created_at as timestamp,
          u.name as userName,
          u.email as userEmail,
          m.id as targetId
        FROM memos m
        JOIN users u ON u.id = m.created_by
        WHERE m.workspace_id = ?
        ORDER BY m.created_at DESC
        LIMIT 25
      `).all(workspaceId) as any[];

      const allActivities = [...memoEvents, ...memberEvents, ...noteCreations]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 40);

      return reply.status(200).send({ activities: allActivities });
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
        message: 'Failed to retrieve workspace activities',
      });
    }
  });
};
