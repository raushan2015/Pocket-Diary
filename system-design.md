# Memo Manager SaaS — System Design

Goal: Transform Memo Manager into a secure, multi-user SaaS productivity application while preserving the interface and productivity features.
Written: 2026-10-10 by AI CEO (TECHSHAN AI Office)
Status: plan for this goal — the team builds from this file.

---

## 1. What this goal delivers

### Outcome
A production-ready, multi-user Memo Manager SaaS application deployed as a cohesive single-node service. The system delivers:
1. **Secure Backend Engine**: Fastify + TypeScript + Drizzle ORM + SQLite with Write-Ahead Logging (WAL) and foreign keys enabled.
2. **Authentication & Multi-Tenancy**: Secure `argon2id` password hashing, HTTP-only session cookies, multi-workspace isolation scoped strictly by `workspace_id` with role-based access control (RBAC).
3. **Core Memo Management**: Full CRUD for memos, categories, tags, folders, status transitions (`draft`, `pending`, `in_progress`, `completed`, `archived`), priority levels (`low`, `medium`, `high`, `urgent`), due dates, pinning, favorites, soft delete/restore, and optimistic concurrency versioning.
4. **Instant Search**: Sub-millisecond SQLite FTS5 full-text search indexing memo titles and markdown content.
5. **Local Data Migration**: Ingestion and export endpoints allowing users to migrate legacy browser `localStorage` memo data into their authenticated cloud workspace in a single atomic transaction.
6. **Responsive Web UI**: Preserved Memo Manager productivity interface with dark/light mode, sidebar navigation, real-time filtering, workspace switcher, and authenticated session state.
7. **Verification**: Automated test suites (backend unit & integration tests) and end-to-end browser verification by QA.

### How it will be checked
- Backend unit and route integration tests run and pass (`npm test` in `backend/`).
- Database concurrency and WAL integrity verified under SQLite busy timeout (5000ms).
- QA drives the web application in a headless browser: signs up a new account, logs in, creates memos with categories/tags/priority/due dates, performs FTS search, executes a local data migration import, switches themes, verifies tenant isolation against unauthorized access, and records passing test evidence and screenshots.

### Out of scope (deferred to future phases)
- Real-time multi-cursor collaborative editing (WebSockets/CRDTs).
- Stripe billing and subscription paywalls.
- AI-driven auto-tagging or summarization.

---

## 2. How it worked previously (Legacy Baseline)

Previously, Memo Manager operated purely as a single-device, client-side web application storing unencrypted data in the browser's `localStorage` (documented in `.agents/outputs/memo-manager-backend-architecture.md` and `.agents/memory/memo-manager-stack-decisions.md`).

- **Stack**: Pure browser JavaScript, HTML5, CSS3, `window.localStorage`.
- **Data Location**: Trapped on a single client device with a ~5MB storage ceiling.
- **Security & Multi-Tenancy**: No accounts, no authentication, no permissions, no server-side backup.
- **Data Risk**: Clearing browser cache or switching devices resulted in complete data loss unless manually exported to a JSON file.

Diagram: [Current Legacy Structure](.archify/architecture-memo-manager-legacy-20261010-083500/memo-manager-legacy.html)
*The legacy single-user client-side architecture constrained by local storage and device boundaries.*

---

## 3. What we build

The target SaaS architecture upgrades Memo Manager into a robust client-server architecture with strict tenant boundaries, high-throughput SQLite persistence, and an authenticated modern SPA frontend.

- **Frontend (`frontend/`)**: Modern responsive Single Page Application implementing the visual design system from `frontend.PNG` and `.agents/outputs/memo-manager-frontend-specification.md`. Communicates with the Fastify backend via cookie-authenticated REST APIs. Handles UI state, filter bar, dark/light theme toggle, markdown preview, memo editors, and migration wizard.
- **Backend API Gateway (`backend/`)**: Fastify running on Node.js (LTS) with TypeScript. Handles routing, Ajv/TypeBox input validation at the boundary, session management, and RBAC enforcement.
- **Persistence Layer (`backend/src/db/`)**: Drizzle ORM backed by `better-sqlite3`. SQLite configured with WAL journal mode (`PRAGMA journal_mode = WAL;`), `PRAGMA busy_timeout = 5000;`, `PRAGMA foreign_keys = ON;`, and FTS5 virtual table for full-text search.
- **Data Migration (`backend/src/routes/migration.ts`)**: Ingestion service that parses legacy client-side export formats and bulk-inserts categories, tags, and memos within an atomic database transaction.

Diagram: [Target SaaS Structure](.archify/architecture-memo-manager-target-20261010-083500/memo-manager-target.html)
*The multi-user SaaS architecture showing browser client, Fastify API, session auth, tenant isolation perimeter, Drizzle ORM, SQLite WAL, FTS5, and backup engine.*

