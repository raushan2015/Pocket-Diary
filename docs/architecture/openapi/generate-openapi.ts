#!/usr/bin/env tsx
/**
 * Generate OpenAPI 3.1 specification from Pocket Diary Fastify routes.
 * Run from backend directory: `tsx ../docs/architecture/openapi/generate-openapi.ts`
 * Outputs: openapi.json, openapi.yaml
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { build } from 'fastify';
import FastifySwagger from '@fastify/swagger';
import FastifySwaggerUI from '@fastify/swagger-ui';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(__dirname, '../../../backend');
const SRC_ROOT = resolve(BACKEND_ROOT, 'src');

async function generate() {
  // Load backend modules
  const { apiRoutes } = await import(resolve(SRC_ROOT, 'routes/index.ts'));
  const { default: config } = await import(resolve(SRC_ROOT, 'config.ts'));
  const { componentSchemas, apiTags, SESSION_SECURITY, PUBLIC_SECURITY, API_TITLE, API_VERSION } = await import(resolve(SRC_ROOT, 'openapi.ts'));

  const fastify = build({ logger: false });

  // Register swagger with our component schemas
  await fastify.register(FastifySwagger, {
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
    transform: (schema: any) => {
      // Merge openapi extension from route schemas into the spec
      if (schema.openapi) {
        return { ...schema, ...schema.openapi };
      }
      return schema;
    },
  });

  // Register all API routes
  await fastify.register(apiRoutes, { prefix: '/api/v1' });

  // Register Swagger UI (optional, for verification)
  await fastify.register(FastifySwaggerUI, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  await fastify.ready();

  // Extract the generated spec
  const spec = fastify.swagger();

  // Write JSON
  const jsonPath = resolve(BACKEND_ROOT, 'openapi.json');
  writeFileSync(jsonPath, JSON.stringify(spec, null, 2));
  console.log(`✅ OpenAPI JSON written to ${jsonPath}`);

  // Write YAML (optional, requires js-yaml)
  try {
    const { dump } = await import('js-yaml');
    const yamlPath = resolve(BACKEND_ROOT, 'openapi.yaml');
    writeFileSync(yamlPath, dump(spec, { lineWidth: 120, noRefs: false }));
    console.log(`✅ OpenAPI YAML written to ${yamlPath}`);
  } catch {
    console.log('⚠️  js-yaml not installed, skipping YAML output (npm i -D js-yaml)');
  }

  await fastify.close();
}

generate().catch((err) => {
  console.error('❌ Generation failed:', err);
  process.exit(1);
});