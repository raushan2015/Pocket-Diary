import type { FastifyPluginAsync } from 'fastify';
import { getBackupStatus } from '../services/backup.service.js';
import {
  SESSION_SECURITY,
  jsonResponse,
  errorResponses,
  ref,
} from '../openapi.js';

/**
 * System operations routes (self-hosted administration).
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
