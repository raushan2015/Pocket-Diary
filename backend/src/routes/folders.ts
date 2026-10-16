import type { FastifyPluginAsync } from 'fastify';
import {
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  FolderNotFoundError,
} from '../services/folder.service.js';
import {
  verifyWorkspaceMembership,
  WorkspaceAccessError,
} from '../services/workspace.service.js';

interface FolderQuery {
  workspaceId?: string;
}

interface FolderParams {
  id: string;
}

interface CreateFolderBody {
  workspaceId?: string;
  name?: string;
  parentId?: string | null;
}

interface UpdateFolderBody {
  workspaceId?: string;
  name?: string;
  parentId?: string | null;
}

const folderQuerySchema = {
  querystring: {
    type: 'object',
    required: ['workspaceId'],
    properties: { workspaceId: { type: 'string', minLength: 1, maxLength: 64 } },
    additionalProperties: false,
  },
};

const createFolderSchema = {
  body: {
    type: 'object',
    required: ['workspaceId', 'name'],
    properties: {
      workspaceId: { type: 'string', minLength: 1, maxLength: 64 },
      name: { type: 'string', minLength: 1, maxLength: 80 },
      parentId: { type: ['string', 'null'], maxLength: 64 },
    },
    additionalProperties: false,
  },
};

const updateFolderSchema = {
  body: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', maxLength: 64 },
      name: { type: 'string', minLength: 1, maxLength: 80 },
      parentId: { type: ['string', 'null'], maxLength: 64 },
    },
    additionalProperties: false,
  },
};

export const folderRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  const getFolderWorkspaceId = (folderId: string): string => {
    const raw = fastify.dbCtx.sqlite
      .prepare('SELECT workspace_id FROM folders WHERE id = ?')
      .get(folderId) as any;
    if (!raw) {
      throw new FolderNotFoundError('Folder not found');
    }
    return raw.workspace_id;
  };

  // GET /api/v1/folders
  fastify.get<{ Querystring: FolderQuery }>('/', {
    schema: folderQuerySchema,
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

      const folders = listFolders(fastify.dbCtx, workspaceId);
      return reply.status(200).send({ folders });
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
        message: 'Failed to retrieve folders',
      });
    }
  });

  // POST /api/v1/folders
  fastify.post<{ Body: CreateFolderBody }>('/', {
    schema: createFolderSchema,
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

      const folder = createFolder(fastify.dbCtx, body.workspaceId, {
        name: body.name,
        parentId: body.parentId,
      });

      return reply.status(201).send({ folder });
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
        message: 'Failed to create folder',
      });
    }
  });

  // PATCH /api/v1/folders/:id
  fastify.patch<{ Params: FolderParams; Body: UpdateFolderBody }>('/:id', {
    schema: updateFolderSchema,
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const { id } = request.params;
      const body = request.body || {};

      const workspaceId = body.workspaceId || getFolderWorkspaceId(id);
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId, ['owner', 'admin', 'editor']);

      const folder = updateFolder(fastify.dbCtx, id, workspaceId, body);
      return reply.status(200).send({ folder });
    } catch (err: unknown) {
      if (err instanceof FolderNotFoundError) {
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
        message: 'Failed to update folder',
      });
    }
  });

  // DELETE /api/v1/folders/:id
  fastify.delete<{ Params: FolderParams; Querystring: FolderQuery }>('/:id', async (request, reply) => {
    try {
      const user = request.user!;
      const { id } = request.params;

      const workspaceId = request.query.workspaceId || getFolderWorkspaceId(id);
      verifyWorkspaceMembership(fastify.dbCtx.db, user.id, workspaceId, ['owner', 'admin', 'editor']);

      deleteFolder(fastify.dbCtx, id, workspaceId);
      return reply.status(200).send({ success: true });
    } catch (err: unknown) {
      if (err instanceof FolderNotFoundError) {
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
        message: 'Failed to delete folder',
      });
    }
  });
};
