import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { pushSubscriptions } from '../db/schema.js';
import { getPushPublicKey } from '../services/push.service.js';
import { assertPublicHttpUrl, UrlGuardError, UrlResolutionError } from '../services/url-guard.js';
import {
  SESSION_SECURITY,
  jsonResponse,
  errorResponses,
  ref,
} from '../openapi.js';

// ---------------------------------------------------------------------------
// OpenAPI metadata (spec-only; see src/openapi.ts)
// ---------------------------------------------------------------------------

const publicKeyMeta = {
  tags: ['Push'],
  summary: 'VAPID public key',
  description: 'The VAPID public key for subscribing this browser to Web Push, or `enabled: false` when push is not configured on the instance.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['enabled', 'publicKey'],
          properties: {
            enabled: { type: 'boolean' },
            publicKey: { type: 'string', nullable: true, description: 'Base64 VAPID public key, or null when push is disabled.' },
          },
        },
        'Push configuration status.',
      ),
      ...errorResponses([401, 429]),
    },
  },
};

const subscribeMeta = {
  tags: ['Push'],
  summary: 'Subscribe this browser',
  description: 'Registers (or re-registers) the browser\'s Web Push subscription for the signed-in user. The endpoint must be an https URL resolving to a public address (audit M-10); the stored keys are the standard PushSubscription keys.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['success', 'updated'],
          properties: {
            success: { type: 'boolean' },
            updated: { type: 'boolean', description: 'True when an existing subscription was re-bound to this account.' },
          },
        },
        'Existing subscription updated.',
      ),
      201: jsonResponse(
        {
          type: 'object',
          required: ['success', 'updated'],
          properties: {
            success: { type: 'boolean' },
            updated: { type: 'boolean', description: 'False for a new subscription.' },
          },
        },
        'Subscription created.',
      ),
      ...errorResponses([400, 401, 429, 500]),
    },
  },
};

const unsubscribeMeta = {
  tags: ['Push'],
  summary: 'Unsubscribe',
  description: 'Removes the browser\'s subscription (used on `pushsubscriptionchange` and sign-out).',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(ref('SimpleSuccess'), 'Subscription removed (or already absent).'),
      ...errorResponses([400, 401, 429]),
    },
  },
};

export const pushRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/v1/push/public-key — VAPID public key (or enabled:false when push is unconfigured)
  fastify.get('/public-key', { schema: publicKeyMeta }, async (_request, reply) => {
    const publicKey = getPushPublicKey();
    return reply.status(200).send({ enabled: Boolean(publicKey), publicKey: publicKey ?? null });
  });

  // POST /api/v1/push/subscribe — register this browser for push notifications
  fastify.post<{ Body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } }>('/subscribe', {
    schema: {
      ...subscribeMeta,
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

    // Audit M-10 (SSRF): the stored endpoint is fetched by the server later,
    // so it must be an https URL resolving to a public address. Previously
    // any string was accepted — the reminder job would happily POST to
    // http://localhost or a cloud-metadata address.
    if (!/^https:\/\//i.test(endpoint)) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Push endpoint must be an https URL (standard Web Push endpoints are https)',
      });
    }
    try {
      await assertPublicHttpUrl(endpoint);
    } catch (err) {
      if (err instanceof UrlGuardError) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Push endpoint must resolve to a public address',
        });
      }
      if (err instanceof UrlResolutionError) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Push endpoint hostname could not be resolved',
        });
      }
      throw err;
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
      ...unsubscribeMeta,
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
