/**
 * AI privacy service (handoff §2.5, §2.6, §3).
 *
 * Everything in this module is SERVER-OWNED authorization and sanitization.
 * Model output, client-supplied IDs and conversation history are untrusted;
 * the functions here decide what — if anything — may leave the server toward
 * an external provider.
 *
 * Policy states (memos.ai_access):
 *  - blocked:        strongest rule. Content AND identifying metadata never
 *                    reach an external model. Overrules every folder default
 *                    or tool request.
 *  - current_only:   default for all notes (new and pre-existing). Content is
 *                    sent only for an explicit user-initiated current-note
 *                    task backed by a live, server-validated grant.
 *  - search_allowed: opt-in for cross-note AI search analysis; still requires
 *                    per-task selection, preview and consent.
 */
import crypto from 'node:crypto';
import { and, eq, isNull, gt, sql } from 'drizzle-orm';
import { memos, aiNoteGrants, aiNoteProtectedSections, aiAccessAudit } from '../../db/schema.js';
import type { DatabaseContext } from '../../db/index.js';
import { getMemoById } from '../memo.service.js';

export const AI_ACCESS_STATES = ['blocked', 'current_only', 'search_allowed'] as const;
export type AiAccessState = (typeof AI_ACCESS_STATES)[number];

export function isAiAccessState(value: unknown): value is AiAccessState {
  return typeof value === 'string' && (AI_ACCESS_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AiPrivacyError extends Error {
  statusCode = 403;
  code: string;
  constructor(code: string, message: string, statusCode = 403) {
    super(message);
    this.code = code;
    this.name = 'AiPrivacyError';
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Policy checks
// ---------------------------------------------------------------------------

/**
 * Returns the current AI policy for a note. Notes that do not exist in the
 * workspace are indistinguishable from blocked (no existence leak).
 */
export function getNoteAiAccess(dbCtx: DatabaseContext, memoId: string, workspaceId: string): AiAccessState {
  const row = dbCtx.sqlite
    .prepare('SELECT ai_access FROM memos WHERE id = ? AND workspace_id = ?')
    .get(memoId, workspaceId) as { ai_access?: string } | undefined;
  if (!row) return 'blocked';
  return isAiAccessState(row.ai_access) ? row.ai_access : 'current_only';
}

/** Set the per-note policy. Caller must already hold edit authorization. */
export function setNoteAiAccess(dbCtx: DatabaseContext, memoId: string, workspaceId: string, state: AiAccessState): void {
  dbCtx.sqlite
    .prepare('UPDATE memos SET ai_access = ? WHERE id = ? AND workspace_id = ?')
    .run(state, memoId, workspaceId);
}

// ---------------------------------------------------------------------------
// Grants (short-lived, task-scoped read authorization)
// ---------------------------------------------------------------------------

export const CURRENT_NOTE_GRANT_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const SEARCH_GRANT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface GrantRecord {
  id: string;
  userId: string;
  workspaceId: string;
  conversationId: string | null;
  memoId: string;
  noteVersion: number;
  kind: string;
  purpose: string;
  expiresAt: number;
  revokedAt: number | null;
}

/**
 * Issue a grant. The caller is the authenticated user; the note must already
 * have passed workspace membership + policy validation.
 */
export function createGrant(
  dbCtx: DatabaseContext,
  input: {
    userId: string;
    workspaceId: string;
    conversationId: string | null;
    memoId: string;
    kind: 'current_note' | 'search_excerpts';
    purpose: string;
    ttlMs: number;
  }
): GrantRecord {
  const memo = getMemoById(dbCtx, input.memoId, input.workspaceId);
  if (!memo) throw new AiPrivacyError('note_not_found', 'Note not found', 404);
  const now = Date.now();
  const id = crypto.randomUUID();
  dbCtx.db
    .insert(aiNoteGrants)
    .values({
      id,
      userId: input.userId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      memoId: input.memoId,
      noteVersion: memo.version,
      kind: input.kind,
      purpose: input.purpose.slice(0, 200),
      expiresAt: now + input.ttlMs,
      revokedAt: null,
      createdAt: now,
    })
    .run();
  return {
    id,
    userId: input.userId,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    memoId: input.memoId,
    noteVersion: memo.version,
    kind: input.kind,
    purpose: input.purpose,
    expiresAt: now + input.ttlMs,
    revokedAt: null,
  };
}

/**
 * Validate a grant for live use. EVERY outbound use revalidates: owner,
 * workspace, conversation binding, kind, expiry, revocation, AND that the
 * note still sits at the version the grant was issued against (a version
 * bump silently invalidates the grant; the user must re-authorize).
 * Returns null when not live — callers must fail closed.
 */
export function getLiveGrant(
  dbCtx: DatabaseContext,
  grantId: string,
  expected: { userId: string; conversationId?: string | null; kind?: 'current_note' | 'search_excerpts' }
): GrantRecord | null {
  const rows = dbCtx.db
    .select()
    .from(aiNoteGrants)
    .where(and(eq(aiNoteGrants.id, grantId), isNull(aiNoteGrants.revokedAt), gt(aiNoteGrants.expiresAt, Date.now())))
    .limit(1)
    .all() as GrantRecord[];
  const grant = rows[0];
  if (!grant) return null;
  if (grant.userId !== expected.userId) return null;
  if (expected.conversationId !== undefined && grant.conversationId !== expected.conversationId) return null;
  if (expected.kind && grant.kind !== expected.kind) return null;
  const memo = dbCtx.sqlite
    .prepare('SELECT version, deleted_at FROM memos WHERE id = ? AND workspace_id = ?')
    .get(grant.memoId, grant.workspaceId) as { version: number; deleted_at: number | null } | undefined;
  if (!memo || memo.deleted_at !== null) return null;
  if (memo.version !== grant.noteVersion) return null;
  // Policy changes do not bump note versions. A search-approved note that is
  // downgraded to current_only must not keep granting cross-note access.
  const policy = getNoteAiAccess(dbCtx, grant.memoId, grant.workspaceId);
  if (policy === 'blocked' || (grant.kind === 'search_excerpts' && policy !== 'search_allowed')) return null;
  return grant;
}

export function revokeGrant(dbCtx: DatabaseContext, grantId: string, userId: string): boolean {
  const result = dbCtx.db
    .update(aiNoteGrants)
    .set({ revokedAt: Date.now() })
    .where(and(eq(aiNoteGrants.id, grantId), eq(aiNoteGrants.userId, userId), isNull(aiNoteGrants.revokedAt)))
    .run();
  return result.changes > 0;
}

/** Revoke every live grant a user holds over a note (policy change / block). */
export function revokeGrantsForMemo(dbCtx: DatabaseContext, memoId: string): number {
  const result = dbCtx.db
    .update(aiNoteGrants)
    .set({ revokedAt: Date.now() })
    .where(and(eq(aiNoteGrants.memoId, memoId), isNull(aiNoteGrants.revokedAt)))
    .run();
  return result.changes;
}

/** Account/workspace-membership teardown: revoke everything the user holds. */
export function revokeAllGrantsForUser(dbCtx: DatabaseContext, userId: string): number {
  const result = dbCtx.db
    .update(aiNoteGrants)
    .set({ revokedAt: Date.now() })
    .where(and(eq(aiNoteGrants.userId, userId), isNull(aiNoteGrants.revokedAt)))
    .run();
  return result.changes;
}

// ---------------------------------------------------------------------------
// Protected passages (version-tied, hash-anchored)
// ---------------------------------------------------------------------------

export interface ProtectedSectionRecord {
  id: string;
  memoId: string;
  noteVersion: number;
  passageHash: string;
  salt: string;
  passageLength: number;
  createdAt: number;
}

function hashPassage(salt: string, passage: string): string {
  return crypto.createHash('sha256').update(`${salt}:${passage}`).digest('hex');
}

export function listProtectedSections(dbCtx: DatabaseContext, memoId: string): ProtectedSectionRecord[] {
  return dbCtx.db
    .select({
      id: aiNoteProtectedSections.id,
      memoId: aiNoteProtectedSections.memoId,
      noteVersion: aiNoteProtectedSections.noteVersion,
      passageHash: aiNoteProtectedSections.passageHash,
      salt: aiNoteProtectedSections.salt,
      passageLength: aiNoteProtectedSections.passageLength,
      createdAt: aiNoteProtectedSections.createdAt,
    })
    .from(aiNoteProtectedSections)
    .where(eq(aiNoteProtectedSections.memoId, memoId))
    .all();
}

/**
 * Add protected passages for a note. The passage TEXT is hashed (salted) and
 * never persisted. Records bind to the current note version; the redaction
 * step re-locates each passage in CURRENT content by hash on every send, so
 * edits cannot silently drift protections.
 */
export function addProtectedSections(
  dbCtx: DatabaseContext,
  memoId: string,
  workspaceId: string,
  passages: string[],
  userId: string
): ProtectedSectionRecord[] {
  const memo = getMemoById(dbCtx, memoId, workspaceId);
  if (!memo) throw new AiPrivacyError('note_not_found', 'Note not found', 404);
  const created: ProtectedSectionRecord[] = [];
  for (const raw of passages) {
    const passage = String(raw ?? '');
    if (passage.trim().length < 3) {
      throw new AiPrivacyError('invalid_passage', 'A protected passage must contain at least 3 characters', 400);
    }
    if (passage.length > 20_000) {
      throw new AiPrivacyError('invalid_passage', 'A protected passage is too large (max 20,000 characters)', 400);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const id = crypto.randomUUID();
    const now = Date.now();
    dbCtx.db.insert(aiNoteProtectedSections).values({
      id,
      memoId,
      noteVersion: memo.version,
      passageHash: hashPassage(salt, passage),
      salt,
      passageLength: passage.length,
      createdBy: userId,
      createdAt: now,
    }).run();
    created.push({ id, memoId, noteVersion: memo.version, passageHash: hashPassage(salt, passage), salt, passageLength: passage.length, createdAt: now });
  }
  audit(dbCtx, userId, workspaceId, 'protected_add', memoId, null, 0);
  return created;
}

export function removeProtectedSection(dbCtx: DatabaseContext, memoId: string, sectionId: string, userId: string, workspaceId: string): boolean {
  const result = dbCtx.db
    .delete(aiNoteProtectedSections)
    .where(and(eq(aiNoteProtectedSections.id, sectionId), eq(aiNoteProtectedSections.memoId, memoId)))
    .run();
  if (result.changes > 0) audit(dbCtx, userId, workspaceId, 'protected_remove', memoId, null, 0);
  return result.changes > 0;
}

export interface RedactionResult {
  text: string;
  redactedBytes: number;
  /** True when a recorded protected passage could no longer be located in the current content — fail closed. */
  stale: boolean;
}

/**
 * Redact protected passages from note content before any outbound send.
 *
 * Fail-closed rule (handoff §2.5): if a recorded protected passage can no
 * longer be found in the current note content (user edited it away, offsets
 * drifted), the ENTIRE note is withheld rather than risking a leak.
 * The frontend asks the user to refresh its protections in that case.
 */
export function redactProtectedSections(dbCtx: DatabaseContext, memoId: string, content: string): RedactionResult {
  const sections = listProtectedSections(dbCtx, memoId);
  if (sections.length === 0) return { text: content, redactedBytes: 0, stale: false };
  let text = content;
  let redacted = 0;
  for (const section of sections) {
    // Locate the passage: we re-derive candidate substrings by length and
    // compare salted hashes — the passage text itself is not stored.
    const len = section.passageLength;
    let found = false;
    if (len > 0 && len <= text.length) {
      for (let start = 0; start + len <= text.length; start++) {
        const candidate = text.slice(start, start + len);
        if (hashPassage(section.salt, candidate) === section.passageHash) {
          text = text.slice(0, start) + '[REDACTED]' + text.slice(start + len);
          redacted += len;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      return { text: '', redactedBytes: 0, stale: true };
    }
  }
  return { text, redactedBytes: redacted, stale: false };
}

// ---------------------------------------------------------------------------
// Best-effort secret scanner (handoff §2.5)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'openai_key', regex: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: 'nvidia_key', regex: /nvapi-[A-Za-z0-9_-]{16,}/g },
  { name: 'google_key', regex: /AIza[A-Za-z0-9_-]{20,}/g },
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{12,}/g },
  { name: 'private_key_block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'bearer', regex: /[Bb]earer\s+[A-Za-z0-9._~-]{16,}/g },
  {
    name: 'credential_assignment',
    regex: /(?:api[_-]?key|secret|token|passwd|password|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi,
  },
  { name: 'github_token', regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'slack_token', regex: /xox[abposr]-[A-Za-z0-9-]{10,}/g },
];

export interface SecretScanResult {
  text: string;
  matches: Array<{ name: string; count: number }>;
  redactedBytes: number;
}

/**
 * Best-effort credential redaction. NOT a guarantee — the explicit `blocked`
 * policy and protected passages are the hard boundaries; this scanner is an
 * additional safety net for common formats before outbound sends.
 */
export function scanAndRedactSecrets(text: string): SecretScanResult {
  let out = text;
  const matches: Array<{ name: string; count: number }> = [];
  let redacted = 0;
  for (const pattern of SECRET_PATTERNS) {
    const found = out.match(pattern.regex);
    if (found && found.length > 0) {
      redacted += found.reduce((sum, m) => sum + m.length, 0);
      out = out.replace(pattern.regex, '[REDACTED]');
      matches.push({ name: pattern.name, count: found.length });
    }
  }
  return { text: out, matches, redactedBytes: redacted };
}

/** Client-side hint mirror: detect likely secrets in user-typed chat text (warning only). */
export function containsLikelySecret(text: string): boolean {
  // SECRET_PATTERNS are global regexes for replace(); .test() on a /g regex
  // mutates lastIndex and can miss the same secret on a later invocation.
  return SECRET_PATTERNS.some((p) => {
    p.regex.lastIndex = 0;
    const detected = p.regex.test(text);
    p.regex.lastIndex = 0;
    return detected;
  });
}

// ---------------------------------------------------------------------------
// Bounded excerpt + outbound assembly
// ---------------------------------------------------------------------------

export interface PreparedNoteContent {
  memoId: string;
  version: number;
  title: string;
  /** Redacted, size-bounded content ready for an LLM prompt. */
  excerpt: string;
  redactedBytes: number;
  truncated: boolean;
  /** True when the note must be withheld entirely (stale protections). */
  withheld: boolean;
  withheldReason?: string;
}

export const MAX_EXCERPT_CHARS = 12_000;

/**
 * The ONLY sanctioned path from a stored note to provider-bound text:
 * fresh DB read (never client-sent content) → policy check → protected
 * passage redaction (fail closed) → best-effort secret scan → size bound.
 */
export function prepareNoteForProvider(
  dbCtx: DatabaseContext,
  input: { memoId: string; workspaceId: string; grant: GrantRecord; maxChars?: number }
): PreparedNoteContent {
  const memo = getMemoById(dbCtx, input.memoId, input.workspaceId);
  if (!memo) {
    return { memoId: input.memoId, version: 0, title: '', excerpt: '', redactedBytes: 0, truncated: false, withheld: true, withheldReason: 'note_not_found' };
  }
  // Policy is re-checked here — a blocked flag set between grant issuance and
  // this call revokes the ability to send, even with a formerly-live grant.
  const policy = getNoteAiAccess(dbCtx, input.memoId, input.workspaceId);
  if (policy === 'blocked') {
    return { memoId: input.memoId, version: memo.version, title: '', excerpt: '', redactedBytes: 0, truncated: false, withheld: true, withheldReason: 'blocked' };
  }
  if (memo.version !== input.grant.noteVersion) {
    return { memoId: input.memoId, version: memo.version, title: '', excerpt: '', redactedBytes: 0, truncated: false, withheld: true, withheldReason: 'version_changed' };
  }

  let combined = '';
  if (typeof memo.title === 'string' && memo.title.trim()) combined += `Title: ${memo.title}\n\n`;
  combined += memo.content ?? '';
  if (Array.isArray(memo.checklistData) && memo.checklistData.length > 0) {
    combined +=
      '\n\nChecklist:\n' +
      memo.checklistData.map((item) => `- [${item.checked || item.completed ? 'x' : ' '}] ${String(item.text ?? '')}`).join('\n');
  }

  const protectResult = redactProtectedSections(dbCtx, input.memoId, combined);
  if (protectResult.stale) {
    return {
      memoId: input.memoId,
      version: memo.version,
      title: '',
      excerpt: '',
      redactedBytes: 0,
      truncated: false,
      withheld: true,
      withheldReason: 'protections_stale',
    };
  }
  const secretResult = scanAndRedactSecrets(protectResult.text);
  // Never return the raw title separately: titles can contain credentials or
  // protected passages too. Extract the already-redacted title from the same
  // sanitized payload used for the excerpt.
  const hadTitle = typeof memo.title === 'string' && memo.title.trim().length > 0;
  const safeTitle = hadTitle
    ? (secretResult.text.startsWith('Title: ')
        ? secretResult.text.slice('Title: '.length).split('\n\n', 1)[0]
        : '[REDACTED]')
    : '';
  const maxChars = input.maxChars ?? MAX_EXCERPT_CHARS;
  const truncated = secretResult.text.length > maxChars;
  const excerpt = truncated ? `${secretResult.text.slice(0, maxChars)}\n[... excerpt truncated ...]` : secretResult.text;

  return {
    memoId: input.memoId,
    version: memo.version,
    title: safeTitle,
    excerpt,
    redactedBytes: protectResult.redactedBytes + secretResult.redactedBytes,
    truncated,
    withheld: false,
  };
}

// ---------------------------------------------------------------------------
// Audit (no note text, no secrets — counters and IDs only)
// ---------------------------------------------------------------------------

export function audit(
  dbCtx: DatabaseContext,
  userId: string,
  workspaceId: string,
  event: string,
  memoId: string | null,
  provider: string | null,
  redactedBytes: number
): void {
  try {
    dbCtx.db.insert(aiAccessAudit).values({
      id: crypto.randomUUID(),
      userId,
      workspaceId,
      event,
      memoId,
      provider,
      redactedBytes,
      createdAt: Date.now(),
    }).run();
  } catch {
    // Audit is best-effort; it must never break the privacy pipeline itself.
  }
}

/** Cleanup for account deletion (call alongside FK cascades). */
export function purgeUserData(dbCtx: DatabaseContext, userId: string): void {
  dbCtx.sqlite.prepare('DELETE FROM ai_access_audit WHERE user_id = ?').run(userId);
  dbCtx.sqlite.prepare('DELETE FROM ai_note_protected_sections WHERE created_by = ?').run(userId);
  // Conversations, messages, requests, proposals, grants, provider configs
  // cascade via user_id FK ON DELETE CASCADE when the user row is removed.
  dbCtx.sqlite.prepare('UPDATE ai_note_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), userId);
}
