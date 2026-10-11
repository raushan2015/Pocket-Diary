import type { FastifyPluginAsync } from 'fastify';
import { authRoutes } from './auth.js';
import { workspaceRoutes } from './workspaces.js';
import { memoRoutes } from './memos.js';
import { categoryRoutes } from './categories.js';
import { tagRoutes } from './tags.js';
import { folderRoutes } from './folders.js';
import { migrationRoutes } from './migration.js';
import { attachmentRoutes } from './attachments.js';

export const apiRoutes: FastifyPluginAsync = async (fastify) => {
  // Health check route
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // Auth routes
  await fastify.register(authRoutes, { prefix: '/auth' });

  // Workspace routes
  await fastify.register(workspaceRoutes, { prefix: '/workspaces' });

  // Memo routes
  await fastify.register(memoRoutes, { prefix: '/memos' });

  // Category routes
  await fastify.register(categoryRoutes, { prefix: '/categories' });

  // Tag routes
  await fastify.register(tagRoutes, { prefix: '/tags' });

  // Folder routes
  await fastify.register(folderRoutes, { prefix: '/folders' });

  // Migration routes
  await fastify.register(migrationRoutes, { prefix: '/migration' });

  // Server-backed note attachments
  await fastify.register(attachmentRoutes, { prefix: '/attachments' });
};
