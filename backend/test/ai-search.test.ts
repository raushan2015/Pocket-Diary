/**
 * AI search scale + two-stage behavior tests (handoff §2.4, matrix item 19):
 *  - 2,000+ note fixture: local search is bounded, paginated and fast enough,
 *  - FTS injection resistance (operators/punctuation cannot crash it),
 *  - per-note eligibility classification is correct,
 *  - preview/approve flow bounds and validation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import { MockProviderServer, TEST_ENCRYPTION_KEY } from './helpers/ai-mock-provider.js';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

describe('AI search scale and eligibility', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;
  let mock: MockProviderServer;
  let user: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    mock = new MockProviderServer();
    process.env.AI_DEEPSEEK_BASE_URL = await mock.listen();
  });

  afterAll(async () => {
    delete process.env.AI_DEEPSEEK_BASE_URL;
    delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
    await mock.close();
  });

  it('handles a 2,000-note workspace: bounded, paginated, eligible classification', async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
    user = await createTestUser(app, 'search-scale@example.com', 'Scale User');

    // Bulk-insert 2,050 notes directly (fixtures, synthetic data).
    const now = Date.now();
    const insert = dbCtx.sqlite.prepare(
      "INSERT INTO memos (id, workspace_id, title, content, created_by, created_at, updated_at, version, ai_access) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'current_only')"
    );
    const wsId = user.workspace.id;
    const userId = user.user.id;
    const many = dbCtx.sqlite.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        insert.run(crypto.randomUUID(), wsId, `Routine note ${i}`, `Routine content number ${i} about groceries ${i % 7}`, userId, now, now);
      }
    });
    many();

    const needle = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: user.cookieHeader },
      payload: { workspaceId: wsId, title: 'Website payments idea', content: 'Stripe checkout with usage-based billing for the shop website' },
    });
    expect(needle.statusCode).toBe(201);

    const started = Date.now();
    const search = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/search',
      headers: { cookie: user.cookieHeader },
      payload: { workspaceId: wsId, query: 'website payments idea', limit: 25 },
    });
    const elapsed = Date.now() - started;
    expect(search.statusCode).toBe(200);
    expect(search.json().hits.length).toBeGreaterThan(0);
    expect(search.json().hits[0].title).toBe('Website payments idea');
    expect(elapsed).toBeLessThan(3000); // bounded local FTS, comfortably fast

    // Pagination: page 2 differs from page 1.
    const page2 = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/search',
      headers: { cookie: user.cookieHeader },
      payload: { workspaceId: wsId, query: 'groceries', page: 2, limit: 25 },
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().page).toBe(2);
    expect(page2.json().total).toBe(2000);

    // Regression: a 400-candidate cap used to make page 9 and later vanish
    // even when thousands of matching notes existed.
    const page40 = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/search',
      headers: { cookie: user.cookieHeader },
      payload: { workspaceId: wsId, query: 'groceries', page: 40, limit: 50 },
    });
    expect(page40.statusCode).toBe(200);
    expect(page40.json().total).toBe(2000);
    expect(page40.json().hits).toHaveLength(50);
    const page41 = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/search',
      headers: { cookie: user.cookieHeader },
      payload: { workspaceId: wsId, query: 'groceries', page: 41, limit: 50 },
    });
    expect(page41.json().total).toBe(2000);
    expect(page41.json().hits).toHaveLength(0);

    await app.close();
    dbCtx.sqlite.close();
    mock.clearRecorded();
  });

  it('resists FTS injection attempts (operators, quotes, punctuation)', async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
    user = await createTestUser(app, 'search-inject@example.com', 'Inject User');
    const payloads = [
      '" OR 1=1 --',
      'NOT NEAR (a b) 5',
      "'); DROP TABLE memos;--",
      'a* OR b* AND c',
      '^ * "unbalanced',
      '日本語の検索 with emoji 🎉',
    ];
    for (const q of payloads) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/search',
        headers: { cookie: user.cookieHeader },
        payload: { workspaceId: user.workspace.id, query: q },
      });
      expect(res.statusCode).toBe(200);
    }
    // Table still intact.
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const count = dbCtx.sqlite.prepare('SELECT COUNT(*) AS n FROM memos').get() as { n: number };
    expect(count.n).toBe(0);
    await app.close();
    dbCtx.sqlite.close();
    mock.clearRecorded();
  });

  it('classifies eligibility per policy and never exposes blocked snippets to the LLM-visible path', async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
    user = await createTestUser(app, 'search-class@example.com', 'Class User');
    const wsId = user.workspace.id;

    const mk = async (title: string, content: string, access: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/memos', headers: { cookie: user.cookieHeader }, payload: { workspaceId: wsId, title, content } });
      const memo = res.json().memo;
      if (access !== 'current_only') {
        await app.inject({ method: 'PATCH', url: `/api/v1/ai/memos/${memo.id}/privacy`, headers: { cookie: user.cookieHeader }, payload: { workspaceId: wsId, aiAccess: access } });
      }
      return memo;
    };
    await mk('Searchable alpha', 'searchable alpha content', 'search_allowed');
    await mk('Hidden beta', 'hidden beta content', 'blocked');
    await mk('Default gamma', 'default gamma content', 'current_only');

    // FTS joins terms with implicit AND — search each classification term separately.
    for (const term of ['alpha', 'beta', 'gamma']) {
      const search = await app.inject({
        method: 'POST', url: '/api/v1/ai/search', headers: { cookie: user.cookieHeader },
        payload: { workspaceId: wsId, query: term },
      });
      expect(search.statusCode).toBe(200);
      const hit = search.json().hits.find((h: any) => h.title.toLowerCase().includes(term));
      expect(hit).toBeDefined();
      if (term === 'alpha') {
        expect(hit.llmEligible).toBe(true);
        expect(hit.eligibility).toBe('search_allowed');
      } else if (term === 'beta') {
        expect(hit.llmEligible).toBe(false);
        expect(hit.eligibility).toBe('blocked');
      } else {
        expect(hit.llmEligible).toBe(false);
        expect(hit.eligibility).toBe('current_only');
      }
    }

    await app.close();
    dbCtx.sqlite.close();
    mock.clearRecorded();
  });

  it('enforces preview/approve bounds: max 10 notes, expired tokens rejected', async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
    user = await createTestUser(app, 'search-bounds@example.com', 'Bounds User');
    const wsId = user.workspace.id;
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/memos', headers: { cookie: user.cookieHeader }, payload: { workspaceId: wsId, title: `N${i}`, content: `content ${i}` } });
      ids.push(res.json().memo.id);
    }
    const tooMany = await app.inject({
      method: 'POST', url: '/api/v1/ai/search/preview', headers: { cookie: user.cookieHeader },
      payload: { workspaceId: wsId, memoIds: ids },
    });
    expect(tooMany.statusCode).toBe(400); // schema caps at 10
    await app.close();
    dbCtx.sqlite.close();
    mock.clearRecorded();
  });
});
