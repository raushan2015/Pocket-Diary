import type { FastifyPluginAsync } from 'fastify';
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '../services/notification.service.js';
import {
  SESSION_SECURITY,
  jsonResponse,
  errorResponses,
  ref,
  refArray,
} from '../openapi.js';

interface NotificationQuery {
  limit?: number;
  includeRead?: string;
}

// ---------------------------------------------------------------------------
// OpenAPI metadata (spec-only; see src/openapi.ts)
// ---------------------------------------------------------------------------

const listMeta = {
  tags: ['Notifications'],
  summary: 'List your notifications',
  description: 'Reminder notifications for the signed-in user only (audit H-2), unread first, newest first within each group. `limit` defaults to 25 (max 100); `includeRead=false` returns only unread ones.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['notifications', 'unread'],
          properties: {
            notifications: refArray('Notification'),
            unread: { type: 'integer', description: 'Total unread count (ignores the limit).' },
          },
        },
        'Notifications for the current user.',
      ),
      ...errorResponses([400, 401, 429]),
    },
  },
};

const markReadMeta = {
  tags: ['Notifications'],
  summary: 'Mark one notification read',
  description: 'Marks the notification as read for the signed-in user.',
  security: SESSION_SECURITY,
  openapi: {
    params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64, description: 'Notification id.' } }, additionalProperties: false },
    responses: {
      200: jsonResponse(ref('SimpleSuccess'), 'Marked read.'),
      ...errorResponses([401, 404, 429]),
    },
  },
};

const markAllMeta = {
  tags: ['Notifications'],
  summary: 'Mark all notifications read',
  description: 'Marks every notification of the signed-in user as read.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['success', 'updated'],
          properties: {
            success: { type: 'boolean' },
            updated: { type: 'integer', description: 'Number of notifications marked read.' },
          },
        },
        'All marked read.',
      ),
      ...errorResponses([401, 429]),
    },
  },
};

export const notificationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/v1/notifications — list reminders for the signed-in user
  fastify.get<{ Querystring: NotificationQuery }>('/', {
    schema: {
      ...listMeta,
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          includeRead: { type: 'string', enum: ['true', 'false'] },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const user = request.user!;
    const result = listNotifications(fastify.dbCtx, user.id, {
      limit: request.query.limit ? Number(request.query.limit) : undefined,
      includeRead: request.query.includeRead !== 'false',
    });
    return reply.status(200).send(result);
  });

  // POST /api/v1/notifications/:id/read
  fastify.post<{ Params: { id: string } }>('/:id/read', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } }, additionalProperties: false },
      ...markReadMeta,
    },
  }, async (request, reply) => {
    const user = request.user!;
    const ok = markNotificationRead(fastify.dbCtx, user.id, request.params.id);
    if (!ok) {
      return reply.status(404).send({ error: 'Not Found', message: 'Notification not found' });
    }
    return reply.status(200).send({ success: true });
  });

  // POST /api/v1/notifications/read-all
  fastify.post('/read-all', { schema: markAllMeta }, async (request, reply) => {
    const user = request.user!;
    const updated = markAllNotificationsRead(fastify.dbCtx, user.id);
    return reply.status(200).send({ success: true, updated });
  });
};
