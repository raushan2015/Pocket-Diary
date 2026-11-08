/**
 * AI action proposals (handoff §2.2, §2.3, §5): the model can only DRAFT a
 * note creation or update; a validated, server-stored proposal is produced
 * and executed exactly once after the user's explicit approval — through the
 * existing memo service (createMemo / updateMemo), preserving workspace
 * write-permission checks, optimistic versioning and idempotency.
 *
 * The model never writes to the database, never picks the workspace, and
 * never approves anything.
 */
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { aiActionProposals } from '../../db/schema.js';
import type { DatabaseContext } from '../../db/index.js';
import {
  createMemo,
  updateMemo,
  MemoConflictError,
  MemoNotFoundError,
  ValidationError as MemoValidationError,
  type ChecklistItem,
} from '../memo.service.js';
import { verifyWorkspaceMembership } from '../workspace.service.js';
import { audit } from './privacy.service.js';

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

export type ProposalAction = 'create' | 'update';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'conflict';

export interface ProposalPayload {
  title: string;
  content: string;
  tags?: string[];
  checklistData?: ChecklistItem[];
  noteType?: string;
}

export interface ProposalRecord {
  id: string;
  conversationId: string;
  userId: string;
  workspaceId: string;
  action: ProposalAction;
  targetNoteId: string | null;
  expectedNoteVersion: number | null;
  payload: ProposalPayload;
  status: ProposalStatus;
  resultMemoId: string | null;
  createdAt: number;
  expiresAt: number;
}

export class ProposalError extends Error {
  statusCode: number;
  code: string;
  currentVersion?: number;
  constructor(code: string, message: string, statusCode = 400, currentVersion?: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.currentVersion = currentVersion;
    this.name = 'ProposalError';
  }
}

const MAX_PROPOSAL_CONTENT_CHARS = 200_000;
const MAX_PROPOSAL_TITLE_CHARS = 200;
const MAX_PROPOSAL_TAGS = 30;

/** Validate + normalize a model-produced payload. Everything else is rejected. */
export function validateProposalPayload(raw: unknown): ProposalPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProposalError('invalid_payload', 'Proposal payload must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const title = String(obj.title ?? '').trim().slice(0, MAX_PROPOSAL_TITLE_CHARS);
  const content = String(obj.content ?? '').slice(0, MAX_PROPOSAL_CONTENT_CHARS);
  if (!title && !content.trim()) {
    throw new ProposalError('invalid_payload', 'Proposal must contain a title or content');
  }
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim().slice(0, 80)).slice(0, MAX_PROPOSAL_TAGS)
    : undefined;
  let checklistData: ChecklistItem[] | undefined;
  if (Array.isArray(obj.checklistData)) {
    checklistData = obj.checklistData.slice(0, 500).map((item, idx) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      return {
        id: String(rec.id ?? `item-${idx}-${crypto.randomUUID().slice(0, 8)}`).slice(0, 64),
        text: String(rec.text ?? '').slice(0, 5000),
        checked: Boolean(rec.checked ?? rec.completed ?? false),
      };
    });
  }
  const noteType = obj.noteType === 'checklist' ? 'checklist' : obj.noteType === 'text' ? 'text' : undefined;
  return { title, content, tags, checklistData, noteType };
}

export function createProposal(
  dbCtx: DatabaseContext,
  input: {
    conversationId: string;
    userId: string;
    workspaceId: string;
    action: ProposalAction;
    targetNoteId?: string | null;
    expectedNoteVersion?: number | null;
    payload: unknown;
  }
): ProposalRecord {
  if (input.action === 'update') {
    if (!input.targetNoteId || typeof input.targetNoteId !== 'string') {
      throw new ProposalError('invalid_payload', 'An update proposal requires targetNoteId');
    }
  }
  const payload = validateProposalPayload(input.payload);
  const id = crypto.randomUUID();
  const now = Date.now();
  dbCtx.db.insert(aiActionProposals).values({
    id,
    conversationId: input.conversationId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    action: input.action,
    targetNoteId: input.targetNoteId ?? null,
    expectedNoteVersion: input.expectedNoteVersion ?? null,
    payload: JSON.stringify(payload),
    status: 'pending',
    idempotencyKey: `prop_${id}`,
    resultMemoId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
  }).run();
  return getProposal(dbCtx, id)!;
}

