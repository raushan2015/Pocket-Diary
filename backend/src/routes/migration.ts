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
import {
  SESSION_SECURITY,
  jsonResponse,
  errorResponses,
  ref,
} from '../openapi.js';

interface ExportQuery {
  workspaceId?: string;
}

const importLocalSchema = {
  body: {
    type: 'object',
    required: ['workspaceId', 'memos'],
    properties: {
      workspaceId: { type: 'string', minLength: 1, maxLength: 64 },
      // Legacy import payloads are intentionally flexible; items validated by the service.
      memos: { type: 'array', maxItems: 10000, items: { type: 'object' } },
      categories: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: true } },
      tags: { type: 'array', maxItems: 1000, items: { type: ['string', 'object'] } },
    },
    additionalProperties: false,
  },
};

export const migrationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // POST /api/v1/migration/import-local
  fastify.post<{ Body: ImportLocalPayload }>('/import-local', {
    schema: {
      ...importLocalSchema,
      tags: ['Migration'],
      summary: 'Bulk-import notes (legacy or Google Keep)',
      description: 'Imports memos, categories and tags into the workspace in one transaction. Used by the browser for legacy localStorage data and for parsed Google Keep Takeout exports (colors, pinned and archived state are honored; trashed notes are skipped — audit M-17). Restricted to owner/admin/editor.',
      security: SESSION_SECURITY,
      openapi: {
        responses: {
          200: jsonResponse(ref('ImportResult'), 'Import counts.'),
          ...errorResponses([400, 401, 403, 500]),
        },
      },
    },
  }, async (request, reply) => {
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
  fastify.get<{ Querystring: ExportQuery }>('/export', {
    schema: {
      tags: ['Migration'],
      summary: 'Export the workspace',
      description: 'Full export of the workspace\'s memos (raw rows), categories, tags and folders. Any member may export; the payload is compatible with POST /migration/import-local.',
      security: SESSION_SECURITY,
      openapi: {
        querystring: {
          type: 'object',
          required: ['workspaceId'],
          properties: { workspaceId: { type: 'string', minLength: 1, maxLength: 64, description: 'Workspace to export.' } },
          additionalProperties: false,
        },
        responses: {
          200: jsonResponse(ref('ExportedWorkspace'), 'Workspace contents.'),
          ...errorResponses([400, 401, 403, 500]),
        },
      },
    },
  }, async (request, reply) => {
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