---

## 4. The contract between the parts

### 4.1 Folder Organization
- `backend/`: Server-side application, TypeScript source, Drizzle schema, SQLite database, and integration tests.
- `frontend/`: Web client application, HTML, CSS, JavaScript/TypeScript client logic, assets, and UI components.
- `tests/`: End-to-end and QA test suite (Playwright verification scripts, fixtures, integration test runners).

### 4.2 Authentication & Session API (`/api/v1/auth`)
Session identity is passed via an HTTP-only, secure, `SameSite=Lax` cookie named `memo_session`.

- **`POST /api/v1/auth/register`**
  - **Body**: `{ "email": "string", "password": "string", "name": "string" }`
  - **Logic**: Hashes password using `argon2id` (or `crypto.scrypt`), inserts record in `users`, generates default personal workspace in `workspaces`, links user in `workspace_members` with role `owner`, creates session token in `sessions`.
  - **Response `201`**: `{ "user": { "id": "uuid", "email": "string", "name": "string" }, "workspace": { "id": "uuid", "name": "string", "slug": "string" } }`
  - **Sets Cookie**: `memo_session=<token>; HttpOnly; Path=/; SameSite=Lax`

- **`POST /api/v1/auth/login`**
  - **Body**: `{ "email": "string", "password": "string" }`
  - **Logic**: Validates credentials using timing-safe comparison, creates new session token in `sessions`.
  - **Response `200`**: `{ "user": { "id": "uuid", "email": "string", "name": "string" }, "activeWorkspace": { "id": "uuid", "name": "string" } }`
  - **Sets Cookie**: `memo_session=<token>; HttpOnly; Path=/; SameSite=Lax`

- **`POST /api/v1/auth/logout`**
  - **Logic**: Deletes current session from `sessions` table.
  - **Response `200`**: `{ "success": true }`
  - **Clears Cookie**: `memo_session=; Max-Age=0`

- **`GET /api/v1/auth/me`**
  - **Logic**: Checks `memo_session` cookie against `sessions` table.
  - **Response `200`**: `{ "user": { "id": "uuid", "email": "string", "name": "string" }, "workspaces": [{ "id": "uuid", "name": "string", "role": "string" }] }`
  - **Response `401`**: `{ "error": "Unauthorized", "message": "Authentication required" }`

### 4.3 Workspace API (`/api/v1/workspaces`)
- **`GET /api/v1/workspaces`**: List workspaces accessible to current user.
- **`POST /api/v1/workspaces`**: Create new workspace `{ "name": "string", "slug": "string" }`.

### 4.4 Memo Management API (`/api/v1/memos`)
All memo operations require an active session and membership in the target workspace.

- **`GET /api/v1/memos`**
  - **Query Params**: `workspaceId` (required), `status`, `priority`, `categoryId`, `tagId`, `isFavorite`, `isPinned`, `search`, `page` (default 1), `limit` (default 50), `sortBy`, `sortOrder`.
  - **FTS Search**: If `search` is provided, queries `memos_fts` JOIN `memos` with `bm25()` rank.
  - **Response `200`**:
    ```json
    {
      "memos": [
        {
          "id": "uuid",
          "workspaceId": "uuid",
          "title": "string",
          "content": "string",
          "priority": "low | medium | high | urgent",
          "status": "draft | pending | in_progress | completed | archived",
          "isFavorite": false,
          "isPinned": false,
          "dueDate": 1728556800000,
          "categoryId": "uuid | null",
          "category": { "id": "uuid", "name": "string", "color": "string" },
          "tags": ["tag1", "tag2"],
          "version": 1,
          "createdAt": 1728550000000,
          "updatedAt": 1728550000000
        }
      ],
      "total": 12,
      "page": 1,
      "limit": 50
    }
    ```

- **`POST /api/v1/memos`**
  - **Body**:
    ```json
    {
      "workspaceId": "uuid",
      "title": "string",
      "content": "string",
      "priority": "low | medium | high | urgent",
      "status": "draft | pending | in_progress | completed | archived",
      "isFavorite": false,
      "isPinned": false,
      "dueDate": 1728556800000,
      "categoryId": "uuid | null",
      "tags": ["string"]
    }
    ```
  - **Response `201`**: `{ "memo": { ... } }`

- **`GET /api/v1/memos/:id`**
  - Returns single memo with tag list and version metadata. `404` if not found or outside user's workspace.

- **`PATCH /api/v1/memos/:id`**
  - **Body**: Partial update fields + `"version": number` (optimistic concurrency).
  - **Logic**: Verifies `version == existing.version`. If mismatched, returns `409 Conflict`. On success, increments version, updates `memos`, and inserts snapshot record in `memo_versions`.
  - **Response `200`**: `{ "memo": { ... } }`

