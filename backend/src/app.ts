import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyMultipart from '@fastify/multipart';
import { config } from './config.js';
import { getDatabase, type DatabaseContext } from './db/index.js';
import { authPlugin } from './plugins/auth.js';
import { apiRoutes } from './routes/index.js';

export interface AppOptions {
  dbCtx?: DatabaseContext;
  logger?: boolean | object;
  /** Overrides the TRUST_PROXY setting for tests (audit H-1). */
  trustProxy?: boolean | string;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? {
      level: config.isProduction ? 'info' : 'info',
    },
    // Security (audit H-1): trustProxy decides whose X-Forwarded-For header
    // may rewrite `request.ip`. Trusting everyone (the previous setting) let
    // any client spoof its IP with a single header and walk straight past
    // the login/brute-force rate limiter. Default trusts only the loopback
    // reverse proxy this app ships with; set TRUST_PROXY to the proxy's
    // address or subnet when deployed behind another proxy, or 'false' when
    // the backend is exposed directly.
    trustProxy: options.trustProxy ?? config.trustProxy,
    // JSON API body budget. Memo content may embed imported images as data
    // URIs (see /api/v1/memos content limit); 8 MB keeps every valid note well
    // within reach while still bounding request sizes.
    bodyLimit: 8 * 1024 * 1024,
    ajv: {
      customOptions: {
        // Schemas use type unions (e.g. ['string', 'null']) for optional fields.
        allowUnionTypes: true,
      },
    },
  });

  // Provide database context
  const dbCtx = options.dbCtx ?? getDatabase();
  app.decorate('dbCtx', dbCtx);

  // Register parser plugins before routes. Individual attachment routes enforce the upload constraints.
  app.register(fastifyCookie, {
    secret: config.cookieSecret,
  });
  app.register(fastifyMultipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 }, throwFileSizeLimit: true });

  // Apply a global request budget, with stricter limits on credential endpoints.
  app.register(fastifyRateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: '1 minute',
  });

  // In production, only explicitly configured origins may use cross-origin requests.
  const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.register(fastifyCors, {
    origin: config.isProduction ? allowedOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Cookie-authenticated state changes must originate from the same site.
  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return; // Non-browser clients do not send Origin; session auth still applies.

    try {
      const originUrl = new URL(origin);
      const forwardedHost = request.headers['x-forwarded-host'];
      const forwardedProto = request.headers['x-forwarded-proto'];
      const expectedHost = String(forwardedHost || request.headers.host || '').split(',')[0].trim();
      const expectedProto = String(forwardedProto || request.protocol).split(',')[0].trim().replace(/:$/, '');

      if (originUrl.host.toLowerCase() !== expectedHost.toLowerCase()
        || originUrl.protocol.replace(/:$/, '') !== expectedProto) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Cross-site request rejected',
        });
      }
    } catch {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Invalid request origin',
      });
    }
  });

  // Register auth decorator/plugin
  app.register(authPlugin);

  // API responses are dynamic and session-scoped: never let browsers or proxies
  // cache them (a stale GET /notifications must not mask fresh server state).
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/health')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  // Register API routes
  app.register(apiRoutes, { prefix: '/api/v1' });

  // Root health route
  app.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  return app;
}
