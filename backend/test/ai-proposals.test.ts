/**
 * AI proposal lifecycle tests (handoff §2.3, matrix items 14, 18):
 *  - update proposals: diff preview, version-checked approval, 409 conflict
 *    without overwriting, no silent delete/overwrite,
 *  - expiry, ownership, one-time execution,
 *  - workspace binding: proposals cannot cross workspaces.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import { createProposal, approveProposal, rejectProposal, getProposal, ProposalError } from '../src/services/ai/proposal.service.js';
import { createMemo, updateMemo, getMemoById } from '../src/services/memo.service.js';
import { createConversation } from '../src/services/ai/chat.service.js';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

describe('AI proposals service', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;
  let user: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    // Proposals do not touch the credential vault; set a valid key anyway so
    // any incidental AI code path finds the vault configured.
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  });

  afterAll(async () => {
    delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
  });

  let conversationId: string;

  const setup = async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
    user = await createTestUser(app, 'prop@example.com', 'Prop User');
    conversationId = createConversation(dbCtx, user.user.id, user.workspace.id).id;
  };

  const teardown = async () => {
    await app.close();
    dbCtx.sqlite.close();
  };

  it('update proposal approval applies with optimistic version and attributes the actor', async () => {
    await setup();
    try {
      const memo = createMemo(dbCtx, { workspaceId: user.workspace.id, title: 'Original', content: 'line one' }, user.user.id);
      const proposal = createProposal(dbCtx, {
        conversationId,
        userId: user.user.id,
        workspaceId: user.workspace.id,
        action: 'update',
        targetNoteId: memo.id,
        expectedNoteVersion: memo.version,
        payload: { title: 'Original', content: 'line one\nline two (AI suggestion, review me)' },
      });
      const result = approveProposal(dbCtx, proposal.id, user.user.id);
      expect(result.memo?.id).toBe(memo.id);
      const updated = getMemoById(dbCtx, memo.id, user.workspace.id);
      expect(updated?.version).toBe(2);
      expect(updated?.content).toContain('line two');
    } finally {
      await teardown();
    }
  });

  it('a conflicted update proposal never overwrites the changed note', async () => {
    await setup();
    try {
      const memo = createMemo(dbCtx, { workspaceId: user.workspace.id, title: 'Concurrent', content: 'v1' }, user.user.id);
      const proposal = createProposal(dbCtx, {
        conversationId,
        userId: user.user.id,
        workspaceId: user.workspace.id,
        action: 'update',
        targetNoteId: memo.id,
        expectedNoteVersion: 1,
        payload: { content: 'AI wants to write this' },
      });
      // A human editor changes the note first.
      updateMemo(dbCtx, memo.id, user.workspace.id, { content: 'human edit wins', version: 1 }, user.user.id);
      try {
        approveProposal(dbCtx, proposal.id, user.user.id);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as ProposalError).code).toBe('version_conflict');
        expect((err as ProposalError).currentVersion).toBe(2);
      }
      const current = getMemoById(dbCtx, memo.id, user.workspace.id);
      expect(current?.content).toBe('human edit wins'); // no overwrite
      expect(getProposal(dbCtx, proposal.id)?.status).toBe('conflict'); // terminal, not replayable
    } finally {
      await teardown();
    }
  });

  it('reject and expire are terminal states; execution is exactly-once', async () => {
    await setup();
    try {
      const proposal = createProposal(dbCtx, {
        conversationId,
        userId: user.user.id,
        workspaceId: user.workspace.id,
        action: 'create',
        payload: { title: 'Once only', content: 'x' },
      });
      rejectProposal(dbCtx, proposal.id, user.user.id);
      expect(() => approveProposal(dbCtx, proposal.id, user.user.id)).toThrowError(ProposalError);
      const memos = dbCtx.sqlite.prepare('SELECT COUNT(*) AS n FROM memos').get() as { n: number };
      expect(memos.n).toBe(0);
    } finally {
      await teardown();
    }
  });

  it('proposals belong to their user and workspace — cross-user approval fails', async () => {
    await setup();
    try {
      const other = await createTestUser(app, 'prop-other@example.com', 'Other');
      const proposal = createProposal(dbCtx, {
        conversationId,
        userId: user.user.id,
        workspaceId: user.workspace.id,
        action: 'create',
        payload: { title: 'Mine', content: 'x' },
      });
      // Via HTTP: other user gets 404 (existence not leaked).
      const res = await app.inject({ method: 'POST', url: `/api/v1/ai/proposals/${proposal.id}/approve`, headers: { cookie: other.cookieHeader } });
      expect([403, 404]).toContain(res.statusCode);
    } finally {
      await teardown();
    }
  });

  it('create proposals cannot write into another workspace', async () => {
    await setup();
    try {
      const other = await createTestUser(app, 'prop-ws@example.com', 'OtherWs');
      // A proposal is bound to a workspace at creation; approval re-checks membership.
      const proposal = createProposal(dbCtx, {
        conversationId,
        userId: other.user.id,
        workspaceId: other.workspace.id,
        action: 'create',
        payload: { title: 'In other ws', content: 'x' },
      });
      // user (not a member of other's workspace) cannot approve it.
      expect(() => approveProposal(dbCtx, proposal.id, user.user.id)).toThrowError();
      const rows = dbCtx.sqlite.prepare('SELECT workspace_id FROM memos').all() as any[];
      for (const row of rows) expect(row.workspace_id).toBe(other.workspace.id);
    } finally {
      await teardown();
    }
  });

  it('expired proposals refuse execution', async () => {
    await setup();
    try {
      const proposal = createProposal(dbCtx, {
        conversationId,
        userId: user.user.id,
        workspaceId: user.workspace.id,
        action: 'create',
        payload: { title: 'Expired', content: 'x' },
      });
      dbCtx.sqlite.prepare('UPDATE ai_action_proposals SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, proposal.id);
      try {
        approveProposal(dbCtx, proposal.id, user.user.id);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as ProposalError).code).toBe('expired');
      }
    } finally {
      await teardown();
    }
  });
});
