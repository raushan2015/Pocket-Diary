import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { validateSession } from '../services/auth.service.js';
import type { DatabaseContext } from '../db/index.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  isInstanceAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    sessionToken?: string;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    dbCtx: DatabaseContext;
  }
}

async function authPluginAsync(fastify: FastifyInstance) {
  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionToken = request.cookies[config.cookieName];

    if (!sessionToken) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const sessionData = await validateSession(fastify.dbCtx.db, sessionToken);

    if (!sessionData) {
      // Clear invalid cookie
      reply.clearCookie(config.cookieName, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: request.protocol === 'https',
      });

      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    request.user = {
      id: sessionData.user.id,
      email: sessionData.user.email,
      name: sessionData.user.name,
      createdAt: Number(sessionData.user.createdAt),
      isInstanceAdmin: Boolean(sessionData.user.isInstanceAdmin),
    };
    request.sessionToken = sessionToken;
  });
}

export const authPlugin = fp(authPluginAsync, {
  name: 'auth-plugin',
  dependencies: ['@fastify/cookie'],
});
