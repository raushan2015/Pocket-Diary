import type { FastifyPluginAsync } from 'fastify';
import {
  listTags,
  createTag,
  deleteTag,
  renameTag,
  TagNotFoundError,
} from '../services/tag.service.js';
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

interface TagQuery {
  workspaceId?: string;
}

interface TagParams {
  id: string;
}

interface CreateTagBody {
  workspaceId?: string;
  name?: string;
}

interface UpdateTagBody { name?: string; workspaceId?: string; }

const tagQuerySchema = {
  querystring: {
    type: 'object',
    required: ['workspaceId'],
    properties: { workspaceId: { type: 'string', minLength: 1, maxLength: 64 } },
    additionalProperties: false,
  },
};

const createTagSchema = {
  body: {
    type: 'object',
    required: ['workspaceId', 'name'],
    properties: {
      workspaceId: { type: 'string', minLength: 1, maxLength: 64 },
      name: { type: 'string', minLength: 1, maxLength: 80 },
    },
    additionalProperties: false,
  },
};

const updateTagSchema = {
  body: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', maxLength: 64 },
      name: { type: 'string', minLength: 1, maxLength: 80 },
    },
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// OpenAPI metadata (spec-only; see src/openapi.ts)
// ---------------------------------------------------------------------------

const tagIdParams = openapiParams({ id: idParam('id', 'Tag id.') }, ['id']);
const tagErrors = errorResponses([400, 401, 403, 404, 500]);

const listMeta = {
  tags: ['Tags'],
  summary: 'List tags',
  description: 'All tags in the workspace registry. Any member may read them.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        { type: 'object', required: ['tags'], properties: { tags: refArray('Tag') } },
        'Tags in the workspace.',
      ),
      ...errorResponses([400, 401, 403, 500]),
    },
  },
};

const createMeta = {
  tags: ['Tags'],
  summary: 'Create a tag',
  description: 'Creates a tag in the workspace registry (names unique per workspace, case-insensitive — audit M-3). Restricted to owner/admin/editor.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      201: jsonResponse(
        { type: 'object', required: ['tag'], properties: { tag: ref('Tag') } },
        'Tag created.',
      ),
      ...errorResponses([400, 401, 403, 500]),
    },
  },
};

const renameMeta = {
  tags: ['Tags'],
  summary: 'Rename a tag',
  description: 'Renames the tag. When `workspaceId` is omitted, the tag\'s own workspace is used. Restricted to owner/admin/editor.',
  security: SESSION_SECURITY,
  openapi: {
    ...tagIdParams,
    responses: {
      200: jsonResponse(
        { type: 'object', required: ['tag'], properties: { tag: ref('Tag') } },
        'Renamed tag.',
      ),
      ...tagErrors,
    },
  },
};

const deleteMeta = {
  tags: ['Tags'],
  summary: 'Delete a tag',
  description: 'Deletes the tag and its note associations. When `workspaceId` is omitted, the tag\'s own workspace is used. Restricted to owner/admin/editor.',
  security: SESSION_SECURITY,
  openapi: {
    ...tagIdParams,
    querystring: {
      type: 'object',
      properties: { workspaceId: { type: 'string', minLength: 1, maxLength: 64, description: 'Workspace id; defaults to the tag\'s own workspace.' } },
      additionalProperties: false,
    },
    responses: {
      200: jsonResponse(ref('SimpleSuccess'), 'Tag deleted.'),
      ...tagErrors,
    },
  },
};

export const tagRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  const getTagWorkspaceId = (tagId: string): string => {
    const raw = fastify.dbCtx.sqlite
      .prepare('SELECT workspace_id FROM tags WHERE id = ?')
      .get(tagId) as any;
    if (!raw) {
      throw new TagNotFoundError('Tag not found');
    }
    return raw.workspace_id;
  };

  // GET /api/v1/tags
  fastify.get<{ Querystring: TagQuery }>('/', {
    schema: { ...tagQuerySchema, ...listMeta },
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

      const tags = listTags(fastify.dbCtx, workspaceId);
      return reply.status(200).send({ tags });
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
        message: 'Failed to retrieve tags',
      });
    }
  });

  // POST /api/v1/tags
  fastify.post<{ Body: CreateTagBody }>('/', {
    schema: { ...createTagSchema, ...createMeta },
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

      const tag = createTag(fastify.dbCtx, body.workspaceId, body.name);
      return reply.status(201).send({ tag });
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
        message: 'Failed to create tag',
      });
    }
  });

  // PATCH /api/v1/tags/:id
  fastify.patch<{ Params: TagParams; Body: UpdateTagBody }>('/:id', {
    schema: { ...updateTagSchema, ...renameMeta },
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const workspaceId = request.body?.workspaceId || getTagWorkspaceId(request.params.id);
      if (!request.body?.name?.trim()) return reply.status(400).send({ error: 'Bad Request', message: 'Tag name is required' });
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId, ['owner', 'admin', 'editor']);
      const tag = renameTag(fastify.dbCtx, request.params.id, workspaceId, request.body.name);
      return reply.status(200).send({ tag });
    } catch (err: unknown) {
      if (err instanceof TagNotFoundError) return reply.status(404).send({ error: 'Not Found', message: err.message });
      if (err instanceof WorkspaceAccessError) return reply.status(err.statusCode).send({ error: err.statusCode === 403 ? 'Forbidden' : 'Bad Request', message: err.message });
      if (err instanceof Error && /already exists|required/i.test(err.message)) return reply.status(400).send({ error: 'Bad Request', message: err.message });
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Failed to rename tag' });
    }
  });

  // DELETE /api/v1/tags/:id
  fastify.delete<{ Params: TagParams; Querystring: TagQuery }>('/:id', { schema: deleteMeta }, async (request, reply) => {
    try {
      const user = request.user!;
      const { id } = request.params;

      const workspaceId = request.query.workspaceId || getTagWorkspaceId(id);
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId, ['owner', 'admin', 'editor']);

      deleteTag(fastify.dbCtx, id, workspaceId);
      return reply.status(200).send({ success: true });
    } catch (err: unknown) {
      if (err instanceof TagNotFoundError) {
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
        message: 'Failed to delete tag',
      });
    }
  });
};
