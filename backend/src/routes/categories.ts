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
import {
  SESSION_SECURITY,
  jsonResponse,
  errorResponses,
  ref,
  refArray,
  idParam,
  openapiParams,
} from '../openapi.js';

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

const categoryQuerySchema = {
  querystring: {
    type: 'object',
    required: ['workspaceId'],
    properties: { workspaceId: { type: 'string', minLength: 1, maxLength: 64 } },
    additionalProperties: false,
  },
};

const createCategorySchema = {
  body: {
    type: 'object',
    required: ['workspaceId', 'name'],
    properties: {
      workspaceId: { type: 'string', minLength: 1, maxLength: 64 },
      name: { type: 'string', minLength: 1, maxLength: 80 },
      color: { type: ['string', 'null'], maxLength: 32 },
      icon: { type: ['string', 'null'], maxLength: 32 },
    },
    additionalProperties: false,
  },
};

const updateCategorySchema = {
  body: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', maxLength: 64 },
      name: { type: 'string', minLength: 1, maxLength: 80 },
      color: { type: ['string', 'null'], maxLength: 32 },
      icon: { type: ['string', 'null'], maxLength: 32 },
    },
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// OpenAPI metadata (spec-only; see src/openapi.ts)
// ---------------------------------------------------------------------------

const categoryIdParams = openapiParams({ id: idParam('id', 'Category id.') }, ['id']);
const catErrors = errorResponses([401, 403, 404, 500]);

const listMeta = {
  tags: ['Categories'],
  summary: 'List categories',
  description: 'All note categories in the workspace. Any member may read them.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        { type: 'object', required: ['categories'], properties: { categories: refArray('Category') } },
        'Categories in the workspace.',
      ),
      ...errorResponses([400, 401, 403, 500]),
    },
  },
};

const createMeta = {
  tags: ['Categories'],
  summary: 'Create a category',
  description: 'Creates a category (label with optional color and icon). Restricted to owner/admin/editor.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      201: jsonResponse(
        { type: 'object', required: ['category'], properties: { category: ref('Category') } },
        'Category created.',
      ),
      ...errorResponses([400, 401, 403, 500]),
    },
  },
};

const updateMeta = {
  tags: ['Categories'],
  summary: 'Update a category',
  description: 'Partial update. When `workspaceId` is omitted, the category\'s own workspace is used. Restricted to owner/admin/editor.',
  security: SESSION_SECURITY,
  openapi: {
    ...categoryIdParams,
    responses: {
      200: jsonResponse(
        { type: 'object', required: ['category'], properties: { category: ref('Category') } },
        'Updated category.',
      ),
      ...catErrors,
    },
  },
};

const deleteMeta = {
  tags: ['Categories'],
  summary: 'Delete a category',
  description: 'Deletes the category. When `workspaceId` is omitted, the category\'s own workspace is used. Restricted to owner/admin/editor.',
  security: SESSION_SECURITY,
  openapi: {
    ...categoryIdParams,
    querystring: {
      type: 'object',
      properties: { workspaceId: { type: 'string', minLength: 1, maxLength: 64, description: 'Workspace id; defaults to the category\'s own workspace.' } },
      additionalProperties: false,
    },
    responses: {
      200: jsonResponse(ref('SimpleSuccess'), 'Category deleted.'),
      ...catErrors,
    },
  },
};

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
  fastify.get<{ Querystring: CategoryQuery }>('/', {
    schema: { ...categoryQuerySchema, ...listMeta },
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
  fastify.post<{ Body: CreateCategoryBody }>('/', {
    schema: { ...createCategorySchema, ...createMeta },
  }, async (request, reply) => {
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
  fastify.patch<{ Params: CategoryParams; Body: UpdateCategoryBody }>('/:id', {
    schema: { ...updateCategorySchema, ...updateMeta },
  }, async (request, reply) => {
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
  fastify.delete<{ Params: CategoryParams; Querystring: CategoryQuery }>('/:id', { schema: deleteMeta }, async (request, reply) => {
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
