import type { FastifyPluginAsync } from 'fastify';
import {
  getUserWorkspaces,
  createWorkspace,
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
};
