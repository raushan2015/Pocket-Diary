import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';

/**
 * The app accepts requests from any Origin (see app.ts): it is legitimately
 * reachable through several front doors — LAN IP, Tailscale IP, MagicDNS
 * name and an external HTTPS domain behind a reverse proxy — and the scheme/
 * host each proxy reports never matches the browser Origin in every chain.
 * Cross-site state changes are still prevented in the browser by the
 * SameSite=Lax session cookie, which never accompanies cross-site POSTs.
 */
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

  it('accepts state-changing requests from any origin (multi-front-door deployment)', async () => {
    // Simulates the production flow that motivated this: a browser on
    // https://notes.techshan.app whose request reaches the backend through
    // an HTTPS-terminating reverse proxy, so the forwarded scheme is http.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: {
        origin: 'https://notes.techshan.app',
        host: 'notes.techshan.app',
        'x-forwarded-host': 'notes.techshan.app',
        'x-forwarded-proto': 'http',
      },
      payload: {
        email: 'any-origin@example.com',
        password: 'SecurePassword123!',
        name: 'Any Origin',
      },
    });

    expect(response.statusCode).toBe(201);
  });

  it('still sets the SameSite=Lax session cookie (the enforced CSRF defense)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'cookie-check@example.com',
        password: 'SecurePassword123!',
        name: 'Cookie Check',
      },
    });

    expect(response.statusCode).toBe(201);
    const cookie = response.cookies.find((c) => c.name === 'memo_session');
    expect(cookie).toBeTruthy();
    expect(cookie!.sameSite?.toLowerCase()).toBe('lax');
    expect(cookie!.httpOnly).toBe(true);
  });
});
