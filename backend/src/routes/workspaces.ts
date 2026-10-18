import type { FastifyPluginAsync } from 'fastify';
import {
  getUserWorkspaces,
  createWorkspace,
  verifyWorkspaceMembership,
  removeWorkspaceMember,
  changeMemberRole,
  WorkspaceAccessError,
} from '../services/workspace.service.js';
import {
  createInvite,
  sendInviteEmail,
  listInvites,
  revokeInvite,
  InviteError,
} from '../services/invite.service.js';
import { isEmailEnabled } from '../services/mailer.service.js';
import { resolveAppUrl, config } from '../config.js';
import {
  leaveWorkspace,
  transferWorkspaceOwnership,
} from '../services/workspace.service.js';
import {
  SESSION_SECURITY,
  jsonResponse,
  errorResponses,
  ref,
  refArray,
  idParam,
  openapiParams,
} from '../openapi.js';

const createWorkspaceSchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      slug: { type: 'string', minLength: 1, maxLength: 80 },
    },
    additionalProperties: false,
  },
};

const updateWorkspaceSchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
    additionalProperties: false,
  },
};

const changeRoleSchema = {
  body: {
    type: 'object',
    required: ['role'],
    properties: { role: { type: 'string', enum: ['admin', 'editor', 'viewer'] } },
    additionalProperties: false,
  },
};

const createInviteSchema = {
  body: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 254 },
      role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
    },
    additionalProperties: false,
  },
};

/**
 * Public base URL used in invitation links. Single source of truth lives in
 * config.ts (audit C-3): links are never built from request headers.
 */

// ---------------------------------------------------------------------------
// OpenAPI metadata (spec-only; see src/openapi.ts)
// ---------------------------------------------------------------------------

const wsIdParams = openapiParams({ id: idParam('id', 'Workspace id.') }, ['id']);

const wsAccessErrors = errorResponses([401, 403, 404, 500]);

const listMeta = {
  tags: ['Workspaces'],
  summary: 'List your workspaces',
  description: 'Every workspace the signed-in user belongs to, with their role in each.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        { type: 'object', required: ['workspaces'], properties: { workspaces: refArray('Workspace') } },
        'Workspaces the user can access.',
      ),
      ...errorResponses([401, 429]),
    },
  },
};

const createMeta = {
  tags: ['Workspaces'],
  summary: 'Create a workspace',
  description: 'Creates a workspace with the caller as owner. `slug` is optional (generated when omitted); duplicate names or slugs yield 409.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      201: jsonResponse(
        { type: 'object', required: ['workspace'], properties: { workspace: ref('Workspace') } },
        'Workspace created; the caller is its owner.',
      ),
      ...errorResponses([400, 401, 409, 500]),
    },
  },
};

const storageMeta = {
  tags: ['Workspaces'],
  summary: 'Workspace storage usage',
  description: 'Byte-accurate storage meter for note text plus attachment files, against the configured quota (audit L-10). Any member may read it.',
  security: SESSION_SECURITY,
  openapi: {
    ...wsIdParams,
    responses: {
      200: jsonResponse(ref('StorageUsage'), 'Current usage and quota.'),
      ...wsAccessErrors,
    },
  },
};

const updateMeta = {
  tags: ['Workspaces'],
  summary: 'Rename a workspace',
  description: 'Updates the workspace name. Restricted to owner and admin.',
  security: SESSION_SECURITY,
  openapi: {
    ...wsIdParams,
    responses: {
      200: jsonResponse(
        { type: 'object', required: ['workspace'], properties: { workspace: ref('Workspace') } },
        'Updated workspace.',
      ),
      ...wsAccessErrors,
    },
  },
};

const membersMeta = {
  tags: ['Workspaces'],
  summary: 'List members',
  description: 'All members of the workspace with name, email, role and join time.',
  security: SESSION_SECURITY,
  openapi: {
    ...wsIdParams,
    responses: {
      200: jsonResponse(
        { type: 'object', required: ['members'], properties: { members: refArray('Member') } },
        'Workspace members.',
      ),
      ...wsAccessErrors,
    },
  },
};

const activitiesMeta = {
  tags: ['Workspaces'],
  summary: 'Workspace activity feed',
  description: 'Recent note edits, note creations and member joins (latest 40 events). Any member may read it.',
  security: SESSION_SECURITY,
  openapi: {
    ...wsIdParams,
    responses: {
      200: jsonResponse(
        { type: 'object', required: ['activities'], properties: { activities: refArray('Activity') } },
        'Activity events, newest first.',
      ),
      ...wsAccessErrors,
    },
  },
};

