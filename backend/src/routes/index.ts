import type { FastifyPluginAsync } from 'fastify';
import { authRoutes } from './auth.js';
import { workspaceRoutes } from './workspaces.js';
import { memoRoutes } from './memos.js';
import { categoryRoutes } from './categories.js';
import { tagRoutes } from './tags.js';
import { folderRoutes } from './folders.js';
import { migrationRoutes } from './migration.js';
import { attachmentRoutes } from './attachments.js';
import { notificationRoutes } from './notifications.js';
import { pushRoutes } from './push.js';
import { inviteRoutes } from './invites.js';
import { systemRoutes } from './system.js';
import { jsonResponse, errorResponses, PUBLIC_SECURITY } from '../openapi.js';

const healthMeta = (direct: boolean) => ({
  tags: ['System'],
  summary: direct ? 'Liveness check (root)' : 'Liveness check',
  description: direct
    ? 'Liveness probe used by the bundled reverse proxy and container orchestration. Returns `{"status":"ok"}` with the server time.'
    : 'Liveness probe under the API prefix. Returns `{"status":"ok"}` with the server time.',
  security: PUBLIC_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['status', 'timestamp'],
          properties: {
            status: { type: 'string', enum: ['ok'] },
            timestamp: { type: 'integer', description: 'Unix epoch milliseconds.' },
          },
        },
        'Service is up.',
      ),
      ...errorResponses([429]),
    },
  },
});

export const apiRoutes: FastifyPluginAsync = async (fastify) => {
  // Health check route
  fastify.get('/health', { schema: healthMeta(false) }, async () => {
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

  // Server-side reminder notifications + Web Push
  await fastify.register(notificationRoutes, { prefix: '/notifications' });

  // Web Push subscriptions
  await fastify.register(pushRoutes, { prefix: '/push' });

  // Workspace invitations (public lookup + authenticated accept)
  await fastify.register(inviteRoutes, { prefix: '/invites' });

  // Self-hosted system status (backup snapshots)
  await fastify.register(systemRoutes, { prefix: '/system' });
};
