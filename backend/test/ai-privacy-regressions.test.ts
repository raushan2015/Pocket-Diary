import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import {
  createGrant, getLiveGrant, prepareNoteForProvider, containsLikelySecret,
} from '../src/services/ai/privacy.service.js';
import { isMessageContextStillValid, type MessageDto } from '../src/services/ai/chat.service.js';

describe('AI privacy regression: revoked source and secret titles', () => {
  let app: ReturnType<typeof buildApp>;
  let dbCtx: ReturnType<typeof createDatabase>;
  let user: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
    user = await createTestUser(app, 'regression@example.test', 'QA User');
  });

  afterEach(async () => {
    await app.close();
    dbCtx.sqlite.close();
  });

  const makeNote = async (title: string, content: string) => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/memos', headers: { cookie: user.cookieHeader },
      payload: { workspaceId: user.workspace.id, title, content },
    });
    expect(res.statusCode).toBe(201);
    return res.json().memo as { id: string; version: number };
  };

  const makeConversation = async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/ai/conversations', headers: { cookie: user.cookieHeader },
      payload: { workspaceId: user.workspace.id },
    });
    expect(res.statusCode).toBe(201);
    return res.json().conversation.id as string;
  };

  it('withholds a multi-note assistant message when ANY source grant is revoked', async () => {
    const a = await makeNote('Project A', 'Only for project A');
    const b = await makeNote('Project B', 'Only for project B');
    const conversationId = await makeConversation();
    const issue = (note: { id: string }) => createGrant(dbCtx, {
      userId: user.user.id, workspaceId: user.workspace.id, conversationId,
      memoId: note.id, kind: 'current_note', purpose: 'test', ttlMs: 60_000,
    });
    const ga = issue(a), gb = issue(b);
    const msg = {
      sources: [
        { noteId: a.id, grantId: ga.id, kind: 'current_note' },
        { noteId: b.id, grantId: gb.id, kind: 'current_note' },
      ],
      content: 'This summary combines both notes.',
    } as MessageDto;
    expect(isMessageContextStillValid(dbCtx, user.user.id, msg)).toBe(true);
    const blocked = await app.inject({
      method: 'PATCH', url: `/api/v1/ai/memos/${a.id}/privacy`,
      headers: { cookie: user.cookieHeader },
      payload: { workspaceId: user.workspace.id, aiAccess: 'blocked' },
    });
    expect(blocked.statusCode).toBe(200);
    expect(getLiveGrant(dbCtx, ga.id, { userId: user.user.id })).toBeNull();
    expect(getLiveGrant(dbCtx, gb.id, { userId: user.user.id })).not.toBeNull();
    expect(isMessageContextStillValid(dbCtx, user.user.id, msg)).toBe(false);
  });

  it('rejects search excerpts when a note is downgraded to current-only', async () => {
    const note = await makeNote('Safe search', 'May be shared with explicit consent');
    const convId = await makeConversation();
    const setPrivacy = async (aiAccess: string) => app.inject({
      method: 'PATCH', url: `/api/v1/ai/memos/${note.id}/privacy`,
      headers: { cookie: user.cookieHeader },
      payload: { workspaceId: user.workspace.id, aiAccess },
    });
    expect((await setPrivacy('search_allowed')).statusCode).toBe(200);
    const grant = createGrant(dbCtx, {
      userId: user.user.id, workspaceId: user.workspace.id, conversationId: convId,
      memoId: note.id, kind: 'search_excerpts', purpose: 'test', ttlMs: 60_000,
    });
    expect(getLiveGrant(dbCtx, grant.id, { userId: user.user.id, kind: 'search_excerpts' })).not.toBeNull();
    expect((await setPrivacy('current_only')).statusCode).toBe(200);
    expect(getLiveGrant(dbCtx, grant.id, { userId: user.user.id, kind: 'search_excerpts' })).toBeNull();
  });

  it('revoke endpoint only revokes grants owned by the signed-in user', async () => {
    const note = await makeNote('Session-scoped', 'Can be summarized while open');
    const grant = createGrant(dbCtx, {
      userId: user.user.id, workspaceId: user.workspace.id,
      conversationId: await makeConversation(), memoId: note.id,
      kind: 'current_note', purpose: 'test', ttlMs: 60_000,
    });
    const stranger = await createTestUser(app, 'stranger-revoke@example.test', 'Stranger');
    const wrongUser = await app.inject({
      method: 'POST', url: '/api/v1/ai/current-note/revoke',
      headers: { cookie: stranger.cookieHeader }, payload: { grantId: grant.id },
    });
    expect(wrongUser.statusCode).toBe(200);
    expect(wrongUser.json().revoked).toBe(false);
    expect(getLiveGrant(dbCtx, grant.id, { userId: user.user.id })).not.toBeNull();
    const owner = await app.inject({
      method: 'POST', url: '/api/v1/ai/current-note/revoke',
      headers: { cookie: user.cookieHeader }, payload: { grantId: grant.id },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().revoked).toBe(true);
    expect(getLiveGrant(dbCtx, grant.id, { userId: user.user.id })).toBeNull();
  });

  it('redacts credentials in titles as well as content, and secret detection is repeatable', async () => {
    const secret = 'veryLongSecretExample123456';
    const note = await makeNote(`API_KEY=${secret}`, 'Normal meeting note');
    const grant = createGrant(dbCtx, {
      userId: user.user.id, workspaceId: user.workspace.id,
      conversationId: await makeConversation(), memoId: note.id,
      kind: 'current_note', purpose: 'test', ttlMs: 60_000,
    });
    const prepared = prepareNoteForProvider(dbCtx, {
      memoId: note.id, workspaceId: user.workspace.id, grant,
    });
    expect(prepared.withheld).toBe(false);
    expect(JSON.stringify(prepared)).not.toContain(secret);
    expect(prepared.title).toContain('[REDACTED]');
    const sample = 'password=anotherLongSampleTokenABC';
    expect(containsLikelySecret(sample)).toBe(true);
    expect(containsLikelySecret(sample)).toBe(true);
  });
});
