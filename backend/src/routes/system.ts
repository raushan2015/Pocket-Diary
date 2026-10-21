import type { FastifyPluginAsync } from 'fastify';
import { getBackupStatus } from '../services/backup.service.js';
import {
  SESSION_SECURITY,
  PUBLIC_SECURITY,
  jsonResponse,
  errorResponses,
  ref,
  API_VERSION,
} from '../openapi.js';

/**
 * Public system routes — no session required.
 *
 * Mobile companion apps (see mobile-apps/) must be able to validate a
 * self-hosted server BEFORE any credentials exist, and know which optional
 * API features they may use. This plugin is deliberately separate from the
 * authenticated `systemRoutes` below: Fastify applies a plugin's hooks to
 * every route in its scope regardless of registration order, so a public
 * route cannot live next to the authenticate hook. It exposes no operational
 * data — only the product name, version and capability flags.
 */
export const systemInfoRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/info', {
    schema: {
      tags: ['System'],
      summary: 'Server identity and capabilities (public)',
      description: 'Product name, API version and capability flags, used by first-launch mobile clients to validate a self-hosted server before signing in. Older instances without this endpoint can still be detected through `GET /health`, with reduced capabilities. Exposes no operational data.',
      security: PUBLIC_SECURITY,
      openapi: {
        responses: {
          200: jsonResponse(
            {
              type: 'object',
              required: ['name', 'version', 'apiPrefix', 'capabilities'],
              properties: {
                name: { type: 'string', enum: ['pocket-diary'], description: 'Product identifier. Any other value means the URL is not a Pocket Diary API.' },
                version: { type: 'string', description: 'Backend package version.' },
                apiPrefix: { type: 'string', description: 'Prefix every API route lives under.' },
                capabilities: {
                  type: 'object',
                  required: ['memoClientId'],
                  description: 'Optional API features clients may depend on.',
                  properties: {
                    memoClientId: {
                      type: 'boolean',
                      description: 'POST /memos accepts an optional `clientId` (8-64 chars) for idempotent offline-create replay: a duplicate submission returns the original memo instead of creating a second one.',
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
            'Server identity and capabilities.',
          ),
          ...errorResponses([429]),
        },
      },
    },
  }, async () => {
    return {
      name: 'pocket-diary',
      version: API_VERSION,
      apiPrefix: '/api/v1',
      capabilities: {
        memoClientId: true,
      },
    };
  });
};

/**
 * System operations routes (self-hosted administration) — session required.
 *
 * Security (SEC-03): backup telemetry exposes server filesystem paths and
 * operational cadence, so it is restricted to instance administrators
 * (the first registered account on this instance).
 */
export const systemRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  const requireInstanceAdmin = (request: { user?: { isInstanceAdmin?: boolean } }, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) => {
    if (!request.user?.isInstanceAdmin) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Instance administrator access required',
      });
    }
    return null;
  };

  // GET /api/v1/system/backup-status — local + off-host replication snapshot status
  fastify.get('/backup-status', {
    schema: {
      tags: ['System'],
      summary: 'Backup snapshot status (instance admin)',
      description: 'Local and off-host backup snapshot counts and recency. **Instance administrator only** — the first registered account on the instance (403 otherwise); the response includes server-side directory paths.',
      security: SESSION_SECURITY,
      openapi: {
        responses: {
          200: jsonResponse(ref('BackupStatus'), 'Backup status.'),
          ...errorResponses([401, 403, 429, 500]),
        },
      },
    },
  }, async (request, reply) => {
    const denied = requireInstanceAdmin(request, reply);
    if (denied) return denied;
    const status = await getBackupStatus();
    return reply.status(200).send(status);
  });
};
