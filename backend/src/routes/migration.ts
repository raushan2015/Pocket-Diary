import type { FastifyPluginAsync } from 'fastify';
import {
  importLocalData,
  exportWorkspaceData,
  type ImportLocalPayload,
} from '../services/migration.service.js';
import {
  verifyWorkspaceMembership,
  WorkspaceAccessError,
} from '../services/workspace.service.js';

interface ExportQuery {
  workspaceId?: string;
}

export const migrationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // POST /api/v1/migration/import-local
  fastify.post<{ Body: ImportLocalPayload }>('/import-local', async (request, reply) => {
    try {
      const user = request.user!;
      const body = request.body || ({} as ImportLocalPayload);

      if (!body.workspaceId) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'workspaceId is required',
        });
      }

      // Verify workspace membership and write permissions
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, body.workspaceId, ['owner', 'admin', 'editor']);

      const result = importLocalData(fastify.dbCtx, user.id, body);
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
        message: err instanceof Error ? err.message : 'Migration import failed',
      });
    }
  });

  // GET /api/v1/migration/export
  fastify.get<{ Querystring: ExportQuery }>('/export', async (request, reply) => {
    try {
      const user = request.user!;
      const { workspaceId } = request.query;

      if (!workspaceId) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'workspaceId query parameter is required',
        });
      }

      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId);

      const result = exportWorkspaceData(fastify.dbCtx, workspaceId);
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
        message: 'Migration export failed',
      });
    }
  });
};
