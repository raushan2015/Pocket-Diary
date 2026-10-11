import type { FastifyPluginAsync } from 'fastify';
import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  CategoryNotFoundError,
} from '../services/category.service.js';
import {
  verifyWorkspaceMembership,
  WorkspaceAccessError,
} from '../services/workspace.service.js';

interface CategoryQuery {
  workspaceId?: string;
}

interface CategoryParams {
  id: string;
}

interface CreateCategoryBody {
  workspaceId?: string;
  name?: string;
  color?: string | null;
  icon?: string | null;
}

interface UpdateCategoryBody {
  workspaceId?: string;
  name?: string;
  color?: string | null;
  icon?: string | null;
}

export const categoryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // Helper to resolve category's workspace
  const getCategoryWorkspaceId = (categoryId: string): string => {
    const raw = fastify.dbCtx.sqlite
      .prepare('SELECT workspace_id FROM categories WHERE id = ?')
      .get(categoryId) as any;
    if (!raw) {
      throw new CategoryNotFoundError('Category not found');
    }
    return raw.workspace_id;
  };

  // GET /api/v1/categories
  fastify.get<{ Querystring: CategoryQuery }>('/', async (request, reply) => {
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

      const categories = listCategories(fastify.dbCtx, workspaceId);
      return reply.status(200).send({ categories });
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
        message: 'Failed to retrieve categories',
      });
    }
  });

  // POST /api/v1/categories
  fastify.post<{ Body: CreateCategoryBody }>('/', async (request, reply) => {
    try {
      const user = request.user!;
      const body = request.body || {};

      if (!body.workspaceId || !body.name) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'workspaceId and name are required',
        });
      }

      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, body.workspaceId, ['owner', 'admin', 'editor']);

      const category = createCategory(fastify.dbCtx, body.workspaceId, {
        name: body.name,
        color: body.color,
        icon: body.icon,
      });

      return reply.status(201).send({ category });
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
        message: 'Failed to create category',
      });
    }
  });

  // PATCH /api/v1/categories/:id
  fastify.patch<{ Params: CategoryParams; Body: UpdateCategoryBody }>('/:id', async (request, reply) => {
    try {
      const user = request.user!;
      const { id } = request.params;
      const body = request.body || {};

      const workspaceId = body.workspaceId || getCategoryWorkspaceId(id);
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId, ['owner', 'admin', 'editor']);

      const category = updateCategory(fastify.dbCtx, id, workspaceId, body);
      return reply.status(200).send({ category });
    } catch (err: unknown) {
      if (err instanceof CategoryNotFoundError) {
        return reply.status(404).send({
          error: 'Not Found',
          message: err.message,
        });
      }
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 403 ? 'Forbidden' : 'Bad Request',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to update category',
      });
    }
  });

  // DELETE /api/v1/categories/:id
  fastify.delete<{ Params: CategoryParams; Querystring: CategoryQuery }>('/:id', async (request, reply) => {
    try {
      const user = request.user!;
      const { id } = request.params;

      const workspaceId = request.query.workspaceId || getCategoryWorkspaceId(id);
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId, ['owner', 'admin', 'editor']);

      deleteCategory(fastify.dbCtx, id, workspaceId);
      return reply.status(200).send({ success: true });
    } catch (err: unknown) {
      if (err instanceof CategoryNotFoundError) {
        return reply.status(404).send({
          error: 'Not Found',
          message: err.message,
        });
      }
      if (err instanceof WorkspaceAccessError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 403 ? 'Forbidden' : 'Bad Request',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to delete category',
      });
    }
  });
};
