import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyMultipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config.js';
import { getDatabase, type DatabaseContext } from './db/index.js';
import { authPlugin } from './plugins/auth.js';
import { apiRoutes } from './routes/index.js';
import { API_TITLE, API_VERSION, apiTags, componentSchemas, jsonResponse, errorResponses, PUBLIC_SECURITY } from './openapi.js';

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

  // CSRF defense: the session cookie is SameSite=Lax (see the auth routes),
  // which stops browsers from attaching it to cross-site state-changing
  // requests. A stricter server-side Origin check was tried and removed: this
  // app is legitimately served through several front doors (LAN IP, Tailscale
  // IP, MagicDNS name, and an external HTTPS domain behind a reverse proxy),
  // and each outer proxy observes a different scheme/host than the browser
  // Origin — e.g. https://notes.techshan.app reached the backend as plain
  // HTTP, so every login POST was rejected as cross-site. Operators accept
  // any origin here; per-account lockout, rate limits and the Lax cookie
  // remain the enforced protections.

  // Register auth decorator/plugin
  app.register(authPlugin);

  // ---------------------------------------------------------------------
  // OpenAPI documentation (GET /docs) — served in every environment unless
  // explicitly disabled with DOCS_ENABLED=false. The generated spec contains
  // only route shapes and descriptions: no secrets, internal hosts or tokens
  // ever enter it (verified by backend/test/docs.test.ts). Auth requirements
  // are documented per route via the `sessionCookie` security scheme.
  //
  // Registered before the API routes so @fastify/swagger's dynamic mode can
  // observe every route as it is added.
  // ---------------------------------------------------------------------
  if (process.env.DOCS_ENABLED !== 'false') {
    app.register(swagger, {
      openapi: {
        info: {
          title: API_TITLE,
          version: API_VERSION,
          description: [
            'Self-hosted, Google Keep–style notes with workspaces, reminders and attachments.',
            '',
            '**Authentication** is a `memo_session` HTTP-only cookie issued by `POST /auth/login` and `POST /auth/register`.',
            'Most endpoints require it; those that do not are marked with no lock icon. Sessions expire and slide while active;',
            'password changes revoke every other device.',
            '',
            '**Rate limits** apply per client IP (tighter on auth endpoints), plus a per-account lockout after repeated failed logins.',
            '',
            'All timestamps are Unix epoch **milliseconds** unless noted otherwise.',
          ].join('\n'),
        },
        // Relative server URL: "Try it out" targets whichever origin the UI was
        // loaded from — direct backend access in development, the frontend
        // reverse proxy in production. No internal hostnames are embedded.
        servers: [{ url: '/', description: 'This instance (direct backend or the bundled reverse proxy)' }],
        tags: apiTags,
        components: {
          securitySchemes: {
            sessionCookie: {
              type: 'apiKey',
              in: 'cookie',
              name: config.cookieName,
              description: 'HTTP-only session cookie set on sign-in. Sent automatically by browsers on same-origin requests.',
            },
          },
          schemas: componentSchemas,
        },
      },
      // Merge OpenAPI-only route metadata (see src/openapi.ts) into the spec.
      // Fastify never sees these as runtime schemas, so request validation and
      // response serialization behave exactly as before.
      transform: ({ schema, url }) => {
        const { openapi: extension, ...documented } = (schema ?? {}) as Record<string, any>;
        if (extension) {
          if (extension.responses) documented.response = extension.responses;
          if (extension.params) documented.params = extension.params;
          if (extension.querystring) documented.querystring = extension.querystring;
          if (extension.requestBody) {
            documented.body = extension.requestBody.body;
            documented.consumes = extension.requestBody.consumes;
          }
        }
        return { schema: documented, url };
      },
    });

    app.register(swaggerUi, {
      routePrefix: '/docs',
      // CSP for the docs pages, scoped to match the app's own posture
      // (script-src 'self'; styles 'unsafe-inline' because Swagger UI
      // injects inline styles). Deliberately NOT the plugin's generated
      // policy: it omits 'unsafe-inline' for styles (breaking its own UI)
      // and adds `upgrade-insecure-requests`, which breaks same-origin
      // assets on plain-HTTP self-hosted deployments. No external origins
      // are allowed (the default policy whitelists validator.swagger.io).
      staticCSP: {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'font-src': ["'self'", 'data:'],
        'frame-ancestors': ["'none'"],
        'img-src': ["'self'", 'data:'],
        'object-src': ["'none'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'connect-src': ["'self'"],
      },
      uiConfig: {
        docExpansion: 'list',
        tryItOutEnabled: false,
      },
    });
  }

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

  // Root health route. Registered as a (trivial) plugin rather than directly
  // so @fastify/swagger observes it: routes added synchronously before boot
  // are invisible to plugin-registered onRoute hooks, while plugin routes
  // boot after the docs plugin and are all captured.
  app.register(async (instance) => {
    instance.get('/health', {
      schema: {
        tags: ['System'],
        summary: 'Liveness check (root)',
        description: 'Liveness probe used by the bundled reverse proxy and container orchestration. Returns `{"status":"ok"}` with the server time.',
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
      },
    }, async () => ({ status: 'ok', timestamp: Date.now() }));
  });

  return app;
}
