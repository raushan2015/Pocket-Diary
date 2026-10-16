import type { FastifyPluginAsync } from 'fastify';
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '../services/notification.service.js';

interface NotificationQuery {
  limit?: number;
  includeRead?: string;
}

export const notificationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/v1/notifications — list reminders for the signed-in user
  fastify.get<{ Querystring: NotificationQuery }>('/', {
    schema: {
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
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } }, additionalProperties: false } },
  }, async (request, reply) => {
    const user = request.user!;
    const ok = markNotificationRead(fastify.dbCtx, user.id, request.params.id);
    if (!ok) {
      return reply.status(404).send({ error: 'Not Found', message: 'Notification not found' });
    }
    return reply.status(200).send({ success: true });
  });

  // POST /api/v1/notifications/read-all
  fastify.post('/read-all', async (request, reply) => {
    const user = request.user!;
    const updated = markAllNotificationsRead(fastify.dbCtx, user.id);
    return reply.status(200).send({ success: true, updated });
  });
};
