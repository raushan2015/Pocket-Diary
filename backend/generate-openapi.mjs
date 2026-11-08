// Set required env vars BEFORE any imports
process.env.NODE_ENV = 'development';
process.env.COOKIE_SECRET = 'development-only-cookie-secret-not-for-production-use-32-chars-minimum';
process.env.APP_URL = 'http://localhost:8080';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import fastify from 'fastify';
import FastifySwagger from '@fastify/swagger';
import FastifySwaggerUI from '@fastify/swagger-ui';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyCors from '@fastify/cors';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, 'src');

async function generate() {
  // Load backend modules
  const { apiRoutes } = await import(resolve(SRC_ROOT, 'routes/index.ts'));
  const { componentSchemas, apiTags, SESSION_SECURITY, PUBLIC_SECURITY, API_TITLE, API_VERSION, jsonResponse, errorResponses } = await import(resolve(SRC_ROOT, 'openapi.ts'));
  const { default: config } = await import(resolve(SRC_ROOT, 'config.ts'));
  const { authPlugin } = await import(resolve(SRC_ROOT, 'plugins/auth.ts'));
  const { getDatabase } = await import(resolve(SRC_ROOT, 'db/index.ts'));

  const app = fastify({ logger: false });

  // Trust proxy
  app.addHook('onRequest', (request, reply, done) => {
    request.ip = request.headers['x-forwarded-for']  || request.ip;
    done();
  });

  // Provide database context
  const dbCtx = getDatabase();
  app.decorate('dbCtx', dbCtx);

  // Register parser plugins
  app.register(fastifyCookie, { secret: config.cookieSecret });
  app.register(fastifyMultipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 }, throwFileSizeLimit: true });

  // Rate limiting
  app.register(fastifyRateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  // CORS
  app.register(fastifyCors, { origin: true, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });

  // Register auth plugin
  app.register(authPlugin);

  // ---------------------------------------------------------------------
  // OpenAPI documentation
  // ---------------------------------------------------------------------
  app.register(FastifySwagger, {
    openapi: {
      info: {
        title: API_TITLE,
        version: API_VERSION,
        description: 'Pocket Diary SaaS API - Self-hosted notes application with workspaces, reminders, and offline sync.',
        contact: { name: 'TECHSHAN AI Office', url: 'https://github.com/raushan2015/Pocket-Diary' },
        license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
      },
      servers: [{ url: 'http://localhost:8080', description: 'Local development server' }],
      components: {
        securitySchemes: {
          sessionCookie: {
            type: 'apiKey',
            in: 'cookie',
            name: 'memo_session',
            description: 'Session cookie for authenticated requests. Set via POST /api/v1/auth/login.',
          },
        },
        schemas: componentSchemas,
      },
      security: SESSION_SECURITY,
      tags: apiTags,
    },
    transform: (schema) => {
      if (schema.openapi) {
        return { ...schema, ...schema.openapi };
      }
      return schema;
    },
  });

  app.register(FastifySwaggerUI, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // API responses - no store
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/health')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  // Register API routes
  app.register(apiRoutes, { prefix: '/api/v1' });

  // Root health route
  app.register(async (instance) => {
    instance.get('/health', {
      schema: {
        tags: ['System'],
        summary: 'Liveness check (root)',
        description: 'Liveness probe used by the bundled reverse proxy and container orchestration.',
        security: PUBLIC_SECURITY,
        openapi: {
          responses: {
            200: jsonResponse(
              {
                type: 'object',
                required: ['status', 'timestamp'],
                properties: { status: { type: 'string', enum: ['ok'] }, timestamp: { type: 'integer' } },
              },
              'Service is up.',
            ),
            ...errorResponses([429]),
          },
        },
      },
    }, async () => ({ status: 'ok', timestamp: Date.now() }));
  });

  await app.ready();

  // Extract the generated spec
  const spec = app.swagger();

  // Write JSON
  const jsonPath = resolve(__dirname, 'openapi.json');
  writeFileSync(jsonPath, JSON.stringify(spec, null, 2));
  console.log(`✅ OpenAPI JSON written to ${jsonPath}`);

  // Write YAML
  try {
    const { dump } = await import('js-yaml');
    const yamlPath = resolve(__dirname, 'openapi.yaml');
    writeFileSync(yamlPath, dump(spec, { lineWidth: 120, noRefs: false }));
    console.log(`✅ OpenAPI YAML written to ${yamlPath}`);
  } catch {
    console.log('⚠️  js-yaml not installed, skipping YAML output');
  }

  await app.close();
}

generate().catch((err) => {
  console.error('❌ Generation failed:', err);
  process.exit(1);
});
