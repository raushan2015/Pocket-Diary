import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs';
import { config, resolveAppUrl } from '../config.js';
import {
  SESSION_SECURITY,
  PUBLIC_SECURITY,
  jsonResponse,
  errorResponses,
  ref,
  refArray,
} from '../openapi.js';
import {
  registerUser,
  loginUser,
  logoutUser,
  getUserWorkspaces,
  hashPassword,
  verifyPassword,
  hashSessionToken,
  validatePasswordStrength,
  normalizeTimezone,
  deleteAccount,
  AuthError,
} from '../services/auth.service.js';
import { acceptInvite, InviteError } from '../services/invite.service.js';
import { isEmailEnabled } from '../services/mailer.service.js';
import {
  requestPasswordReset,
  consumePasswordReset,
  PasswordResetError,
  PASSWORD_RESET_MIN_LENGTH,
  PASSWORD_RESET_MAX_LENGTH,
} from '../services/password-reset.service.js';

interface RegisterBody {
  email?: string;
  password?: string;
  name?: string;
  inviteToken?: string;
  /** IANA timezone from the browser (audit M-16), e.g. Asia/Tokyo. */
  timezone?: string;
}

interface LoginBody {
  email?: string;
  password?: string;
  rememberMe?: boolean;
  /** IANA timezone from the browser (audit M-16). */
  timezone?: string;
}

const registerSchema = {
  body: {
    type: 'object',
    required: ['email', 'password', 'name'],
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 254 },
      // Audit L-9: server-enforced policy (>= 8 chars; letter+digit checked in the service).
      password: { type: 'string', minLength: 8, maxLength: 200 },
      name: { type: 'string', minLength: 1, maxLength: 120 },
      inviteToken: { type: 'string', minLength: 16, maxLength: 128 },
      timezone: { type: 'string', maxLength: 64 },
    },
    additionalProperties: false,
  },
};

const loginSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 254 },
      // Login intentionally accepts legacy short passwords: existing users
      // must be able to sign in to upgrade their password.
      password: { type: 'string', minLength: 1, maxLength: 200 },
      rememberMe: { type: 'boolean' },
      timezone: { type: 'string', maxLength: 64 },
    },
    additionalProperties: false,
  },
};

const forgotSchema = {
  body: {
    type: 'object',
    required: ['email'],
    properties: { email: { type: 'string', minLength: 3, maxLength: 254 } },
    additionalProperties: false,
  },
};

const resetPasswordSchema = {
  body: {
    type: 'object',
    required: ['token', 'newPassword'],
    properties: {
      token: { type: 'string', minLength: 16, maxLength: 128 },
      newPassword: { type: 'string', minLength: PASSWORD_RESET_MIN_LENGTH, maxLength: PASSWORD_RESET_MAX_LENGTH },
    },
    additionalProperties: false,
  },
};

const profileSchema = {
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      currentPassword: { type: 'string', maxLength: 200 },
      newPassword: { type: 'string', minLength: 8, maxLength: 200 },
      timezone: { type: 'string', maxLength: 64 },
    },
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// OpenAPI metadata for this plugin (spec-only; see src/openapi.ts)
// ---------------------------------------------------------------------------

const registerMeta = {
  tags: ['Auth'],
  summary: 'Create an account (and first workspace)',
  description: [
    'Registers a user, hashes the password (argon2), creates their personal workspace,',
    'and signs them in by setting the `memo_session` cookie.',
    'Passwords must be at least 8 characters and contain a letter and a digit (audit L-9).',
    'An optional `inviteToken` (from a workspace invitation) joins that workspace immediately;',
    'if the invite cannot be used, the account is still created and `inviteWarning` explains why.',
  ].join(' '),
  security: PUBLIC_SECURITY,
  openapi: {
    responses: {
      201: jsonResponse(
        {
          type: 'object',
          required: ['user', 'workspace'],
          properties: {
            user: ref('User'),
            workspace: ref('Workspace'),
            joinedWorkspace: ref('Workspace'),
            inviteWarning: { type: 'string', description: 'Present when the supplied invite token could not be used.' },
          },
        },
        'Account created; the session cookie is set.',
      ),
      ...errorResponses([400, 409, 429, 500]),
    },
  },
};

const loginMeta = {
  tags: ['Auth'],
  summary: 'Sign in',
  description: 'Verifies the password, sets the `memo_session` cookie, and returns the user with their active workspace. `rememberMe: false` creates a session cookie without a max-age (expires when the browser closes). A configurable per-account lockout applies after repeated failures (audit H-1).',
  security: PUBLIC_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['user', 'activeWorkspace'],
          properties: {
            user: ref('User'),
            activeWorkspace: { $ref: '#/components/schemas/Workspace' },
          },
        },
        'Signed in; the session cookie is set.',
      ),
      ...errorResponses([400, 401, 429, 500]),
    },
  },
};