export function getProposal(dbCtx: DatabaseContext, proposalId: string): ProposalRecord | null {
  const row = dbCtx.sqlite
    .prepare('SELECT * FROM ai_action_proposals WHERE id = ?')
    .get(proposalId) as any;
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    action: row.action,
    targetNoteId: row.target_note_id,
    expectedNoteVersion: row.expected_note_version,
    payload: JSON.parse(row.payload) as ProposalPayload,
    status: row.status,
    resultMemoId: row.result_memo_id,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

/** List pending proposals for a conversation (owner-only; caller enforces ownership). */
export function listPendingProposalsForConversation(dbCtx: DatabaseContext, conversationId: string): ProposalRecord[] {
  const rows = dbCtx.sqlite
    .prepare("SELECT id FROM ai_action_proposals WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at ASC")
    .all(conversationId) as Array<{ id: string }>;
  return rows.map((r) => getProposal(dbCtx, r.id)).filter((p): p is ProposalRecord => p !== null);
}

export interface ApproveResult {
  proposal: ProposalRecord;
  memo: { id: string; title: string; workspaceId: string } | null;
  conflict?: { currentVersion: number };
}

/**
 * Approve + execute exactly once. Transactional status transition
 * pending -> executed prevents replay; an expired/conflicted proposal fails
 * without writing. The acting user must still hold workspace write
 * permission — viewers can never approve an execution.
 */
export function approveProposal(
  dbCtx: DatabaseContext,
  proposalId: string,
  userId: string
): ApproveResult {
  const proposal = getProposal(dbCtx, proposalId);
  if (!proposal) throw new ProposalError('not_found', 'Proposal not found', 404);
  if (proposal.userId !== userId) throw new ProposalError('forbidden', 'Not your proposal', 403);

  // Write permission is re-checked at approval time (role may have changed).
  verifyWorkspaceMembership(dbCtx.db, userId, proposal.workspaceId, ['owner', 'admin', 'editor']);

  const now = Date.now();
  if (proposal.status !== 'pending') {
    // Idempotent replay of a successful approval returns the same result.
    if (proposal.status === 'executed' && proposal.resultMemoId) {
      return { proposal, memo: { id: proposal.resultMemoId, title: proposal.payload.title, workspaceId: proposal.workspaceId } };
    }
    throw new ProposalError('invalid_status', `Proposal is ${proposal.status}`, 409);
  }
  if (proposal.expiresAt < now) {
    dbCtx.sqlite.prepare("UPDATE ai_action_proposals SET status = 'expired', updated_at = ? WHERE id = ?").run(now, proposalId);
    throw new ProposalError('expired', 'Proposal expired — ask the assistant to draft it again', 410);
  }

  // Atomic claim: only one caller can move pending -> executed.
  const claimed = dbCtx.sqlite
    .prepare("UPDATE ai_action_proposals SET status = 'executed', updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(now, proposalId);
  if (claimed.changes !== 1) {
    throw new ProposalError('invalid_status', 'Proposal was already processed', 409);
  }

  try {
    if (proposal.action === 'create') {
      const memo = createMemo(
        dbCtx,
        {
          workspaceId: proposal.workspaceId,
          title: proposal.payload.title || 'Untitled note',
          content: proposal.payload.content,
          tags: proposal.payload.tags ?? [],
          checklistData: proposal.payload.checklistData ?? [],
          noteType: proposal.payload.noteType ?? (proposal.payload.checklistData && proposal.payload.checklistData.length > 0 ? 'checklist' : 'text'),
          // Duplicate protection if the same conversation retries approval.
          clientId: `ai-proposal-${proposal.id}`.slice(0, 64),
        },
        userId // actor = the approving user (createdBy attribution)
      );
      dbCtx.sqlite.prepare('UPDATE ai_action_proposals SET result_memo_id = ?, updated_at = ? WHERE id = ?').run(memo.id, Date.now(), proposalId);
      audit(dbCtx, userId, proposal.workspaceId, 'proposal_execute', memo.id, null, 0);
      return { proposal: getProposal(dbCtx, proposalId)!, memo: { id: memo.id, title: memo.title, workspaceId: memo.workspaceId } };
    }

    // update
    const memo = updateMemo(
      dbCtx,
      proposal.targetNoteId!,
      proposal.workspaceId,
      {
        title: proposal.payload.title !== undefined ? proposal.payload.title : undefined,
        content: proposal.payload.content !== undefined ? proposal.payload.content : undefined,
        tags: proposal.payload.tags,
        checklistData: proposal.payload.checklistData,
        version: proposal.expectedNoteVersion ?? undefined,
      },
      userId
    );
    dbCtx.sqlite.prepare('UPDATE ai_action_proposals SET result_memo_id = ?, updated_at = ? WHERE id = ?').run(memo.id, Date.now(), proposalId);
    audit(dbCtx, userId, proposal.workspaceId, 'proposal_execute', memo.id, null, 0);
    return { proposal: getProposal(dbCtx, proposalId)!, memo: { id: memo.id, title: memo.title, workspaceId: memo.workspaceId } };
  } catch (err) {
    // Roll the claim back to a terminal state so it cannot be replayed, but
    // do NOT overwrite anything: on a version conflict the note is untouched
    // and the user must re-authorize a fresh proposal.
    const conflict = err instanceof MemoConflictError;
    const terminal = conflict ? 'conflict' : 'expired';
    dbCtx.sqlite.prepare('UPDATE ai_action_proposals SET status = ?, updated_at = ? WHERE id = ?').run(terminal, Date.now(), proposalId);
    if (conflict) {
      throw new ProposalError('version_conflict', 'The note changed since this update was drafted. Reload it and request the update again.', 409, (err as MemoConflictError).currentVersion);
    }
    if (err instanceof MemoNotFoundError) throw new ProposalError('not_found', 'The target note no longer exists', 404);
    if (err instanceof MemoValidationError) throw new ProposalError('invalid_payload', err.message, 400);
    throw err;
  }
}

export function rejectProposal(dbCtx: DatabaseContext, proposalId: string, userId: string): ProposalRecord {
  const proposal = getProposal(dbCtx, proposalId);
  if (!proposal) throw new ProposalError('not_found', 'Proposal not found', 404);
  if (proposal.userId !== userId) throw new ProposalError('forbidden', 'Not your proposal', 403);
  if (proposal.status !== 'pending') throw new ProposalError('invalid_status', `Proposal is ${proposal.status}`, 409);
  dbCtx.sqlite.prepare("UPDATE ai_action_proposals SET status = 'rejected', updated_at = ? WHERE id = ?").run(Date.now(), proposalId);
  return getProposal(dbCtx, proposalId)!;
}

/** Cleanup on conversation deletion. */
export function deleteProposalsForConversation(dbCtx: DatabaseContext, conversationId: string): void {
  dbCtx.sqlite.prepare('DELETE FROM ai_action_proposals WHERE conversation_id = ?').run(conversationId);
}
