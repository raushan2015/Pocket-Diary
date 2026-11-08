# Pocket Diary AI Assistant

A privacy-first AI assistant built into Pocket Diary (web + native mobile). It supports
**bring-your-own keys** for OpenAI, Google Gemini, DeepSeek and NVIDIA NIM, persistent
conversations, note creation/updates through human-approved proposals, per-note AI
privacy controls, and a strict two-stage search design that keeps private note content
away from external providers.

Last verified against the repository: 2026-11-08 (see "Verification status" below).

---

## 1. What users can do

| Feature | Where |
| --- | --- |
| Configure AI providers (BYOK, multiple per provider, one default) | Top-nav sparkle icon → gear, or mobile Settings → AI Providers |
| Persistent AI chat (server-side, survives hide/refresh/new devices) | Sparkle icon in the top navbar (web) or the AI tab (mobile) |
| General brainstorming with no notes shared | Default chat scope: "General chat — no notes shared" |
| Turn a conversation into a properly structured note | Model drafts → you review a preview → **Create note** / **Cancel** |
| Optional auto-save of explicitly requested notes | Chat header → conversation settings (per conversation) |
| "Save conversation as note" | Chat footer button |
| Summarize / improve the **open** note | Chat footer buttons — requires an explicit, short-lived grant |
| Per-note AI privacy: `blocked` / `current_only` / `search_allowed` | Editor toolbar → **🔒 AI**, or native note editor shield icon |
| Protected passages ("never share with AI") | Same modal — passages are stored as salted hashes only |
| AI-assisted search over thousands of notes | Chat → **Find a note / AI Search** (two-stage, see below) |

## 2. The privacy model (enforced on the server)

Everything below is **backend-enforced**; UI buttons are conveniences, not the boundary.

1. **Authorization is server-owned.** The model's output and browser-supplied IDs are
   untrusted. A model cannot grant itself note access, approve changes, change policy,
   choose outbound URLs, or execute queries.
2. **Per-note policy** (`memos.ai_access`):
   - `blocked` — content AND identifying metadata never reach an external model.
     Overrules everything (open note, search, folder, tool calls, prior chats).
   - `current_only` (default for all notes, old and new) — content is sent only for an
     explicit user-initiated current-note task backed by a live, server-validated grant
     (15-minute TTL, bound to user + conversation + note version).
   - `search_allowed` — opt-in to cross-note AI search **analysis**; external reading
     still requires per-task selection, preview, and consent.
3. **Two-stage search.**
   - **Stage A (discovery):** the model sees only your query text and may suggest better
     phrases. The actual search runs locally on SQLite FTS5 and results go **only to
     your browser** — never into any LLM-visible structure. Blocked notes may appear in
     your own local results, flagged "Blocked"; their titles/snippets/counts never
     reach the provider.
   - **Stage B (consented reading):** you select notes, review redacted previews, and
     approve exactly that set. Only `search_allowed` notes are eligible. Short-lived
     grants (10 min) are created; every outbound use re-validates them.
4. **Redaction pipeline** (every outbound send): fresh DB read → policy check →
   protected-passage redaction (fail closed on stale) → best-effort secret scanner →
   bounded excerpts. Protected passages become `[REDACTED]`. If a protection can no
   longer be located in the current note, the **entire note is withheld**.
5. **Credentials.** API keys are encrypted at rest with AES-256-GCM
   (`AI_CREDENTIAL_ENCRYPTION_KEY`, outside SQLite/Git), bound per record to
   user+config+provider via AAD, decrypted only during provider calls, never returned
   by any API (masked last-4 only), never logged, never sent to the browser or device.
   A server without the key disables AI credentials safely (503 + operator hint) and
   note-taking is unaffected.
6. **Provider calls.** All run from the Fastify backend to fixed, vetted HTTPS
   endpoints. No user/model-supplied base URLs; `redirect: 'error'`; timeouts; retries
   never repeat tool side-effects. (Non-production test overrides only:
   `AI_OPENAI_BASE_URL` etc. are honored solely when `NODE_ENV !== 'production'`.)
7. **Provenance-filtered context.** Messages that were derived from note content keep
   working in the UI but are excluded from NEW model context once their grant expires,
   is revoked, or the note changes. Switching providers never re-transmits prior
   note-derived text without renewed authorization.
8. **Revocation.** Blocking a note revokes its live grants immediately; an in-flight
   job stops at the next tool step. Already-sent material is disclosed as
   non-retractable (the UI tells you this honestly).

## 3. API surface (`/api/v1/ai`, all authenticated)