const removeMemberMeta = {
  tags: ['Workspaces'],
  summary: 'Remove a member',
  description: 'Removes a member from the workspace and clears their workspace notifications (audit L-13). The owner cannot be removed; only the owner (or an admin for non-admin targets) may remove members.',
  security: SESSION_SECURITY,
  openapi: {
    ...openapiParams(
      {
        id: idParam('id', 'Workspace id.'),
        userId: idParam('userId', 'User id of the member to remove.'),
      },
      ['id', 'userId'],
    ),
    responses: {
      200: jsonResponse(ref('SimpleSuccess'), 'Member removed.'),
      ...wsAccessErrors,
    },
  },
};

const leaveMeta = {
  tags: ['Workspaces'],
  summary: 'Leave a workspace',
  description: 'The signed-in member leaves the workspace; their workspace notifications are cleared (audit L-13). Owners must transfer ownership first (403).',
  security: SESSION_SECURITY,
  openapi: {
    ...wsIdParams,
    responses: {
      200: jsonResponse(ref('SimpleSuccess'), 'Left the workspace.'),
      ...wsAccessErrors,
    },
  },
};

const transferMeta = {
  tags: ['Workspaces'],
  summary: 'Transfer ownership',
  description: 'Owner-only: promotes the named member to owner and demotes the caller to admin (audit L-8).',
  security: SESSION_SECURITY,
  openapi: {
    ...wsIdParams,
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['success', 'workspace'],
          properties: {
            success: { type: 'boolean' },
            workspace: {
              type: 'object',
              required: ['workspaceId', 'newOwnerId'],
              properties: {
                workspaceId: { type: 'string' },
                newOwnerId: { type: 'string' },
              },
            },
          },
        },
        'Ownership transferred.',
      ),
      ...errorResponses([400, 401, 403, 404, 500]),
    },
  },
};

const changeRoleMeta = {
  tags: ['Workspaces'],
  summary: 'Change a member role',
  description: 'Changes a member\'s role (admin/editor/viewer). Only the owner may grant or change admin roles (audit H-8); the owner\'s own role cannot be changed.',
  security: SESSION_SECURITY,
  openapi: {
    ...openapiParams(
      {
        id: idParam('id', 'Workspace id.'),
        userId: idParam('userId', 'User id of the member.'),
      },
      ['id', 'userId'],
    ),
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['member'],
          properties: {
            member: {
              type: 'object',
              required: ['userId', 'role'],
              properties: {
                userId: { type: 'string' },
                role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
              },
            },
          },
        },
        'Role updated.',
      ),
      ...errorResponses([400, 401, 403, 404, 500]),
    },
  },
};

const createInviteMeta = {
  tags: ['Workspaces'],
  summary: 'Invite someone to the workspace',
  description: 'Creates (or refreshes — audit M-1) a single-use invitation and emails it when SMTP is configured. The response contains the raw token and ready-made `inviteUrl` exactly once; the server persists only a hash (audit H-7). Responds identically whether or not the address already has an account (audit H-3). Restricted to owner/admin.',
  security: SESSION_SECURITY,
  openapi: {
    ...wsIdParams,
    responses: {
      201: jsonResponse(
        {
          type: 'object',
          required: ['invite', 'inviteUrl', 'emailDelivery'],
          properties: {
            invite: ref('Invite'),
            inviteUrl: { type: 'string', description: 'Shareable link built from the configured APP_URL.' },
            emailDelivery: { type: 'string', enum: ['sent', 'failed', 'disabled'], description: 'Whether the invite email was delivered, or SMTP is not configured.' },
          },
        },
        'Invitation created.',
      ),
      ...errorResponses([400, 401, 403, 500]),
    },
  },
};

const listInvitesMeta = {
  tags: ['Workspaces'],
  summary: 'List invitations',
  description: 'Pending and past invitations for the workspace (no raw tokens). Any member may read it.',
  security: SESSION_SECURITY,
  openapi: {
    ...wsIdParams,
    responses: {
      200: jsonResponse(
        { type: 'object', required: ['invites'], properties: { invites: refArray('Invite') } },
        'Invitations, newest first.',
      ),
      ...wsAccessErrors,
    },
  },
};

