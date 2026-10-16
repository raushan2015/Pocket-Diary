import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';

describe('Active sessions management (/api/v1/auth/sessions)', () => {
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

  const loginAs = async (email: string, password: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return `memo_session=${res.cookies.find((c: any) => c.name === 'memo_session')?.value}`;
  };

  it('lists the current session and revokes all other sessions', async () => {
    const { user, cookieHeader } = await createTestUser(app, 'sessions-user@example.com');

    // Second session for the same user
    const secondCookie = await loginAs('sessions-user@example.com', 'Password123!');

    // The old session sees both
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { cookie: secondCookie },
    });
    expect(listRes.statusCode).toBe(200);
    const sessions = listRes.json().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s: any) => s.current)).toHaveLength(1);
    // Session tokens themselves are never exposed
    expect(JSON.stringify(sessions)).not.toContain(secondCookie.split('=')[1]);

    // Revoke all others from the second session
    const revokeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke',
      headers: { cookie: secondCookie },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json().revoked).toBe(1);

    // The first (revoked) session is now unauthorized
    const oldStillValid = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieHeader },
    });
    expect(oldStillValid.statusCode).toBe(401);

    // The current session survives
    const currentStillValid = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: secondCookie },
    });
    expect(currentStillValid.statusCode).toBe(200);
    expect(currentStillValid.json().user.id).toBe(user.id);
  });

  it('requires authentication', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/v1/auth/sessions' });
    expect(anon.statusCode).toBe(401);
  });
});