- **`DELETE /api/v1/memos/:id`**
  - **Query**: `permanent=true` (hard delete) or omitted (soft delete setting `deletedAt = Date.now()`).
  - **Response `200`**: `{ "success": true }`

- **`POST /api/v1/memos/:id/restore`**
  - Clears `deletedAt`. Returns restored memo.

### 4.5 Categories & Tags API
- **`GET /api/v1/categories?workspaceId=...`** / **`POST /api/v1/categories`**: CRUD for memo categories (`name`, `color`, `icon`).
- **`GET /api/v1/tags?workspaceId=...`** / **`POST /api/v1/tags`**: List and create workspace tags.

### 4.6 Browser Data Migration API (`/api/v1/migration`)
- **`POST /api/v1/migration/import-local`**
  - **Body**:
    ```json
    {
      "workspaceId": "uuid",
      "memos": [
        {
          "localId": "string",
          "title": "string",
          "content": "string",
          "priority": "medium",
          "status": "pending",
          "isFavorite": true,
          "category": "Work",
          "tags": ["planning"],
          "dueDate": 1728556800000,
          "createdAt": 1728500000000
        }
      ],
      "categories": [{ "name": "Work", "color": "#3b82f6" }],
      "tags": ["planning"]
    }
    ```
  - **Logic**: Enclosed in a single SQLite transaction (`db.transaction()`). Creates categories and tags if not present, inserts memos, and links tags.
  - **Response `200`**: `{ "success": true, "importedMemos": 15, "importedCategories": 3, "importedTags": 6 }`

- **`GET /api/v1/migration/export?workspaceId=...`**
  - **Response `200`**: Full JSON backup payload containing all workspace memos, tags, and categories.

---

## 5. Data Architecture & Schema

The persistence layer uses Drizzle ORM mapping to SQLite with `better-sqlite3`.

### 5.1 SQLite Operational Configuration
Configured upon opening the database file (`backend/data/memo_manager.db`):
```sql
PRAGMA journal_mode = WAL;          -- Non-blocking concurrent reads during writes
PRAGMA busy_timeout = 5000;         -- 5-second queueing on lock contention
PRAGMA synchronous = NORMAL;        -- Safe fsync profile with WAL
PRAGMA foreign_keys = ON;           -- Enforce relational references
PRAGMA cache_size = -64000;         -- 64MB memory page cache
```

### 5.2 Relational Entities (Drizzle DDL)
1. **`users`**: `id` (PK, UUID), `email` (UNIQUE), `password_hash`, `name`, `avatar_url`, `timezone`, `status`, `created_at`, `updated_at`.
2. **`sessions`**: `id` (PK, 256-bit crypto token), `user_id` (FK `users.id` CASCADE), `ip_address`, `user_agent`, `expires_at`, `created_at`.
3. **`workspaces`**: `id` (PK, UUID), `name`, `slug` (UNIQUE), `owner_id` (FK `users.id`), `created_at`, `updated_at`.
4. **`workspace_members`**: `id` (PK), `workspace_id` (FK CASCADE), `user_id` (FK CASCADE), `role` (`owner`, `admin`, `editor`, `viewer`), `created_at`, `UNIQUE(workspace_id, user_id)`.
5. **`folders`**: `id` (PK), `workspace_id` (FK CASCADE), `name`, `parent_id` (FK `folders.id`), `created_at`, `updated_at`.
6. **`categories`**: `id` (PK), `workspace_id` (FK CASCADE), `name`, `color`, `icon`, `created_at`.
7. **`tags`**: `id` (PK), `workspace_id` (FK CASCADE), `name`, `created_at`, `UNIQUE(workspace_id, name)`.
8. **`memos`**: `id` (PK), `workspace_id` (FK CASCADE), `folder_id` (FK SET NULL), `category_id` (FK SET NULL), `title`, `content`, `priority`, `status`, `is_favorite`, `is_pinned`, `due_date`, `version` (INT, default 1), `created_by` (FK `users.id`), `created_at`, `updated_at`, `deleted_at`.
9. **`memo_tags`**: `memo_id` (FK CASCADE), `tag_id` (FK CASCADE), PK (`memo_id`, `tag_id`).
10. **`memo_versions`**: `id` (PK), `memo_id` (FK CASCADE), `version_number`, `title`, `content`, `changed_by` (FK `users.id`), `created_at`.
11. **`attachments`**: `id` (PK), `memo_id` (FK CASCADE), `workspace_id` (FK CASCADE), `file_name`, `file_size`, `mime_type`, `storage_path`, `created_at`.
12. **`memos_fts`**: SQLite FTS5 Virtual Table (`title`, `content`, `content='memos'`, `content_rowid='rowid'`) kept synchronized via triggers on `memos` INSERT, UPDATE, DELETE.

