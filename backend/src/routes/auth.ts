import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { config, resolveAppUrl } from '../config.js';
import {
  registerUser,
  loginUser,
  logoutUser,
  getUserWorkspaces,
  hashPassword,
  verifyPassword,
  hashSessionToken,
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
}

interface LoginBody {
  email?: string;
  password?: string;
  rememberMe?: boolean;
}

const registerSchema = {
  body: {
    type: 'object',
    required: ['email', 'password', 'name'],
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 254 },
      password: { type: 'string', minLength: 6, maxLength: 200 },
      name: { type: 'string', minLength: 1, maxLength: 120 },
      inviteToken: { type: 'string', minLength: 16, maxLength: 128 },
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
      password: { type: 'string', minLength: 1, maxLength: 200 },
      rememberMe: { type: 'boolean' },
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
      newPassword: { type: 'string', minLength: 6, maxLength: 200 },
    },
    additionalProperties: false,
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
    schema: registerSchema,
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
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
    schema: loginSchema,
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
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
    schema: forgotSchema,
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
    schema: resetPasswordSchema,
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
  fastify.patch<{ Body: { name?: string; currentPassword?: string; newPassword?: string } }>('/profile', {
    preHandler: fastify.authenticate,
    schema: profileSchema,
  }, async (request, reply) => {
    try {
      const user = request.user!;
      const { name, currentPassword, newPassword } = request.body || {};
      const now = Date.now();

      if (newPassword) {
        if (!currentPassword) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Current password is required to change password',
          });
        }
        if (newPassword.length < 6) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'New password must be at least 6 characters long',
          });
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

      const updated = fastify.dbCtx.sqlite.prepare(
        'SELECT id, email, name, created_at FROM users WHERE id = ?'
      ).get(user.id) as { id: string; email: string; name: string; created_at: number };

      return reply.status(200).send({
        user: {
          id: updated.id,
          email: updated.email,
          name: updated.name,
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
  fastify.post('/logout', async (request, reply) => {
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
  }, async (request, reply) => {
    const user = request.user!;
    // Sessions are stored as SHA-256 hashes (H-7); identify the current one by hashing the cookie value.
    const currentSessionId = hashSessionToken(request.sessionToken ?? '');
    const rows = fastify.dbCtx.sqlite
      .prepare(
        'SELECT id, ip_address, user_agent, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC'
      )
      .all(user.id, Date.now()) as Array<{ id: string; ip_address: string | null; user_agent: string | null; created_at: number; expires_at: number }>;

    return reply.status(200).send({
      sessions: rows.map((row) => ({
        // Expose only a short fingerprint — the session token itself must never leave the server.
        id: `${row.id.slice(0, 8)}…${row.id.slice(-4)}`,
        current: row.id === currentSessionId,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })),
    });
  });

  // POST /api/v1/auth/sessions/revoke — sign out every other session (kept: the current one)
  fastify.post('/sessions/revoke', {
    preHandler: fastify.authenticate,
  }, async (request, reply) => {
    const user = request.user!;
    const currentSessionId = hashSessionToken(request.sessionToken ?? '');
    const result = fastify.dbCtx.sqlite
      .prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?')
      .run(user.id, currentSessionId);

    return reply.status(200).send({ success: true, revoked: result.changes });
  });
};
