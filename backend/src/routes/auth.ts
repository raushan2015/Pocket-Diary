import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import {
  registerUser,
  loginUser,
  logoutUser,
  getUserWorkspaces,
  hashPassword,
  verifyPassword,
  AuthError,
} from '../services/auth.service.js';

interface RegisterBody {
  email?: string;
  password?: string;
  name?: string;
}

interface LoginBody {
  email?: string;
  password?: string;
  rememberMe?: boolean;
}

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
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      const { email, password, name } = request.body || {};

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

      return reply.status(201).send({
        user: result.user,
        workspace: result.workspace,
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
          error: err.statusCode === 401 ? 'Unauthorized' : 'Bad Request',
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
  fastify.post<{ Body: { email?: string } }>('/forgot-password', async (request, reply) => {
    const { email } = request.body || {};
    if (!email || !email.trim()) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Email address is required',
      });
    }

    return reply.status(200).send({
      success: true,
      message: 'If an account exists with this email, password recovery instructions have been sent.',
    });
  });

  // PATCH /api/v1/auth/profile
  fastify.patch<{ Body: { name?: string; currentPassword?: string; newPassword?: string } }>('/profile', {
    preHandler: fastify.authenticate,
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
      }

      if (name && name.trim()) {
        fastify.dbCtx.sqlite.prepare(
          'UPDATE users SET name = ?, updated_at = ? WHERE id = ?'
        ).run(name.trim(), now, user.id);
      }

      const updated = fastify.dbCtx.sqlite.prepare(
        'SELECT id, email, name FROM users WHERE id = ?'
      ).get(user.id) as { id: string; email: string; name: string };

      return reply.status(200).send({ user: updated });
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
      },
      workspaces,
    });
  });
};
