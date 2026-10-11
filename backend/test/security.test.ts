import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';

describe('Browser request security', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;

  beforeEach(async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dbCtx.sqlite.close();
  });

  it('rejects state-changing requests from an untrusted origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: {
        origin: 'https://untrusted.example',
        host: 'memo.example',
        'x-forwarded-host': 'memo.example',
        'x-forwarded-proto': 'https',
      },
      payload: {
        email: 'cross-site@example.com',
        password: 'SecurePassword123!',
        name: 'Cross Site',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe('Cross-site request rejected');
  });

  it('allows same-origin state-changing requests', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: {
        origin: 'https://memo.example',
        host: 'memo.example',
        'x-forwarded-host': 'memo.example',
        'x-forwarded-proto': 'https',
      },
      payload: {
        email: 'same-origin@example.com',
        password: 'SecurePassword123!',
        name: 'Same Origin',
      },
    });

    expect(response.statusCode).toBe(201);
  });

  it('allows safe read-only requests from any origin at the request guard', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://untrusted.example' },
    });

    expect(response.statusCode).toBe(200);
  });
});
