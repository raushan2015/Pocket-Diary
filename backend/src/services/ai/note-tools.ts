/**
 * Allowlisted AI tools (handoff §5 "Tool-execution boundary").
 *
 * Hard rules enforced here on EVERY invocation:
 *  - The user identity comes from the authenticated session, never from the
 *    model.
 *  - A model-provided noteId or workspaceId is NEVER an authorization grant.
 *    Reading uses only server-issued, live, task-scoped grants; writes go
 *    through validated proposals that humans approve.
 *  - `search_my_notes` returns a STATUS to the model — the actual local
 *    search results travel to the user's browser only, never into any
 *    LLM-visible structure.
 *  - No delete/trash/move/bulk tools exist in v1.
 */
import type { DatabaseContext } from '../../db/index.js';
import {
  getLiveGrant,
  prepareNoteForProvider,
  audit,
  type GrantRecord,
} from './privacy.service.js';
import { searchNotesLocally, sanitizeModelPhraseSuggestions, expandQueryLocally } from './search.service.js';
import { createProposal } from './proposal.service.js';

/** Tool definitions exposed to providers (JSON Schema parameters). */
export const AI_TOOL_DEFINITIONS = [
  {
    name: 'draft_new_note',
    description:
      'Draft a NEW structured note for the user to review. Use ONLY when the user explicitly asks to create/save a note from the conversation. The note is shown as a preview first; the user approves saving. Do not call this for ordinary brainstorming.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 200 },
        content: { type: 'string', description: 'Well-structured markdown: overview, requirements, stages, checklist, open questions. Mark suggestions and unconfirmed items clearly.' },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 30 },
        checklistData: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, text: { type: 'string' }, checked: { type: 'boolean' } },
            required: ['id', 'text'],
            additionalProperties: false,
          },
        },
        noteType: { type: 'string', enum: ['text', 'checklist'] },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'draft_note_update',
    description:
      'Draft an update to the CURRENTLY AUTHORIZED note only. Available only when the user explicitly opened a note-assistance task. Produces a preview diff the user must approve.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 200 },
        content: { type: 'string', description: 'The complete new note content after the requested change.' },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 30 },
        checklistData: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, text: { type: 'string' }, checked: { type: 'boolean' } },
            required: ['id', 'text'],
            additionalProperties: false,
          },
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_current_note',
    description: 'Read the redacted content of the note the user explicitly authorized for this task. Takes no parameters — the authorized note is fixed by the server.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'suggest_search_phrases',
    description:
      'Private local note search. Propose 1-3 improved search phrases/synonyms/date hints derived from the user request. The server searches locally; results are shown to the user only — you will never see the results.',
    parameters: {
      type: 'object',
      properties: {
        phrases: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Improved search phrases.' },
      },
      required: ['phrases'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_approved_search_excerpts',
    description:
      'Read bounded, redacted excerpts of notes the user explicitly selected and approved for this task. Only IDs the user approved are readable; all others are denied.',
    parameters: {
      type: 'object',
      properties: {
        noteIds: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      },
      required: ['noteIds'],
      additionalProperties: false,
    },
  },
] as const;

export interface ToolExecutionContext {
  dbCtx: DatabaseContext;
  userId: string;
  workspaceId: string;
  conversationId: string;
  requestId: string;
  provider: string | null;
  /** Live current-note grant for this task, if any. */
  currentNoteGrant: GrantRecord | null;
  /** Live search-excerpt grants (approved note IDs -> grants). */
  searchGrants: Map<string, GrantRecord>;
  autoSaveNotes: boolean;
  /** The user's verbatim search request (Stage A base query) when in search mode. */
  searchBaseQuery: string | null;
  /** Emit a UI-only event (e.g. local search results) to the user's browser. */
  emitUiEvent: (event: string, data: unknown) => void;
}

export interface ToolExecutionOutcome {
  /** Text returned to the model as the tool result. */
  modelResult: string;
  /** Data for persistence/audit (never sent to the model). */
  meta?: Record<string, unknown>;
}

export class ToolDeniedError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolDeniedError';
  }
}

function parseJsonArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new ToolDeniedError('invalid_arguments', 'Tool arguments were not valid JSON');
  }
}

function makeChecklistSafe(raw: unknown): Array<{ id: string; text: string; checked: boolean }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, 500).map((item, idx) => {
    const rec = (item ?? {}) as Record<string, unknown>;
    return {
      id: String(rec.id ?? `chk-${idx}`).slice(0, 64),
      text: String(rec.text ?? '').slice(0, 5000),
      checked: Boolean(rec.checked),
    };
  });
}