const revokeInviteMeta = {
  tags: ['Workspaces'],
  summary: 'Revoke an invitation',
  description: 'Revokes a pending invitation so its link stops working. Restricted to owner/admin.',
  security: SESSION_SECURITY,
  openapi: {
    ...openapiParams(
      {
        id: idParam('id', 'Workspace id.'),
        inviteId: idParam('inviteId', 'Invitation id.'),
      },
      ['id', 'inviteId'],
    ),
    responses: {
      200: jsonResponse(ref('SimpleSuccess'), 'Invitation revoked.'),
      ...errorResponses([401, 403, 404, 500]),
    },
  },
};

export const workspaceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/v1/workspaces
  fastify.get('/', { schema: listMeta }, async (request, reply) => {
    const user = request.user!;
    const workspaces = getUserWorkspaces(fastify.dbCtx.db, user.id);
    return reply.status(200).send({ workspaces });
  });

  // POST /api/v1/workspaces
  fastify.post<{ Body: { name?: string; slug?: string } }>('/', {
    schema: { ...createWorkspaceSchema, ...createMeta },
  }, async (request, reply) => {
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
          error: err.statusCode === 403 ? 'Forbidden' : err.statusCode === 409 ? 'Conflict' : 'Bad Request',
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
  fastify.get<{ Params: { id: string } }>('/:id/storage', { schema: storageMeta }, async (request, reply) => {
    try {
      const user = request.user!;
      const workspaceId = request.params.id;
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId);

      // Audit L-10: count BYTES, not characters — SQLite's LENGTH(text) counts
      // code points, so multi-byte (CJK, emoji) content was under-counted by
      // up to 4×. Casting to BLOB makes LENGTH() return bytes.
      const attRow = fastify.dbCtx.sqlite.prepare(
        'SELECT COALESCE(SUM(file_size), 0) AS total FROM attachments WHERE workspace_id = ?'
      ).get(workspaceId) as { total: number } | undefined;

      const memoRow = fastify.dbCtx.sqlite.prepare(
        'SELECT COALESCE(SUM(LENGTH(CAST(title AS BLOB)) + LENGTH(CAST(content AS BLOB))), 0) AS total FROM memos WHERE workspace_id = ? AND deleted_at IS NULL'
      ).get(workspaceId) as { total: number } | undefined;

      const totalBytes = Number(attRow?.total || 0) + Number(memoRow?.total || 0);
      const maxBytes = config.storageQuotaBytes; // configurable via STORAGE_QUOTA_GB (audit L-10)
      const usedMB = (totalBytes / (1024 * 1024)).toFixed(2);
      const usedGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
      const percentUsed = Math.min(100, Math.max(totalBytes > 0 ? 0.1 : 0, Number((totalBytes / maxBytes * 100).toFixed(1))));

      return reply.status(200).send({
        totalBytes,
        usedFormatted: totalBytes > 1024 * 1024 * 1024 ? `${usedGB} GB` : `${usedMB} MB`,
        maxBytes,
        maxFormatted: `${(maxBytes / (1024 * 1024 * 1024)).toFixed(0)} GB`,
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
  fastify.patch<{ Params: { id: string }; Body: { name?: string } }>('/:id', {
    schema: { ...updateWorkspaceSchema, ...updateMeta },
  }, async (request, reply) => {
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
  fastify.get<{ Params: { id: string } }>('/:id/members', { schema: membersMeta }, async (request, reply) => {
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

  // NOTE (audit H-3): there is deliberately no POST /workspaces/:id/members
  // endpoint. Direct member insertion bypassed the invitation flow's email
  // ownership check (admins could pull any registered account into a workspace
  // without consent) and its 404-vs-201 response let any signed-in user
  // enumerate which email addresses have accounts. All member additions go
  // through POST /workspaces/:id/invites, which requires the invited user to
  // accept from the matching email address and responds identically whether
  // or not the address is registered.

  // GET /api/v1/workspaces/:id/activities
  fastify.get<{ Params: { id: string } }>('/:id/activities', { schema: activitiesMeta }, async (request, reply) => {
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


  // DELETE /api/v1/workspaces/:id/members/:userId — remove a member
  fastify.delete<{ Params: { id: string; userId: string } }>('/:id/members/:userId', { schema: removeMemberMeta }, async (request, reply) => {
    try {
      const user = request.user!;
      const { id, userId } = request.params;
      removeWorkspaceMember(fastify.dbCtx.db, user.id, id, userId);
      return reply.status(200).send({ success: true });
    } catch (err: unknown) {
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 404 ? 'Not Found' : 'Forbidden',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Failed to remove member' });
    }
  });

  // POST /api/v1/workspaces/:id/leave — leave a workspace yourself (audit L-8)
  fastify.post<{ Params: { id: string } }>('/:id/leave', { schema: leaveMeta }, async (request, reply) => {
    try {
      const user = request.user!;
      leaveWorkspace(fastify.dbCtx.db, user.id, request.params.id);
      return reply.status(200).send({ success: true });
    } catch (err: unknown) {
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 404 ? 'Not Found' : 'Forbidden',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Failed to leave workspace' });
    }
  });

  // POST /api/v1/workspaces/:id/transfer — transfer ownership to a member (audit L-8)
  fastify.post<{ Params: { id: string }; Body: { userId?: string } }>('/:id/transfer', {
    schema: {
      body: {
        type: 'object',
        required: ['userId'],
        properties: { userId: { type: 'string', minLength: 1, maxLength: 64 } },
        additionalProperties: false,
      },
      ...transferMeta,
    },
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const targetUserId = String(request.body?.userId || '').trim();
      if (!targetUserId) {
        return reply.status(400).send({ error: 'Bad Request', message: 'userId is required' });
      }
      const result = transferWorkspaceOwnership(fastify.dbCtx.db, user.id, request.params.id, targetUserId);
      return reply.status(200).send({ success: true, workspace: result });
    } catch (err: unknown) {
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 404 ? 'Not Found' : 'Forbidden',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Failed to transfer ownership' });
    }
  });

  // PATCH /api/v1/workspaces/:id/members/:userId — change a member's role
  fastify.patch<{ Params: { id: string; userId: string }; Body: { role?: string } }>('/:id/members/:userId', {
    schema: { ...changeRoleSchema, ...changeRoleMeta },
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const { id, userId } = request.params;
      const role = request.body?.role;
      if (!role) {
        return reply.status(400).send({ error: 'Bad Request', message: 'role is required' });
      }
      const result = changeMemberRole(fastify.dbCtx.db, user.id, id, userId, role);
      return reply.status(200).send({ member: result });
    } catch (err: unknown) {
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 404 ? 'Not Found' : 'Forbidden',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Failed to change member role' });
    }
  });

  // POST /api/v1/workspaces/:id/invites — create (or refresh) an invitation
  fastify.post<{ Params: { id: string }; Body: { email?: string; role?: string } }>('/:id/invites', {
    schema: { ...createInviteSchema, ...createInviteMeta },
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const workspaceId = request.params.id;
      const { email, role = 'editor' } = request.body || {};
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId, ['owner', 'admin']);

      const result = createInvite(fastify.dbCtx, {
        workspaceId,
        email: email ?? '',
        role,
        invitedByUserId: user.id,
        appUrl: resolveAppUrl(),
      });

      const emailSent = await sendInviteEmail(fastify.dbCtx, { inviteId: result.invite.id, token: result.invite.token, appUrl: resolveAppUrl() });

      return reply.status(201).send({
        invite: { ...result.invite, emailSent },
        inviteUrl: result.inviteUrl,
        emailDelivery: isEmailEnabled() ? (emailSent ? 'sent' : 'failed') : 'disabled',
      });
    } catch (err: unknown) {
      if (err instanceof InviteError) {
        return reply.status(err.statusCode).send({ error: 'Invitation Error', message: err.message });
      }
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 404 ? 'Not Found' : 'Forbidden',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Failed to create invitation' });
    }
  });

  // GET /api/v1/workspaces/:id/invites — list invitations for the workspace
  fastify.get<{ Params: { id: string } }>('/:id/invites', { schema: listInvitesMeta }, async (request, reply) => {
    try {
      const user = request.user!;
      const workspaceId = request.params.id;
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId);
      const invites = listInvites(fastify.dbCtx, workspaceId);
      return reply.status(200).send({ invites });
    } catch (err: unknown) {
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 404 ? 'Not Found' : 'Forbidden',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Failed to list invitations' });
    }
  });

  // DELETE /api/v1/workspaces/:id/invites/:inviteId — revoke a pending invitation
  fastify.delete<{ Params: { id: string; inviteId: string } }>('/:id/invites/:inviteId', { schema: revokeInviteMeta }, async (request, reply) => {
    try {
      const user = request.user!;
      const { id, inviteId } = request.params;
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, id, ['owner', 'admin']);
      const revoked = revokeInvite(fastify.dbCtx, id, inviteId);
      if (!revoked) {
        return reply.status(404).send({ error: 'Not Found', message: 'Pending invitation not found' });
      }
      return reply.status(200).send({ success: true });
    } catch (err: unknown) {
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 404 ? 'Not Found' : 'Forbidden',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Failed to revoke invitation' });
    }
  });
};