const forgotPasswordMeta = {
  tags: ['Auth'],
  summary: 'Request a password-reset link',
  description: 'Generates a single-use, time-limited reset token and emails a recovery link (when SMTP is configured). The response is identical whether or not the address has an account — it never reveals account existence. Reset links are built from the configured APP_URL (audit C-3).',
  security: PUBLIC_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['success', 'message', 'emailConfigured'],
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            emailConfigured: { type: 'boolean', description: 'Whether SMTP is set up; false means an instance admin must reset the password manually.' },
          },
        },
        'Always returned, regardless of account existence.',
      ),
      ...errorResponses([400, 429]),
    },
  },
};

const resetPasswordMeta = {
  tags: ['Auth'],
  summary: 'Complete a password reset',
  description: 'Verifies the one-time token, updates the password hash (8+ characters with a letter and a digit) and revokes every existing session for the account.',
  security: PUBLIC_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['success', 'message'],
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        'Password updated; all sessions were revoked.',
      ),
      ...errorResponses([400, 429, 500]),
    },
  },
};

const profileMeta = {
  tags: ['Auth'],
  summary: 'Update name, timezone, or password',
  description: 'Partial update of the signed-in user. Changing the password requires `currentPassword` and revokes every OTHER session (audit H-6); the new password must satisfy the account policy (8+ chars, letter + digit). `timezone` is an IANA name used when formatting reminder emails (audit M-16); invalid values normalize to UTC.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['user'],
          properties: { user: ref('User') },
        },
        'Updated profile. If the password changed, other devices are signed out.',
      ),
      ...errorResponses([400, 401, 500]),
    },
  },
};

const logoutMeta = {
  tags: ['Auth'],
  summary: 'Sign out',
  description: 'Deletes the current session server-side and clears the cookie. Safe to call when not signed in.',
  security: PUBLIC_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(ref('SimpleSuccess'), 'Signed out; the cookie is cleared.'),
      ...errorResponses([429]),
    },
  },
};

const meMeta = {
  tags: ['Auth'],
  summary: 'Current user and workspaces',
  description: 'Returns the signed-in user (including the instance-admin flag) and every workspace they belong to, with their role in each.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['user', 'workspaces'],
          properties: {
            user: ref('User'),
            workspaces: refArray('Workspace'),
          },
        },
        'The signed-in user and their workspaces.',
      ),
      ...errorResponses([401, 429]),
    },
  },
};

const sessionsMeta = {
  tags: ['Auth'],
  summary: 'List active sessions (devices)',
  description: 'Every currently valid session for the account, newest first, including the current one. Session ids are opaque per-device identifiers — never the token or its hash (audit L-8).',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['sessions'],
          properties: { sessions: refArray('Session') },
        },
        'Active sessions for the account.',
      ),
      ...errorResponses([401, 429]),
    },
  },
};

const revokeSessionMeta = {
  tags: ['Auth'],
  summary: 'Revoke one other session',
  description: 'Signs out exactly one other device, identified by the opaque `id` from GET /auth/sessions (audit L-8). The current session cannot be revoked this way — use POST /auth/logout.',
  security: SESSION_SECURITY,
  openapi: {
    params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64, description: 'Opaque session id from GET /auth/sessions.' } }, additionalProperties: false },
    responses: {
      200: jsonResponse(ref('SimpleSuccess'), 'The device was signed out.'),
      ...errorResponses([400, 401, 404, 429]),
    },
  },
};

const revokeAllMeta = {
  tags: ['Auth'],
  summary: 'Sign out all other devices',
  description: 'Revokes every session for the account except the one making the request.',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(
        {
          type: 'object',
          required: ['success', 'revoked'],
          properties: {
            success: { type: 'boolean' },
            revoked: { type: 'integer', description: 'Number of other sessions revoked.' },
          },
        },
        'Other sessions revoked.',
      ),
      ...errorResponses([401, 429]),
    },
  },
};

