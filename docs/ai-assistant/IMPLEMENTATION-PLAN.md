# Pocket Diary AI Assistant — Implementation Plan (verified against repo 2026-11-08)

## Verified starting state (Phase 0 discovery)
- Git tree has pre-existing modified/untracked files (ci.yml, Dockerfiles, README, frontend files, i18n.js untracked, docs/…). **All preserved; no reset/clean performed.**
- Backend compiles (`tsc --noEmit` exit 0). Baseline `vitest run`: **19 files / 146 tests pass**.
- Backend: Fastify 5 + better-sqlite3/Drizzle, routes under `/api/v1` (`backend/src/app.ts`, `routes/index.ts`), auth via `fastify.authenticate` (HTTP-only `memo_session` cookie, `request.user`).
- DB: `SCHEMA_VERSION = 4` in `backend/src/db/migrate.ts` (versioned `PRAGMA user_version` steps). FTS5 on memos. Optimistic version on memos; `clientId` idempotent creates.
- RBAC: `verifyWorkspaceMembership(db, userId, workspaceId, [roles])`; owners/admins/editors write, viewers read-only.
- Outbound fetch: `services/safe-fetch.ts` (guardedFetch, pinned-DNS SSRF guard).
- Web: vanilla ES modules; CSP `script-src 'self'`, `connect-src 'self'` (frontend/server.js) → all provider calls MUST be backend-side; SSE via same-origin fetch streaming works.
- Web integration points: `#nav-auth-actions` (add AI button), `#modal-profile` (contains a `<form>` — AI settings must be a separate dialog), `state.js activeMemo`, `markdown.js renderMarkdown` (XSS-safe), `sw.js` CACHE_NAME `notes-v4`, i18n `en`+`ja`.
- Mobile: Expo Router tabs (`notes, reminders, search, settings`), API layer `services/api/{client,endpoints,contracts}.ts` (zod-validated, cookie-token auth), vitest tests in `mobile-apps/test/`.

## Design decisions
1. **Schema v5** migration (idempotent, `user_version` gated): `memos.ai_access` (default `current_only`), `ai_provider_configs`, `ai_conversations`, `ai_messages`, `ai_requests`, `ai_action_proposals`, `ai_note_grants`, `ai_note_protected_sections`, `ai_access_audit`.
2. **Credentials**: AES-256-GCM in `credential-vault.ts`, key from `AI_CREDENTIAL_ENCRYPTION_KEY` (64 hex chars, supports comma-separated versions for rotation), AAD binds user/config/provider. Missing key → AI config endpoints return 503 with operator guidance; note-taking unaffected.
3. **Providers**: fixed HTTPS endpoints compiled into adapters (no user-supplied baseUrl; non-production env overrides only for tests). OpenAI → Responses API (`/v1/responses`, SSE, server-executed tools). Gemini → native `v1beta …:streamGenerateContent?alt=sse` + functionDeclarations. DeepSeek → `api.deepseek.com/chat/completions` (OpenAI-compatible tools/stream). NVIDIA NIM → `integrate.api.nvidia.com/v1/chat/completions`.
4. **Jobs**: `ai_requests` rows + in-process async runner. Close drawer ≠ cancel. Boot recovery marks orphaned `running/queued` requests `interrupted`. SSE endpoint `GET /ai/requests/:id/events` + polling `GET /ai/requests/:id`.
5. **Privacy pipeline** (every outbound send): server-side grant validation → fresh DB read (never client content) → ai_access policy check → protected-section redaction (fail closed on stale hash) → secret scanner (best-effort) → bounded excerpts.
6. **Search**: Stage A = model sees only the user's query text (phrase suggestions); local FTS returns results to the browser only. Stage B = preview → approve → short-lived grants over `search_allowed` notes only, redacted bounded excerpts.
7. **Proposals**: validated JSON payloads; one-time transactional approve via existing `createMemo`/`updateMemo` (actor = user, workspace write check, optimistic version, 409 conflict handling).

## Phases & exit gates
- P1 schema+providers; P2 chat backend+drawer; P3 note proposals; P4 active-note privacy; P5 two-stage search; P6 mobile; P7 verification/docs.
