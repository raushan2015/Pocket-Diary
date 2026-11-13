# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Pocket Diary** is a self-hosted, responsive note-taking application with workspaces, AI assistant, reminders, and attachments. It consists of:
- **Frontend** (`/frontend`) — Single-page web interface (vanilla JS, HTML, CSS)
- **Backend** (`/backend`) — Fastify API with SQLite/Drizzle ORM (TypeScript)
- **Tests** (`/tests`) — Playwright e2e tests + backend unit/integration tests (vitest)
- **Mobile** (`/mobile-apps`) — Expo/React Native app (TypeScript)

## Key Commands

### Docker (Production)
```bash
# Start
docker compose up -d --build

# Stop (preserves data)
docker compose down

# Logs
docker compose logs -f memo-manager

# Health check
curl http://localhost:8080/health
```

### Backend Development
```bash
cd backend
npm ci           # Install deps
npm run dev      # Dev server with tsx watch
npm run build    # TypeScript compile
npm test         # Run vitest tests
```

### Frontend Development
```bash
cd frontend
npm run dev      # Serves on port 8080 (server.js)
npm run build    # Vite production build (outputs to dist/)
npm run tokens   # Regenerate tokens.css from design-tokens.json
```

### E2E Tests (Playwright)
```bash
cd tests
npm ci
npx playwright install chromium
BASE_URL=http://127.0.0.1:8080 npm test
```

### Mobile App
```bash
cd mobile-apps
npm ci
npm run test     # vitest
```

## Architecture

### Backend (`backend/src/`)
- **Entry**: `index.ts` → builds Fastify app, starts backup/reminder schedulers
- **Config**: `config.ts` — env-driven, validates `COOKIE_SECRET`, `APP_URL` (required in prod)
- **App**: `app.ts` — registers plugins (cookie, cors, rate-limit, multipart, swagger), auth, routes; adds CSP headers for frontend routes
- **DB**: `db/schema.ts` (Drizzle), `db/migrate.ts` (migrations), `db/index.ts` (connection)
- **Routes** (`routes/`): auth, memos, folders, categories, tags, workspaces, invites, notifications, push, migration, attachments, system, ai
- **Services** (`services/`): auth, memo, workspace, invite, notification, backup, mailer, push, ai (providers, chat, search, privacy, tools), migration, etc.
- **OpenAPI**: `openapi.ts` — generated from route schemas, served at `/docs`

### Frontend (`frontend/`)
- **Entry**: `index.html`, `server.js` (dev server + reverse proxy)
- **Build**: Vite (`vite.config.ts`) — code-splitting, CSS/JS minification, sourcemaps
- **Design Tokens**: `design-tokens.json` (source of truth) → generates `css/tokens.css` via `node scripts/generate-tokens.js`
- **JS modules** (`js/`): app.js, app-events.js, editor.js, sidebar.js, auth.js, api.js, i18n.js, ai-chat.js, ai-settings.js, markdown.js, memo-renderer.js, keep-*.js (Google Keep import), and more
- **CSS** (`css/`): components.css, layout.css, editor.css, ai-chat.css, landing.css, tokens.css (generated), auth.css, attachments.css

### Key Design Decisions
1. **Single-instance only** — SQLite WAL mode + local attachments; horizontal scaling requires PostgreSQL + S3 migration (see README "Operational limits")
2. **Cookie-based sessions** — HTTP-only, SameSite=Lax, server-side SHA-256 hash storage; password change revokes all sessions
3. **Tenant-aware** — Workspace membership (owner/admin/editor/viewer) enforced server-side
4. **AI privacy model** — Per-note `ai_access` (`blocked`/`current_only`/`search_allowed`), protected passages (salted hashes), two-stage search (local FTS → consented reading), keys encrypted at rest (AES-256-GCM)
5. **OpenAPI served in prod** — unless `DOCS_ENABLED=false`; spec never contains secrets (verified by `backend/test/docs.test.ts`)

## Environment Variables

Required: `COOKIE_SECRET` (32+ chars, `openssl rand -hex 32`)
AI: `AI_CREDENTIAL_ENCRYPTION_KEY` (32+ chars)
Optional: `APP_URL` (required in prod), `SMTP_*`, `VAPID_*`, `BACKUP_REPLICATION_DIR`, `DOCS_ENABLED`, `CORS_ORIGINS`, `TRUST_PROXY`, `STORAGE_QUOTA_GB`

AI Provider Overrides (non-production only):
- `AI_OPENAI_BASE_URL`, `AI_GEMINI_BASE_URL`, `AI_DEEPSEEK_BASE_URL`, `AI_NVIDIA_BASE_URL`, `AI_ANTHROPIC_BASE_URL`, `AI_MISTRAL_BASE_URL`, `AI_GROQ_BASE_URL`, `AI_OPENROUTER_BASE_URL`, `AI_OLLAMA_BASE_URL`
- `OLLAMA_BASE_URL` — default Ollama endpoint (default: `http://host.docker.internal:11434`)

## Testing Notes

- **Backend**: `npm test` in `/backend` — 223 tests including AI (53 tests) and new provider adapters
- **E2E**: Playwright against running instance — creates test accounts, **never point at production**
- **Mobile**: `npm test` in `/mobile-apps` — 78 tests

## Database

- SQLite at `/app/data/memo_manager.db` (Docker volume `memo_manager_data`)
- Drizzle ORM with `better-sqlite3` driver
- Migrations in `backend/src/db/migrate.ts` (idempotent, `PRAGMA user_version` gated)
- WAL mode enabled for concurrency

## AI Assistant

See `docs/ai-assistant/README.md` for full architecture. Key files:
- Backend: `backend/src/services/ai/` (provider configs, chat, search, privacy, grants, tools)
- Routes: `backend/src/routes/ai.ts`
- Frontend: `frontend/js/ai-chat.js`, `frontend/js/ai-settings.js`, `frontend/js/ai-privacy.js`

Providers: OpenAI, Gemini, DeepSeek, NVIDIA NIM, Anthropic (Claude), Mistral AI, Groq, OpenRouter, Ollama (local) — all BYOK, multiple configs per provider.

AI Tools (server-side, authorization-enforced):
- `search_notes` — local SQLite FTS search, results to browser only
- `read_note` — requires valid grant (current-note or search-excerpts)
- `create_note` / `update_note` — create proposals for user approval
- `list_workspaces` / `list_folders` / `list_categories` — workspace browsing