```
GET    /ai/providers                      list user configs (masked keys) + vault status
POST   /ai/providers                      add config (key encrypted at rest)
PATCH  /ai/providers/:id                  update label/model/key/default (owner-only)
DELETE /ai/providers/:id                  delete config (owner-only)
POST   /ai/providers/:id/test             connection test (scrubbed errors, includes HTTP status)
GET    /ai/providers/:id/models           model listing with the stored key
POST   /ai/providers/models-preview       model listing for an UNSAVED key (used once in memory, never stored)
POST   /ai/conversations                  create conversation (workspace membership)
GET    /ai/conversations?workspaceId=…    paginated history (user-only)
GET    /ai/conversations/:id              conversation + message page (owner-only)
PATCH  /ai/conversations/:id              rename / auto-save preference
DELETE /ai/conversations/:id              delete (+ cascade)
POST   /ai/conversations/:id/messages     persist message + start durable job (202 + requestId)
POST   /ai/conversations/:id/save-as-note save transcript as a note (write roles)
GET    /ai/requests/:id                   job status (recovery/reconciliation)
GET    /ai/requests/:id/events            SSE stream (Last-Event-ID reconnect)
POST   /ai/requests/:id/cancel            cooperative cancellation
POST   /ai/search                         stage A — LOCAL search, browser-only results
POST   /ai/search/preview                 stage B step 1 — redacted previews
POST   /ai/search/approve                 stage B step 2 — consent grants
POST   /ai/current-note/grant             15-min task-scoped current-note grant
PATCH  /ai/memos/:id/privacy              set per-note AI policy (edit roles)
PUT    /ai/memos/:id/protected-sections   add/remove protected passages (salted hashes)
GET    /ai/memos/:id/protected-sections   list protections + current policy
GET    /ai/proposals/:id                  inspect a drafted proposal
POST   /ai/proposals/:id/approve          execute exactly once (transactional)
POST   /ai/proposals/:id/reject           reject; nothing is written
```

Full request/response schemas are in the generated OpenAPI reference at `/docs`
(no secrets ever enter the spec — enforced by `backend/test/docs.test.ts`).

## 4. Database

Migration **v5** (idempotent, `PRAGMA user_version` gated, preserves all data):

- `memos.ai_access` — backfilled `current_only` for every existing note.
- `ai_provider_configs`, `ai_conversations`, `ai_messages`, `ai_requests`,
  `ai_action_proposals`, `ai_note_grants`, `ai_note_protected_sections`,
  `ai_access_audit`.

**Before migrating a production instance:** back up the database (the existing backup
service snapshots cover this) — standard pre-migration precaution; the migration is
additive and idempotent.

## 5. Deployment / operations

1. Generate a key: `openssl rand -hex 32` and set `AI_CREDENTIAL_ENCRYPTION_KEY`
   (compose passthrough and `.env.example` are prepared). Rotation: set
   `"NEW,OLD"` — new records use the first key; old records still decrypt.
2. Restart. Verify `/health`, then AI Settings in the app.
3. Without the key: AI credential endpoints answer 503 with operator guidance;
   notes/chat-without-provider keep working.

## 6. Verification status (2026-11-08)

Automated, all passing at delivery time:

- **Backend (vitest): 199/199** — includes 53 new AI tests:
  - `ai-migration` (fresh + legacy DBs, cascade, idempotency),
  - `ai-providers` (vault crypto, AAD, tamper, masked keys, plaintext-at-rest absence,
    live mock connection tests + model listing, 503 without vault key),
  - `ai-chat` (persistence, idempotency, proposal→approve→exactly-one-note, auto-save,
    viewer denial, stream-drop honesty, transcript save, restart recovery),
  - `ai-privacy-security` (the §8 matrix: isolation 401/403/404, general chat sends no
    note content, blocked-note invisibility across open/search/tool-call paths,
    stale-protection fail-closed, secret redaction — asserted against the provider
    mock's recorded bodies, revocation mid-flight, provider switching without
    re-transmission, forged-ID denials),
  - `ai-search` (2,000-note scale + pagination + injection resistance + eligibility),
  - `ai-proposals` (conflict 409 without overwrite, expiry, cross-user/workspace).
- **Mobile (vitest): 78/78** — includes 8 new AI contract tests.
- **Web unit tests** (i18n, markdown XSS, md-import): passing; `ai.*` keys complete in
  **en + ja** (113 keys, parity-verified).
- **Backend typecheck (`tsc --noEmit`)** and **mobile typecheck + ESLint**: clean.

Live-provider caveats (no real API keys were available in this environment):

- OpenAI / Gemini / DeepSeek / NVIDIA NIM adapters are verified against protocol-
  accurate mock servers (including malformed responses, 401/429/5xx, timeouts, mid-
  stream drops). **Live vendor behavior (exact streaming event shapes, rate-limit
  headers, model catalogs) is unverified** — run one real connection test per provider
  before relying on it in production.
- The e2e journey (`tests/e2e/22-ai-assistant.test.js`) runs against a local mock
  provider (`scripts/ai-mock-provider.mjs`); CI is wired to start it. Without the
  mock, the journey skips AI assertions with a clear notice.

## 7. Known limitations (v1)

- No Sensitive Vault (explicitly out of scope for v1; note storage is ordinary SQLite,
  and a `blocked` flag is disclosure control, not encryption).
- The secret scanner is best-effort; the `blocked` policy and protected passages are
  the hard boundaries.
- SSE replay buffers live in memory (single-instance deployments); a multi-instance
  deployment would move event buffering to a shared store.
- Auto-save applies to explicit `draft_new_note` tool calls; the model is instructed to
  call it only on explicit requests (belt-and-braces: preview + approval remain the
  default path).
- Deleting a conversation keeps already-shared third-party content with the provider —
  disclosure of already-sent text cannot be retracted; the UI states this.