---

## 6. Order of Work

The work is split across Backend, Frontend, and QA roles, structured to maximize concurrent progress:

### Stage 1: Backend Foundation (Backend Agent)
- Initialize `backend/` package, TypeScript configuration, Drizzle ORM schema, and SQLite connection with WAL/concurrency pragmas.
- Implement authentication engine: `argon2id` password hashing, session store in SQLite, HTTP-only cookie plugin, and auth hooks.
- Implement user registration, login, logout, and `/api/v1/auth/me`.

### Stage 2: Backend Core Services & Migration (Backend Agent)
- Implement workspace isolation middleware and RBAC enforcement.
- Build Memo CRUD API (`/api/v1/memos`), Categories, Tags, and optimistic locking revision history.
- Implement SQLite FTS5 virtual table and search query builder.
- Implement `/api/v1/migration/import-local` and `/api/v1/migration/export`.
- Write backend route integration tests proving auth, tenant isolation, and CRUD operations.

### Stage 3: Frontend Architecture & Auth Flow (Frontend Agent)
- Set up `frontend/` application structure with responsive CSS layout, dark/light theme switching, and navigation sidebar.
- Implement Auth UI: Registration, Login, Session detection (`GET /api/v1/auth/me`), and logout.
- Build Workspace switcher and user profile dropdown.

### Stage 4: Frontend Memo Productivity & Migration UI (Frontend Agent)
- Build Memo management interface: memo list, grid view, filter bar (status, priority, category, tags, favorites, trash).
- Implement Memo editor modal/panel with markdown preview, due date picker, priority badges, and version conflict notification.
- Implement instant FTS search bar wired to `/api/v1/memos?search=...`.
- Build Migration Wizard: detects local storage data, prompts user to import, posts to `/api/v1/migration/import-local`, and provides JSON backup export.

### Stage 5: End-to-End Verification & QA Certification (QA Agent)
- Run backend automated test suites.
- Execute headless browser automation verifying full user journeys: registration, memo creation, rich categorization, full-text search, migration ingestion, theme toggling, and multi-tenant security barrier.
- Verify zero regression of legacy Memo Manager features. Deliver final QA report with captured browser screenshots.

---

## 7. How we check it

QA and test verification will execute against the running system to certify readiness:

1. **Automated Backend Tests**:
   - `cd backend && npm test`
   - Must pass all tests for:
     - User registration, password hashing verification, and cookie issuance.
     - Unauthenticated access rejection (`401`).
     - Cross-tenant data isolation: User A cannot read or modify User B's workspace memos (`404` or `403`).
     - Memo creation, category assignment, tag linking, and optimistic lock rejection (`409`).
     - FTS5 search query returns accurate ranking.
     - LocalStorage migration parses sample payload and persists all entities in one transaction.

2. **End-to-End Browser Verification**:
   - QA launches application using Playwright / headless Chromium.
   - **User Flow 1 (Auth & Workspace)**: New user signs up, lands in their personal workspace, logs out, logs back in.
   - **User Flow 2 (Memo Lifecycle)**: Creates memos with different statuses (`in_progress`, `completed`), priorities (`urgent`, `high`), due dates, and tags. Edits a memo, verifies updated version, tests soft-delete to Trash and restore.
   - **User Flow 3 (FTS Search)**: Enters keyword in search bar; UI updates with matching memos in <100ms.
   - **User Flow 4 (Data Migration)**: Imports a legacy JSON export file via UI; verifies all imported memos appear correctly in the workspace.
   - **User Flow 5 (UI & Theme)**: Toggles dark mode / light mode; verifies layout responsiveness on desktop and mobile viewports.
   - Screenshots saved under `.agents/browser/` validating successful UI flows.

---

## 8. Risks and open questions

1. **SQLite Concurrency & Multi-Process Pitfall**:
   - *Risk*: Multiple Node processes or clustering pointing to the same SQLite file could cause database locking issues.
   - *Mitigation*: Memo Manager runs strictly as a single Node.js process with `PRAGMA busy_timeout = 5000;` and WAL mode.
2. **Backward Compatibility of Export/Import Formats**:
   - *Risk*: Discrepancies between legacy client-side export fields and new SaaS schema.
   - *Mitigation*: The `/api/v1/migration/import-local` endpoint includes flexible mapping for optional fields and defaults missing timestamps.
3. **Optimistic Locking Conflicts**:
   - *Risk*: User opens memo in multiple tabs, causing concurrent edit overwrite.
   - *Mitigation*: Handled cleanly with `version` counter and explicit `409 Conflict` response prompting user to refresh.
