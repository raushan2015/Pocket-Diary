import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import { buildFtsQuery } from '../src/services/memo.service.js';
import type { FastifyInstance } from 'fastify';

describe('SQLite FTS5 Full-Text Search Engine', () => {
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

  it('buildFtsQuery generates safe queries and strips special syntax characters', () => {
    expect(buildFtsQuery('hello world')).toBe('"hello"* "world"*');
    expect(buildFtsQuery('test: (nested) "quotes" *stars*')).toBe('"test"* "nested"* "quotes"* "stars"*');
    expect(buildFtsQuery('special !@#$%^&*() characters')).toBe('"special"* "!@#$%"* "&"* "characters"*');
    expect(buildFtsQuery('')).toBe('');
    expect(buildFtsQuery('   ')).toBe('');
  });

  it('finds memos matching keywords in title or content', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    // Create memo 1
    await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Backend Architecture Overview',
        content: 'This document details Fastify, Drizzle ORM, and SQLite concurrency.',
      },
    });

    // Create memo 2
    await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Grocery Shopping List',
        content: 'Organic apples, oat milk, and sourdough bread.',
      },
    });

    // Create memo 3
    await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Team Sync Notes',
        content: 'Discussing the database schema and architecture decisions.',
      },
    });

    // Search by title keyword 'Architecture' -> should match Memo 1 and Memo 3 (in content)
    const res1 = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&search=Architecture`,
      headers: { cookie: cookieHeader },
    });
    expect(res1.statusCode).toBe(200);
    const json1 = res1.json();
    expect(json1.total).toBe(2);

    // Search by content keyword 'sourdough' -> should match Memo 2
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&search=sourdough`,
      headers: { cookie: cookieHeader },
    });
    expect(res2.statusCode).toBe(200);
    const json2 = res2.json();
    expect(json2.total).toBe(1);
    expect(json2.memos[0].title).toBe('Grocery Shopping List');

    // Prefix search 'Fast' -> matches Fastify in Memo 1
    const res3 = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&search=Fast`,
      headers: { cookie: cookieHeader },
    });
    expect(res3.statusCode).toBe(200);
    expect(res3.json().total).toBe(1);
    expect(res3.json().memos[0].title).toBe('Backend Architecture Overview');
  });

  it('handles punctuation and special characters safely without throwing SQL errors', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Error Handling & Edge Cases',
        content: 'Testing characters like "quotes", colons: and (parentheses).',
      },
    });

    // Query with problematic characters
    const query = 'quotes": AND (parentheses) *';
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&search=${encodeURIComponent(query)}`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.total).toBe(1);
  });

  it('keeps FTS5 index synchronized on memo UPDATE and DELETE', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    // Create memo
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Quantum Computing Draft',
        content: 'Entanglement and qubits explained.',
      },
    });
    const memo = createRes.json().memo;

    // Search for 'qubits' -> 1 match
    let res = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&search=qubits`,
      headers: { cookie: cookieHeader },
    });
    expect(res.json().total).toBe(1);

    // Update memo content to remove 'qubits' and introduce 'superconductors'
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/memos/${memo.id}`,
      headers: { cookie: cookieHeader },
      payload: {
        title: 'Quantum Computing Revised',
        content: 'Entanglement and superconductors explained.',
        version: 1,
      },
    });

    // Search for 'qubits' -> 0 matches now
    res = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&search=qubits`,
      headers: { cookie: cookieHeader },
    });
    expect(res.json().total).toBe(0);

    // Search for 'superconductors' -> 1 match now
    res = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&search=superconductors`,
      headers: { cookie: cookieHeader },
    });
    expect(res.json().total).toBe(1);

    // Soft delete memo -> excluded from standard search
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/${memo.id}`,
      headers: { cookie: cookieHeader },
    });

    res = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&search=superconductors`,
      headers: { cookie: cookieHeader },
    });
    expect(res.json().total).toBe(0);

    // Hard permanent delete
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/${memo.id}?permanent=true`,
      headers: { cookie: cookieHeader },
    });

    // Check with includeDeleted=true -> still 0 matches
    res = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&search=superconductors&includeDeleted=true`,
      headers: { cookie: cookieHeader },
    });
    expect(res.json().total).toBe(0);
  });
});
