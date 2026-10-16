import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { pushSubscriptions } from '../db/schema.js';
import { getPushPublicKey } from '../services/push.service.js';

export const pushRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/v1/push/public-key — VAPID public key (or enabled:false when push is unconfigured)
  fastify.get('/public-key', async (_request, reply) => {
    const publicKey = getPushPublicKey();
    return reply.status(200).send({ enabled: Boolean(publicKey), publicKey: publicKey ?? null });
  });

  // POST /api/v1/push/subscribe — register this browser for push notifications
  fastify.post<{ Body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } }>('/subscribe', {
    schema: {
      body: {
        type: 'object',
        required: ['endpoint', 'keys'],
        properties: {
          endpoint: { type: 'string', minLength: 1, maxLength: 2048 },
          keys: {
            type: 'object',
            required: ['p256dh', 'auth'],
            properties: {
              p256dh: { type: 'string', minLength: 1, maxLength: 256 },
              auth: { type: 'string', minLength: 1, maxLength: 256 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const user = request.user!;
    const { endpoint, keys } = request.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return reply.status(400).send({ error: 'Bad Request', message: 'endpoint and keys (p256dh, auth) are required' });
    }

    const existing = fastify.dbCtx.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .get();

    if (existing) {
      fastify.dbCtx.db
        .update(pushSubscriptions)
        .set({ userId: user.id, p256dh: keys.p256dh, auth: keys.auth })
        .where(eq(pushSubscriptions.id, existing.id))
        .run();
      return reply.status(200).send({ success: true, updated: true });
    }

    fastify.dbCtx.db
      .insert(pushSubscriptions)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        createdAt: Date.now(),
      })
      .run();

    return reply.status(201).send({ success: true, updated: false });
  });

  // POST /api/v1/push/unsubscribe — remove a subscription (called on pushsubscriptionchange or logout)
  fastify.post<{ Body: { endpoint?: string } }>('/unsubscribe', {
    schema: {
      body: {
        type: 'object',
        required: ['endpoint'],
        properties: { endpoint: { type: 'string', minLength: 1, maxLength: 2048 } },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const user = request.user!;
    const { endpoint } = request.body || {};
    if (!endpoint) {
      return reply.status(400).send({ error: 'Bad Request', message: 'endpoint is required' });
    }
    fastify.dbCtx.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, user.id)))
      .run();
    return reply.status(200).send({ success: true });
  });
};
