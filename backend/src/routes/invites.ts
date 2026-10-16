import type { FastifyPluginAsync } from 'fastify';
import {
  lookupInvite,
  acceptInvite,
  InviteError,
} from '../services/invite.service.js';

/**
 * Invitation routes.
 *  - GET  /api/v1/invites/:token  (public) — invite context for the auth/register screen
 *  - POST /api/v1/invites/:token/accept (auth) — join the workspace with the invited role
 */
export const inviteRoutes: FastifyPluginAsync = async (fastify) => {
  // Public lookup: only exposes the workspace name + invited email/role, no secrets.
  fastify.get<{ Params: { token: string } }>('/:token', {
    schema: { params: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 16, maxLength: 128 } }, additionalProperties: false } },
  }, async (request, reply) => {
    const invite = lookupInvite(fastify.dbCtx, request.params.token);
    if (!invite) {
      return reply.status(404).send({ error: 'Not Found', message: 'Invitation not found' });
    }
    const expired = invite.expiresAt < Date.now();
    const usable = invite.status === 'pending' && !expired;
    return reply.status(200).send({
      invite: {
        workspaceName: invite.workspaceName,
        email: invite.email,
        role: invite.role,
        status: invite.status,
        expired,
        usable,
      },
    });
  });

  // Accept an invitation as the signed-in user
  fastify.post<{ Params: { token: string } }>('/:token/accept', {
    preHandler: fastify.authenticate,
    schema: { params: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 16, maxLength: 128 } }, additionalProperties: false } },
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const invite = acceptInvite(fastify.dbCtx, request.params.token, user.id);
      return reply.status(200).send({
        success: true,
        workspace: { id: invite.workspaceId, name: invite.workspaceName, role: invite.role },
      });
    } catch (err: unknown) {
      if (err instanceof InviteError) {
        return reply.status(err.statusCode).send({ error: 'Invitation Error', message: err.message });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Failed to accept invitation' });
    }
  });
};
