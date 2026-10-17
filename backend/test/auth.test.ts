import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { users, sessions } from '../src/db/schema.js';
import { hashSessionToken } from '../src/services/auth.service.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

describe('Authentication API (/api/v1/auth)', () => {
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

  describe('POST /api/v1/auth/register', () => {
    it('registers a new user, creates a personal workspace, and sets memo_session cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'Jane.Doe@example.com',
          password: 'SecurePassword123!',
          name: 'Jane Doe',
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();

      // Check response body
      expect(json.user).toBeDefined();
      expect(json.user.id).toBeDefined();
      expect(json.user.email).toBe('jane.doe@example.com'); // lowercased
      expect(json.user.name).toBe('Jane Doe');
      expect(json.user.passwordHash).toBeUndefined(); // never expose password hash!

      expect(json.workspace).toBeDefined();
      expect(json.workspace.id).toBeDefined();
      expect(json.workspace.name).toBe('Personal');
      expect(json.workspace.slug).toContain('personal-');

      // Check cookie
      const cookies = res.cookies;
      const sessionCookie = cookies.find((c) => c.name === 'memo_session');
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie?.value).toBeTruthy();
      expect(sessionCookie?.httpOnly).toBe(true);
      expect(sessionCookie?.sameSite).toBe('Lax');

      // Verify DB state
      const dbUser = dbCtx.db.select().from(users).where(eq(users.email, 'jane.doe@example.com')).get();
      expect(dbUser).toBeDefined();
      expect(dbUser?.passwordHash).toMatch(/^\$argon2id\$/); // verified argon2id

      // Verify session exists in DB. Audit H-7: sessions are stored as SHA-256
      // hashes — the raw cookie value must never appear in the sessions table.
      const dbSession = dbCtx.db.select().from(sessions).where(eq(sessions.id, hashSessionToken(sessionCookie!.value))).get();
      expect(dbSession).toBeDefined();
      expect(dbSession?.userId).toBe(dbUser?.id);
      // The plaintext token must NOT be present in the database
      const rawSession = dbCtx.db.select().from(sessions).where(eq(sessions.id, sessionCookie!.value)).get();
      expect(rawSession).toBeUndefined();
    });

    it('rejects registration with invalid or missing inputs', async () => {
      // Missing email
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          password: 'Password123',
          name: 'Name',
        },
      });
      expect(res1.statusCode).toBe(400);

      // Short password (<6 chars)
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'test@example.com',
          password: '123',
          name: 'Name',
        },
      });
      expect(res2.statusCode).toBe(400);

      // Invalid email format
      const res3 = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'not-an-email',
          password: 'Password123',
          name: 'Name',
        },
      });
      expect(res3.statusCode).toBe(400);
    });

    it('rejects registration with already registered email with 409 Conflict', async () => {
      // First registration
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'duplicate@example.com',
          password: 'Password123',
          name: 'User One',
        },
      });

      // Duplicate registration attempt
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'DUPLICATE@example.com',
          password: 'Password456',
          name: 'User Two',
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Conflict');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    beforeEach(async () => {
      // Register a seed user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'alice@example.com',
          password: 'Password123!',
          name: 'Alice',
        },
      });
    });

    it('logs in successfully with valid credentials and issues new session cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'alice@example.com',
          password: 'Password123!',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.user.email).toBe('alice@example.com');
      expect(json.user.name).toBe('Alice');
      expect(json.activeWorkspace).toBeDefined();
      expect(json.activeWorkspace.name).toBe('Personal');

      // Check cookie
      const sessionCookie = res.cookies.find((c) => c.name === 'memo_session');
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie?.httpOnly).toBe(true);
    });

    it('rejects incorrect password with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'alice@example.com',
          password: 'WrongPassword!',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });

    it('rejects non-existent email with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'nonexistent@example.com',
          password: 'Password123!',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('returns current user profile and workspaces when authenticated', async () => {
      // 1. Register
      const registerRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'bob@example.com',
          password: 'Password123!',
          name: 'Bob',
        },
      });

      const sessionCookie = registerRes.cookies.find((c) => c.name === 'memo_session');
      expect(sessionCookie).toBeDefined();

      // 2. Call /api/v1/auth/me with session cookie
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        cookies: {
          memo_session: sessionCookie!.value,
        },
      });

      expect(meRes.statusCode).toBe(200);
      const json = meRes.json();
      expect(json.user.email).toBe('bob@example.com');
      expect(json.user.name).toBe('Bob');
      expect(json.workspaces).toHaveLength(1);
      expect(json.workspaces[0].name).toBe('Personal');
      expect(json.workspaces[0].role).toBe('owner');
    });

    it('returns 401 Unauthorized when no cookie is sent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });

    it('returns 401 Unauthorized when invalid cookie token is sent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        cookies: {
          memo_session: 'invalid-non-existent-token',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('invalidates the session and clears cookie', async () => {
      // 1. Register
      const registerRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'carol@example.com',
          password: 'Password123!',
          name: 'Carol',
        },
      });

      const sessionCookie = registerRes.cookies.find((c) => c.name === 'memo_session');
      const token = sessionCookie!.value;

      // 2. Verify session is active in /me
      const meBefore = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        cookies: { memo_session: token },
      });
      expect(meBefore.statusCode).toBe(200);

      // 3. Logout
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        cookies: { memo_session: token },
      });

      expect(logoutRes.statusCode).toBe(200);
      expect(logoutRes.json().success).toBe(true);

      // Check cookie was cleared
      const clearedCookie = logoutRes.cookies.find((c) => c.name === 'memo_session');
      expect(clearedCookie).toBeDefined();
      expect(clearedCookie?.value).toBe('');

      // 4. Verify session is deleted from DB
      const dbSession = dbCtx.db.select().from(sessions).where(eq(sessions.id, token)).get();
      expect(dbSession).toBeUndefined();

      // 5. Subsequent /me request should be 401
      const meAfter = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        cookies: { memo_session: token },
      });
      expect(meAfter.statusCode).toBe(401);
    });
  });
});
