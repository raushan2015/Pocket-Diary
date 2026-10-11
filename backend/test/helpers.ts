import type { FastifyInstance } from 'fastify';

export async function createTestUser(
  app: FastifyInstance,
  email = 'user@example.com',
  name = 'Test User'
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email,
      password: 'Password123!',
      name,
    },
  });

  const json = res.json();
  const cookie = res.cookies.find((c) => c.name === 'memo_session')?.value;

  return {
    user: json.user,
    workspace: json.workspace,
    cookieHeader: `memo_session=${cookie}`,
    cookie,
  };
}