/**
 * Execute one allowlisted tool call. Every branch revalidates authorization
 * server-side; nothing trusts model input beyond validated arguments.
 */
export async function executeToolCall(
  ctx: ToolExecutionContext,
  name: string,
  argsRaw: string | undefined
): Promise<ToolExecutionOutcome> {
  switch (name) {
    // ------------------------------------------------------------------
    case 'draft_new_note': {
      const args = parseJsonArgs(argsRaw);
      const payload: Record<string, unknown> = {
        title: String(args.title ?? '').slice(0, 200),
        content: String(args.content ?? '').slice(0, 200_000),
      };
      if (Array.isArray(args.tags)) payload.tags = args.tags;
      const checklist = makeChecklistSafe(args.checklistData);
      if (checklist) payload.checklistData = checklist;
      if (args.noteType === 'checklist' || args.noteType === 'text') payload.noteType = args.noteType;
      const proposal = createProposal(ctx.dbCtx, {
        conversationId: ctx.conversationId,
        userId: ctx.userId,
        // The proposal is bound to the CONVERSATION's workspace — never to a
        // model-supplied workspace id.
        workspaceId: ctx.workspaceId,
        action: 'create',
        payload,
      });
      return {
        modelResult: JSON.stringify({
          ok: true,
          proposalId: proposal.id,
          status: 'pending_user_approval',
          note: 'The drafted note is shown to the user as a preview. It is NOT saved yet.',
        }),
        meta: { proposalId: proposal.id, action: 'create' },
      };
    }

    // ------------------------------------------------------------------
    case 'draft_note_update': {
      if (!ctx.currentNoteGrant || !getLiveGrant(ctx.dbCtx, ctx.currentNoteGrant.id, { userId: ctx.userId, kind: 'current_note' })) {
        throw new ToolDeniedError('no_grant', 'No live current-note grant. Ask the user to authorize note assistance again.');
      }
      const args = parseJsonArgs(argsRaw);
      const payload: Record<string, unknown> = {
        title: String(args.title ?? '').slice(0, 200),
        content: String(args.content ?? '').slice(0, 200_000),
      };
      if (Array.isArray(args.tags)) payload.tags = args.tags;
      const checklist = makeChecklistSafe(args.checklistData);
      if (checklist) payload.checklistData = checklist;
      const proposal = createProposal(ctx.dbCtx, {
        conversationId: ctx.conversationId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        action: 'update',
        targetNoteId: ctx.currentNoteGrant.memoId, // server-derived from the grant
        expectedNoteVersion: ctx.currentNoteGrant.noteVersion,
        payload,
      });
      return {
        modelResult: JSON.stringify({
          ok: true,
          proposalId: proposal.id,
          status: 'pending_user_approval',
          note: 'A before/after preview is shown to the user. Nothing is written until they approve.',
        }),
        meta: { proposalId: proposal.id, action: 'update' },
      };
    }

    // ------------------------------------------------------------------
    case 'read_current_note': {
      if (!ctx.currentNoteGrant) {
        throw new ToolDeniedError('no_grant', 'The user has not authorized reading any note in this conversation.');
      }
      // Revalidate right now (expiry / revocation / version / policy).
      const grant = getLiveGrant(ctx.dbCtx, ctx.currentNoteGrant.id, { userId: ctx.userId, kind: 'current_note' });
      if (!grant) {
        throw new ToolDeniedError('grant_expired', 'The current-note authorization expired or was revoked.');
      }
      const prepared = prepareNoteForProvider(ctx.dbCtx, {
        memoId: grant.memoId,
        workspaceId: ctx.workspaceId,
        grant,
      });
      if (prepared.withheld) {
        audit(ctx.dbCtx, ctx.userId, ctx.workspaceId, 'send_blocked', grant.memoId, ctx.provider, 0);
        if (prepared.withheldReason === 'blocked') {
          throw new ToolDeniedError('note_blocked', 'This note is marked as never shared with AI. Reading is denied.');
        }
        if (prepared.withheldReason === 'protections_stale') {
          throw new ToolDeniedError('protections_stale', 'Protected passages are out of date; the note was withheld for safety. Ask the user to refresh protections.');
        }
        if (prepared.withheldReason === 'version_changed') {
          throw new ToolDeniedError('version_changed', 'The note changed after authorization; re-authorization is required.');
        }
        throw new ToolDeniedError('note_unavailable', 'The note is not available.');
      }
      audit(ctx.dbCtx, ctx.userId, ctx.workspaceId, 'send', grant.memoId, ctx.provider, prepared.redactedBytes);
      return {
        modelResult: JSON.stringify({
          ok: true,
          noteId: prepared.memoId,
          version: prepared.version,
          title: prepared.title,
          content: prepared.excerpt,
          truncated: prepared.truncated,
          redactionNotice: prepared.redactedBytes > 0 ? 'Some passages were replaced with [REDACTED] before you received this content. Never attempt to reconstruct them.' : undefined,
        }),
        meta: { readNoteId: prepared.memoId, redactedBytes: prepared.redactedBytes },
      };
    }

    // ------------------------------------------------------------------
    case 'suggest_search_phrases': {
      const args = parseJsonArgs(argsRaw);
      const phrases = sanitizeModelPhraseSuggestions(args.phrases);
      if (phrases.length === 0) {
        throw new ToolDeniedError('invalid_arguments', 'Provide at least one search phrase.');
      }
      // The model NEVER sees results: they are emitted to the user's browser
      // only, and the tool result is a bare status. The user's own query is
      // the primary search term; model phrases are bounded variants.
      const search = searchNotesLocally(ctx.dbCtx, {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        isMember: true,
        queries: expandQueryLocally(ctx.searchBaseQuery ?? phrases[0] ?? '', phrases),
        limit: 25,
        page: 1,
      });
      ctx.emitUiEvent('search_results', {
        query: ctx.searchBaseQuery ?? phrases[0],
        queries: phrases,
        hits: search.hits, // HUMAN UI only; no model-visible titles/snippets
        total: search.total,
        page: search.page,
        limit: search.limit,
      });
      audit(ctx.dbCtx, ctx.userId, ctx.workspaceId, 'local_search', null, ctx.provider, 0);
      return {
        modelResult: JSON.stringify({
          ok: true,
          status: 'local_search_executed',
          note: 'The search ran locally. Matching notes were shown to the user in their interface. You receive no titles, snippets or counts. If the user wants you to read specific notes, they will explicitly select and approve them.',
        }),
        meta: { searchQueries: phrases },
      };
    }

    // ------------------------------------------------------------------
    case 'read_approved_search_excerpts': {
      const args = parseJsonArgs(argsRaw);
      const requested = Array.isArray(args.noteIds) ? args.noteIds.filter((id): id is string => typeof id === 'string').slice(0, 10) : [];
      if (requested.length === 0) {
        throw new ToolDeniedError('invalid_arguments', 'Provide the approved note IDs to read.');
      }
      const excerpts: Array<Record<string, unknown>> = [];
      for (const noteId of requested) {
        const grant = ctx.searchGrants.get(noteId);
        const live = grant ? getLiveGrant(ctx.dbCtx, grant.id, { userId: ctx.userId, kind: 'search_excerpts' }) : null;
        if (!live) {
          // A forged/unapproved/expired ID is denied individually — no scope creep.
          throw new ToolDeniedError('note_not_approved', `Note ${noteId} was not approved by the user (or approval expired). Reading denied.`);
        }
        const prepared = prepareNoteForProvider(ctx.dbCtx, { memoId: live.memoId, workspaceId: ctx.workspaceId, grant: live, maxChars: 6_000 });
        if (prepared.withheld) {
          if (prepared.withheldReason === 'blocked') {
            throw new ToolDeniedError('note_blocked', `Note ${noteId} is marked as never shared with AI. Reading denied.`);
          }
          if (prepared.withheldReason === 'protections_stale') {
            throw new ToolDeniedError('protections_stale', `Protected passages for note ${noteId} are stale; the note was withheld for safety.`);
          }
          throw new ToolDeniedError('note_unavailable', `Note ${noteId} is not available.`);
        }
        audit(ctx.dbCtx, ctx.userId, ctx.workspaceId, 'send', live.memoId, ctx.provider, prepared.redactedBytes);
        excerpts.push({
          noteId: prepared.memoId,
          version: prepared.version,
          title: prepared.title,
          excerpt: prepared.excerpt,
          truncated: prepared.truncated,
        });
      }
      return {
        modelResult: JSON.stringify({ ok: true, notes: excerpts }),
        meta: { readNoteIds: excerpts.map((e) => e.noteId) },
      };
    }

    default:
      throw new ToolDeniedError('unknown_tool', `Tool "${name}" is not allowlisted and was not executed.`);
  }
}
