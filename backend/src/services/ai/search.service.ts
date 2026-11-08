/**
 * AI-assisted note search — STRICT two-stage design (handoff §2.4).
 *
 * Stage A (privacy-preserving discovery):
 *  - The external model may receive ONLY the user-written search request,
 *    to propose better search phrases/synonyms/date hints.
 *  - The actual search runs LOCALLY on our own SQLite FTS5 index with
 *    workspace membership enforced server-side. Results are returned ONLY
 *    to the authorized user's browser — never to a provider, and never as
 *    a tool response.
 *  - Blocked/current-only notes that match remain visible in the USER's
 *    ordinary local results (their own data, their own screen) but are
 *    flagged `llmEligible: false` and are structurally excluded from every
 *    LLM-visible structure.
 *
 * Stage B (consented reading):
 *  - Only notes whose policy is exactly `search_allowed` may be considered,
 *    and only after the user selects them in a preview and approves.
 *  - Backed by short-lived grants (see privacy.service + routes).
 */
import { buildFtsQuery } from '../memo.service.js';
import { getNoteAiAccess } from './privacy.service.js';
import type { DatabaseContext } from '../../db/index.js';

export interface AiSearchHit {
  id: string;
  title: string;
  /** Short local snippet for the human UI. Never attached to any LLM-visible structure. */
  snippet: string;
  updatedAt: number;
  /** Whether this note MAY be selected for Stage B consented reading. */
  llmEligible: boolean;
  /** Why not eligible (shown to the user only). */
  eligibility: 'search_allowed' | 'blocked' | 'current_only';
  /** Never sent to a provider; UI-only reference link. */
  workspaceId: string;
}

export interface AiSearchResult {
  hits: AiSearchHit[];
  total: number;
  page: number;
  limit: number;
  /** Local execution status the chat may relay verbatim (no inference about private matches). */
  executed: boolean;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'my', 'is', 'it', 'that', 'this', 'was', 'i']);

/**
 * Expand a user query into bounded local search variants (safe, local-only):
 * original query + a trimmed keyword variant. Hard-capped so the model or a
 * malicious query cannot blow up the DB with unbounded expansions.
 */
export function expandQueryLocally(query: string, modelSuggestedPhrases: string[] = []): string[] {
  const variants: string[] = [];
  const push = (q: string) => {
    const trimmed = String(q ?? '').trim().slice(0, 200);
    if (trimmed && !variants.includes(trimmed)) variants.push(trimmed);
  };
  push(query);
  const tokens = query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t && !STOPWORDS.has(t));
  if (tokens.length > 1) {
    push(tokens.join(' '));
  }
  for (const phrase of modelSuggestedPhrases.slice(0, 3)) {
    push(phrase);
  }
  return variants.slice(0, 5);
}

interface RawRow {
  id: string;
  title: string;
  content: string;
  updated_at: number;
  workspace_id: string;
  ai_access: string;
  snippet_text?: string;
}

/**
 * Local, workspace-scoped FTS search. This reads private note text but its
 * return value is PRIVATE to the authorized user's response — callers must
 * never forward it to a provider or into any LLM-visible structure.
 */
export function searchNotesLocally(
  dbCtx: DatabaseContext,
  input: { userId: string; workspaceId: string; isMember: boolean; queries: string[]; page?: number; limit?: number }
): AiSearchResult {
  if (!input.isMember) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 });
  }
  const page = Math.max(1, Math.min(10_000, Number(input.page ?? 1)));
  const limit = Math.max(1, Math.min(50, Number(input.limit ?? 25)));
  const offset = (page - 1) * limit;
  const terms = input.queries.slice(0, 5).map(buildFtsQuery).filter((q): q is string => Boolean(q));
  if (terms.length === 0) return { hits: [], total: 0, page, limit, executed: true };

  // Merge every matching note across query variants inside SQLite; do not
  // truncate each variant at 400 rows (that made page 9 falsely empty in a
  // 2,000-note workspace). Fetch note contents for only the requested page.
  // FTS MATCH terms are bound parameters, never interpolated SQL.
  const matchesSql = terms.map(() => `
    SELECT m.id AS id, memos_fts.rank AS relevance
    FROM memos_fts JOIN memos m ON m.rowid = memos_fts.rowid
    WHERE memos_fts MATCH ? AND m.workspace_id = ? AND m.deleted_at IS NULL
  `).join(' UNION ALL ');
  const args = terms.flatMap((term) => [term, input.workspaceId]);
  const cte = `WITH matches AS (${matchesSql}),
    ranked AS (SELECT id, MIN(relevance) AS relevance FROM matches GROUP BY id)`;
  const total = Number((dbCtx.sqlite.prepare(`${cte} SELECT COUNT(*) AS n FROM ranked`).get(...args) as { n: number }).n);
  const pageRows = dbCtx.sqlite.prepare(
    `${cte}
     SELECT m.id, m.title, m.content, m.updated_at, m.workspace_id, m.ai_access
     FROM ranked r JOIN memos m ON m.id = r.id
     ORDER BY r.relevance ASC, m.updated_at DESC, m.id ASC LIMIT ? OFFSET ?`
  ).all(...args, limit, offset) as RawRow[];

  const hits: AiSearchHit[] = pageRows.map((row) => {
    const policy = getNoteAiAccess(dbCtx, row.id, input.workspaceId);
    const firstLine = String(row.content ?? '').split('\n').find((l) => l.trim()) ?? '';
    return {
      id: row.id,
      title: String(row.title ?? ''),
      snippet: firstLine.slice(0, 180),
      updatedAt: Number(row.updated_at ?? 0),
      llmEligible: policy === 'search_allowed',
      eligibility: policy === 'search_allowed' ? 'search_allowed' : policy === 'blocked' ? 'blocked' : 'current_only',
      workspaceId: row.workspace_id,
    };
  });

  return { hits, total, page, limit, executed: true };
}

/**
 * Validate a Stage A reformulation request payload from the model tool:
 * the model may only suggest phrases — bounded, no note IDs, no content.
 */
export function sanitizeModelPhraseSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim().slice(0, 120))
    .filter((p) => p.length >= 2)
    .slice(0, 3);
}