const deleteAccountMeta = {
  tags: ['Auth'],
  summary: 'Permanently delete the account',
  description: 'Requires the current password. Solo workspaces (and their notes and attachments) are deleted; notes authored in other people\'s workspaces are reassigned to those workspaces\' owners; invitations are re-attributed. Workspaces you own that have other members must be transferred or deleted first (409). Clears the session cookie (audit L-8).',
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      200: jsonResponse(ref('AccountDeletion'), 'Account and solo-workspace data deleted.'),
      ...errorResponses([400, 401, 409, 429, 500]),
    },
  },
};

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Helper to set session cookie
  const setSessionCookie = (reply: FastifyReply, token: string, request: FastifyRequest, rememberMe: boolean = true) => {
    // Respect the original protocol reported by the trusted reverse proxy.
    // Secure=true on plain HTTP makes browsers silently reject the session cookie.
    const secureCookie = request.protocol === 'https';
    reply.setCookie(config.cookieName, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
      ...(rememberMe ? { maxAge: Math.floor(config.sessionDurationMs / 1000) } : {}),
    });
  };

  // POST /api/v1/auth/register
  fastify.post<{ Body: RegisterBody }>('/register', {
    schema: { ...registerSchema, ...registerMeta },
    // Audit §6: configurable so CI/ephemeral instances (where every request
    // shares one client IP) are not throttled; production keeps the tight default.
    config: { rateLimit: { max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 15), timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      const { email, password, name, inviteToken } = request.body || {};

      if (!email || !password || !name) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Email, password, and name are required',
        });
      }

      const clientIp = request.ip;
      const userAgent = request.headers['user-agent'];

      const result = await registerUser(fastify.dbCtx.db, {
        email,
        password,
        name,
        ipAddress: clientIp,
        userAgent,
        timezone: request.body?.timezone,
      });

      setSessionCookie(reply, result.sessionToken, request, true);

      // Auto-accept a workspace invitation passed from the register screen.
      let joinedWorkspace = null;
      if (inviteToken) {
        try {
          const invite = acceptInvite(fastify.dbCtx, inviteToken, result.user.id);
          joinedWorkspace = { id: invite.workspaceId, name: invite.workspaceName, role: invite.role };
        } catch (err) {
          if (err instanceof InviteError) {
            return reply.status(201).send({
              user: result.user,
              workspace: result.workspace,
              inviteWarning: err.message,
            });
          }
          throw err;
        }
      }

      return reply.status(201).send({
        user: result.user,
        workspace: result.workspace,
        ...(joinedWorkspace ? { joinedWorkspace } : {}),
      });
    } catch (err: unknown) {
      if (err instanceof AuthError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 409 ? 'Conflict' : 'Bad Request',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Registration failed',
      });
    }
  });

  // POST /api/v1/auth/login
  fastify.post<{ Body: LoginBody }>('/login', {
    schema: { ...loginSchema, ...loginMeta },
    config: { rateLimit: { max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 15), timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      const { email, password, rememberMe } = request.body || {};

      if (!email || !password) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Email and password are required',
        });
      }

      const clientIp = request.ip;
      const userAgent = request.headers['user-agent'];

      const result = await loginUser(fastify.dbCtx.db, {
        email,
        password,
        ipAddress: clientIp,
        userAgent,
        timezone: request.body?.timezone,
      });

      setSessionCookie(reply, result.sessionToken, request, rememberMe !== false);

      return reply.status(200).send({
        user: result.user,
        activeWorkspace: result.activeWorkspace,
      });
    } catch (err: unknown) {
      if (err instanceof AuthError) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 401 ? 'Unauthorized' : err.statusCode === 429 ? 'Too Many Requests' : 'Bad Request',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Login failed',
      });
    }
  });

  // POST /api/v1/auth/forgot-password
  // Generates a single-use, time-limited reset token and emails a recovery
  // link (when SMTP is configured). The response is identical whether or not
  // the address has an account, and never reveals account existence.
  fastify.post<{ Body: { email?: string } }>('/forgot-password', {
    schema: { ...forgotSchema, ...forgotPasswordMeta },
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { email } = request.body || {};
    if (!email || !email.trim()) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Email address is required',
      });
    }

    try {
      // Security (audit C-3): reset links are always built from the configured
      // APP_URL — never from request headers, which an attacker can forge.
      const result = await requestPasswordReset(fastify.dbCtx, email, resolveAppUrl());
      return reply.status(200).send({
        success: true,
        message: 'If an account exists with this email, password recovery instructions have been sent.',
        emailConfigured: result.emailConfigured,
      });
    } catch (err: unknown) {
      // Never fail the request on delivery problems — that would leak information.
      fastify.log.warn(err, 'Password reset request could not be processed');
      return reply.status(200).send({
        success: true,
        message: 'If an account exists with this email, password recovery instructions have been sent.',
        emailConfigured: isEmailEnabled(),
      });
    }
  });

  // POST /api/v1/auth/reset-password
  // Completes the recovery flow: verifies the one-time token, updates the
  // password hash and revokes every existing session for the account.
  fastify.post<{ Body: { token?: string; newPassword?: string } }>('/reset-password', {
    schema: { ...resetPasswordSchema, ...resetPasswordMeta },
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { token, newPassword } = request.body || {};
    if (!token || !newPassword) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Reset token and new password are required',
      });
    }

    try {
      await consumePasswordReset(fastify.dbCtx, token, newPassword);
      return reply.status(200).send({
        success: true,
        message: 'Password updated successfully. You can now sign in with your new password.',
      });
    } catch (err: unknown) {
      if (err instanceof PasswordResetError) {
        return reply.status(err.statusCode).send({
          error: 'Bad Request',
          message: err.message,
        });
      }
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to reset password',
      });
    }
  });

  // PATCH /api/v1/auth/profile
  fastify.patch<{ Body: { name?: string; currentPassword?: string; newPassword?: string; timezone?: string } }>('/profile', {
    preHandler: fastify.authenticate,
    schema: { ...profileSchema, ...profileMeta },
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const { name, currentPassword, newPassword, timezone } = request.body || {};
      const now = Date.now();

      if (newPassword) {
        if (!currentPassword) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Current password is required to change password',
          });
        }
        // Audit L-9: server-enforced password policy on change, same as register.
        try {
          validatePasswordStrength(newPassword);
        } catch (err) {
          return reply.status(400).send({ error: 'Bad Request', message: err instanceof Error ? err.message : 'Invalid new password' });
        }

        const userRow = fastify.dbCtx.sqlite.prepare(
          'SELECT password_hash FROM users WHERE id = ?'
        ).get(user.id) as { password_hash: string } | undefined;

        if (!userRow || !(await verifyPassword(userRow.password_hash, currentPassword))) {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Current password is incorrect',
          });
        }

        const newHash = await hashPassword(newPassword);
        fastify.dbCtx.sqlite.prepare(
          'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'
        ).run(newHash, now, user.id);

        // Security (audit H-6): a password change must revoke every OTHER
        // session for the account. Without this, a stolen session cookie
        // survives the user changing their password — the usual first fix.
        // Sessions are stored hashed (H-7), so compare against the hash.
        const currentSessionId = hashSessionToken(request.sessionToken ?? '');
        fastify.dbCtx.sqlite.prepare(
          'DELETE FROM sessions WHERE user_id = ? AND id != ?'
        ).run(user.id, currentSessionId);
      }

      if (name && name.trim()) {
        fastify.dbCtx.sqlite.prepare(
          'UPDATE users SET name = ?, updated_at = ? WHERE id = ?'
        ).run(name.trim(), now, user.id);
      }

      // Audit M-16: the browser's IANA timezone, used when formatting the
      // times in reminder emails (previously everything rendered in UTC).
      if (timezone !== undefined) {
        const tz = normalizeTimezone(timezone);
        fastify.dbCtx.sqlite.prepare(
          'UPDATE users SET timezone = ?, updated_at = ? WHERE id = ?'
        ).run(tz, now, user.id);
      }

      const updated = fastify.dbCtx.sqlite.prepare(
        'SELECT id, email, name, timezone, created_at FROM users WHERE id = ?'
      ).get(user.id) as { id: string; email: string; name: string; timezone: string; created_at: number };

      return reply.status(200).send({
        user: {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          timezone: updated.timezone,
          createdAt: Number(updated.created_at),
        },
      });
    } catch (err: unknown) {
      fastify.log.error(err);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to update profile',
      });
    }
  });

  // POST /api/v1/auth/logout
  fastify.post('/logout', { schema: logoutMeta }, async (request, reply) => {
    const sessionToken = request.cookies[config.cookieName];
    if (sessionToken) {
      await logoutUser(fastify.dbCtx.db, sessionToken);
    }

    reply.clearCookie(config.cookieName, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: request.protocol === 'https',
    });

    return reply.status(200).send({ success: true });
  });

  // GET /api/v1/auth/me
  fastify.get('/me', {
    preHandler: fastify.authenticate,
    schema: meMeta,
  }, async (request, reply) => {
    const user = request.user!;
    const workspaces = await getUserWorkspaces(fastify.dbCtx.db, user.id);

    return reply.status(200).send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
        isInstanceAdmin: user.isInstanceAdmin,
      },
      workspaces,
    });
  });

  // GET /api/v1/auth/sessions — active session devices for the current user
  fastify.get('/sessions', {
    preHandler: fastify.authenticate,
    schema: sessionsMeta,
  }, async (request, reply) => {
    const user = request.user!;
    // Sessions are stored as SHA-256 hashes (H-7); identify the current one by hashing the cookie value.
    const currentSessionId = hashSessionToken(request.sessionToken ?? '');
    const rows = fastify.dbCtx.sqlite
      .prepare(
        'SELECT id, public_id, ip_address, user_agent, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC'
      )
      .all(user.id, Date.now()) as Array<{ id: string; public_id: string; ip_address: string | null; user_agent: string | null; created_at: number; expires_at: number }>;

    return reply.status(200).send({
      sessions: rows.map((row) => ({
        // Opaque per-device identifier (audit L-8) — the token hash itself must never leave the server.
        id: row.public_id || `${row.id.slice(0, 8)}…${row.id.slice(-4)}`,
        current: row.id === currentSessionId,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })),
    });
  });

  // DELETE /api/v1/auth/sessions/:id — revoke ONE other session (audit L-8).
  // `id` is the opaque public_id from GET /sessions, never the token hash.
  fastify.delete<{ Params: { id: string } }>('/sessions/:id', {
    preHandler: fastify.authenticate,
    schema: revokeSessionMeta,
  }, async (request, reply) => {
    const user = request.user!;
    const currentSessionId = hashSessionToken(request.sessionToken ?? '');
    const target = fastify.dbCtx.sqlite
      .prepare('SELECT id FROM sessions WHERE user_id = ? AND public_id = ?')
      .get(user.id, request.params.id) as { id: string } | undefined;
    if (!target) {
      return reply.status(404).send({ error: 'Not Found', message: 'Session not found' });
    }
    if (target.id === currentSessionId) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Use sign out to end the current session' });
    }
    fastify.dbCtx.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(target.id);
    return reply.status(200).send({ success: true });
  });

  // POST /api/v1/auth/sessions/revoke — sign out every other session (kept: the current one)
  fastify.post('/sessions/revoke', {
    preHandler: fastify.authenticate,
    schema: revokeAllMeta,
  }, async (request, reply) => {
    const user = request.user!;
    const currentSessionId = hashSessionToken(request.sessionToken ?? '');
    const result = fastify.dbCtx.sqlite
      .prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?')
      .run(user.id, currentSessionId);

    return reply.status(200).send({ success: true, revoked: result.changes });
  });

  // DELETE /api/v1/auth/account — permanently delete the account (audit L-8).
  // Requires the current password; shared workspaces owned by the user must
  // be transferred (or deleted) first — solo workspaces are deleted with it.
  fastify.delete<{ Body: { currentPassword?: string } }>('/account', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['currentPassword'],
        properties: { currentPassword: { type: 'string', minLength: 1, maxLength: 200 } },
        additionalProperties: false,
      },
      ...deleteAccountMeta,
    },
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const { currentPassword } = request.body || {};
      if (!currentPassword) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Current password is required to delete your account' });
      }

      const userRow = fastify.dbCtx.sqlite.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string } | undefined;
      if (!userRow || !(await verifyPassword(userRow.password_hash, currentPassword))) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Current password is incorrect' });
      }

      // Collect the attachment files of the user's owned workspaces BEFORE
      // the deletion transaction runs: the workspace delete cascades the
      // `attachments` rows away, so querying afterwards always came up empty
      // and orphaned the files on disk. Only the solo workspaces actually
      // deleted by deleteAccount() are unlinked below.
      const orphanCandidates = fastify.dbCtx.sqlite.prepare(
        'SELECT workspace_id, storage_path FROM attachments WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = ?)'
      ).all(user.id) as Array<{ workspace_id: string; storage_path: string }>;

      const result = deleteAccount(fastify.dbCtx, user.id);

      // Best-effort cleanup of attachment files belonging to the deleted solo workspaces.
      const pathsByWorkspace = new Map<string, string[]>();
      for (const row of orphanCandidates) {
        const list = pathsByWorkspace.get(row.workspace_id) ?? [];
        list.push(row.storage_path);
        pathsByWorkspace.set(row.workspace_id, list);
      }
      for (const workspaceId of result.deletedWorkspaces) {
        for (const filePath of pathsByWorkspace.get(workspaceId) ?? []) {
          try { fs.unlinkSync(filePath); } catch { /* already gone */ }
        }
      }

      reply.clearCookie(config.cookieName, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: request.protocol === 'https',
      });

      return reply.status(200).send({
        success: true,
        deletedWorkspaces: result.deletedWorkspaces.length,
        reassignedMemos: result.reassignedMemos,
      });
    } catch (err: unknown) {
      if (err instanceof AuthError) {
        return reply.status(err.statusCode).send({ error: err.statusCode === 409 ? 'Conflict' : 'Bad Request', message: err.message });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Failed to delete account' });
    }
  });
};
