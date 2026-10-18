import type { FastifyPluginAsync } from 'fastify';
import {
  lookupInvite,
  acceptInvite,
  InviteError,
} from '../services/invite.service.js';
import {
  SESSION_SECURITY,
  PUBLIC_SECURITY,
  jsonResponse,
  errorResponses,
  idParam,
  openapiParams,
} from '../openapi.js';

/**
 * Invitation routes.
 *  - GET  /api/v1/invites/:token  (public) — invite context for the auth/register screen
 *  - POST /api/v1/invites/:token/accept (auth) — join the workspace with the invited role
 */
// ---------------------------------------------------------------------------
// OpenAPI metadata (spec-only; see src/openapi.ts)
// ---------------------------------------------------------------------------

const tokenParams = openapiParams(
  { token: { type: 'string', minLength: 16, maxLength: 128, description: 'Raw invite token from the invitation link (`#invite=<token>`).' } },
  ['token'],
);

const lookupMeta = {
  tags: ['Invites'],
  summary: 'Look up an invitation (public)',
  description: 'Context for the sign-in/register screen when following an invite link: workspace name, invited email, role and whether the invite is still usable. Exposes no secrets; unknown or revoked tokens yield 404.',
  security: PUBLIC_SECURITY,
  openapi: {
    ...tokenParams,
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['invite'],
          properties: {
            invite: {
              type: 'object',
              required: ['workspaceName', 'email', 'role', 'status', 'expired', 'usable'],
              properties: {
                workspaceName: { type: 'string' },
                email: { type: 'string', format: 'email' },
                role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
                status: { type: 'string', enum: ['pending', 'accepted', 'revoked', 'expired'] },
                expired: { type: 'boolean' },
                usable: { type: 'boolean', description: 'True while pending and not expired.' },
              },
            },
          },
        },
        'Invitation context for the auth screen.',
      ),
      ...errorResponses([404, 429]),
    },
  },
};

const acceptMeta = {
  tags: ['Invites'],
  summary: 'Accept an invitation',
  description: 'Joins the signed-in user to the workspace with the invited role. The invite must be pending, unexpired, and addressed to this account\'s email address.',
  security: SESSION_SECURITY,
  openapi: {
    ...tokenParams,
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['success', 'workspace'],
          properties: {
            success: { type: 'boolean' },
            workspace: {
              type: 'object',
              required: ['id', 'name', 'role'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
              },
            },
          },
        },
        'Joined the workspace.',
      ),
      ...errorResponses([401, 404, 409, 429, 500]),
    },
  },
};

export const inviteRoutes: FastifyPluginAsync = async (fastify) => {
  // Public lookup: only exposes the workspace name + invited email/role, no secrets.
  fastify.get<{ Params: { token: string } }>('/:token', {
    schema: {
      params: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 16, maxLength: 128 } }, additionalProperties: false },
      ...lookupMeta,
    },
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
    schema: {
      params: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 16, maxLength: 128 } }, additionalProperties: false },
      ...acceptMeta,
    },
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
