# Pocket Diary Mobile — Architecture

Offline-first Expo/React Native client for self-hosted Pocket Diary servers.
This document records what the backend actually provides (inspected from
`backend/src`, not assumed), the mobile architecture built on top of it, the
compatibility gaps found, and the small backward-compatible backend additions
this app ships with.

**Status:** implemented. See the [delivery summary](#delivery-summary) at the
end for what is tested and what is best-effort.

---

## 1. Inspected backend contract (source of truth)

All of the following were read from the code before a single mobile line was
written (`backend/src/routes/*`, `backend/src/services/*`, `backend/src/db/*`,
`backend/src/openapi.ts`, `backend/test/*`, root `README.md`, `AUDIT.md`):

| Area | Actual behavior |
| --- | --- |
| API prefix | `/api/v1` (Fastify, registered in `routes/index.ts`); liveness also at `/health` |
| Auth | `memo_session` **HTTP-only cookie** (`plugins/auth.ts`, `routes/auth.ts`). Sessions are 256-bit tokens stored **SHA-256 hashed** server-side, 7-day expiry with **sliding renewal**, revocable per-device via opaque `public_id`. `Set-Cookie` is returned by `POST /auth/register` and `POST /auth/login`. |
| Auth endpoints | register, login (`rememberMe`, `timezone`), logout, `GET /auth/me` (user + workspaces+role), `GET/PATCH /auth/profile` (password change revokes other sessions), `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke`, `DELETE /auth/account`, forgot/reset password. Password policy: ≥ 8 chars with letter + digit. |
| Memos | `GET /memos?workspaceId=…` — paginated (`page`, `limit` ≤ 100, default 50), filters (status, priority, category, tag, folder, favorite, pinned, archived, reminder, `includeDeleted`, `deletedOnly`), FTS `search`, `sortBy`/`sortOrder` (`updatedAt` supported). `POST /memos`, `GET /memos/:id`, `PATCH /memos/:id` (**optimistic locking**: send `version`; mismatch → `409` + `currentVersion`), `DELETE /memos/:id?permanent=` (soft delete → trash), `POST /memos/:id/restore`, `GET /memos/:id/versions`, `POST /memos/reorder`, `DELETE /memos/trash`, `POST /memos/link-preview`. |
| Memo shape | Fully hydrated (`memo.service.ts` `FormattedMemo`): title, content, color/theme/priority/status, isFavorite/isPinned/isArchived, noteType (`text`\|`checklist`), checklistData, dueDate, reminderTime, reminderLocation, tags (string[]), category, attachments[] (with `url`), `version`, `createdAt`, `updatedAt`, `deletedAt`. |
| Roles | owner / admin / editor / viewer. Viewers get 403 on all memo writes; strictly tenant-scoped (foreign workspace → 404). |
| Workspaces | `GET /workspaces` (id, name, role), create, rename (admin+), members list, leave, transfer, invites (create/list/revoke), storage usage. |
| Folders / categories / tags | CRUD under `/folders`, `/categories`, `/tags` (workspace-scoped). Notes reference `folderId`/`categoryId`; tags by name (deduped case-insensitively). |
| Attachments | `POST /attachments/memo/:memoId` (multipart, ≤ 5 MB, magic-byte verified; JPEG/PNG/WebP/GIF/PDF/TXT/MD), `GET /attachments/:id/file` (inline for images), `DELETE /attachments/:id`, `GET /attachments/memo/:memoId` list. |
| Notifications | `GET /notifications` (server-scanned reminders, cached in-app), `POST /notifications/:id/read`, `POST /notifications/read-all`. Web Push is VAPID-only (browser). |
| Rate limits | 300 req/min global per IP; ~15/min on auth endpoints; per-account login lockout. |
| Health | `GET /health` → `{"status":"ok","timestamp":…}` (public, both at root and under `/api/v1`). |

### Cookie auth in React Native — decision

The backend has **no token API**, only the HTTP-only session cookie. Browsers
get the cookie jar for free; React Native's implicit cookie handling is not
contractually guaranteed across OS versions and app restarts. The mobile client
therefore:

1. performs `POST /auth/login` / `/auth/register` and reads the raw
   `set-cookie` response header,
2. persists `memo_session=<token>` in **expo-secure-store** (iOS Keychain /
   Android Keystore-backed encrypted storage) — never AsyncStorage, never
   SQLite,
3. sends an explicit `Cookie` header on every request,
4. deletes the stored token on logout / 401 and surfaces re-authentication.

This uses the *existing, revocable, hashed-at-rest sessions unchanged* — no
new token surface, no weakened browser auth, and no session hashes ever leave
the server. Multi-server/ multi-account isolation: credentials are keyed by
`serverKey` (the normalized, lowercased server URL — stable and collision-free for our purposes) and user id.

---

## 2. Backend compatibility gaps found (and how they are addressed)

| # | Gap (found in code) | Consequence for mobile | Resolution |
| --- | --- | --- | --- |
| G-1 | **No version/capability endpoint** — only `/health` (`{status, timestamp}`). A first-launch client cannot tell a Pocket Diary server from any other service, nor which API features exist. | Server setup screen could accept incompatible servers silently. | **Added `GET /api/v1/system/info`** (public, additive): `{name, version, apiPrefix, capabilities}`. The app validates against it and **falls back to `/health`** for older servers (connect allowed, degraded capabilities reported). See §3.1. |
| G-2 | **No idempotency key on `POST /memos`** — if the HTTP response is lost after the server applied a create (offline flakiness), a retry duplicates the note. | Unsafe retry of offline note creation. | **Added optional `clientId` (8–64 chars) to memo create**; stored per workspace with a UNIQUE index; a replay returns the original memo instead of creating a second one. Web frontend unaffected (optional field). See §3.2. |
| G-3 | **No incremental change feed / tombstones for hard deletes.** `updatedAt` exists and is indexed; soft-deleted rows survive (`deletedAt`), but `DELETE ?permanent=true` and empty-trash vanish without a trace. | Full pull can detect trashed notes, but not purged ones. | Pull-sync by `updatedAt` cursor (§4.2) + **periodic full reconciliation** (absence detection) + 404-on-open detection. Documented as a limitation; no server change (a change-feed endpoint would be the next backend improvement). |
| G-4 | **No background push for reminders on mobile** — Web Push is VAPID (browser-only). | Reminders would only arrive while the app is open. | Reminders screen mirrors server notifications; the app additionally **schedules local notifications** (best-effort; OS may delay/kill background delivery — documented). |
| G-5 | **`limit` capped at 100** and list endpoints count a full `COUNT(*)` per page. | Large collections need many round trips. | Sync pages at `limit=100` and stops as soon as an incremental page is entirely older than the cursor (§4.2). |
| G-6 | **Attachments are auth-protected** (`Cookie` header required on `GET /attachments/:id/file`). | `<Image>` cannot load them without the header. | Downloads go through the API client with the session header and are cached on disk (`expo-file-system`) for offline viewing. |

Everything else the mobile app needs (optimistic locking, soft delete +
restore, pagination, workspace roles, session revocation) already exists and
is used as-is.

---

## 3. Backend additions shipped with this app (backward compatible)

Both changes are additive; the web frontend is untouched, all 130+ existing
backend tests keep passing, and `docs.test.ts`'s "every route documented"
inventory is extended rather than loosened.

### 3.1 `GET /api/v1/system/info` — public capability discovery

```json
{
  "name": "pocket-diary",
  "version": "1.0.0",
  "apiPrefix": "/api/v1",
  "capabilities": { "memoClientId": true }
}
```

- Registered **before** the system plugin's `authenticate` hook (public).
- `capabilities.memoClientId` → the mobile client enables idempotent note
  creation. Absent (older server) → the app still connects, but offline
  creates fall back to "fail-closed on ambiguous create" (§4.4).
- `name` mismatch or unparseable response → "incompatible server" error on the
  setup screen.

### 3.2 Idempotent note creation via `clientId`

- `POST /memos` accepts optional `clientId` (string, 8–64).
- New `memos.client_id` column + `UNIQUE(workspace_id, client_id)` index,
  shipped as versioned migration step **v4** (`PRAGMA user_version`; the
  existing v3 step is untouched — only its final `user_version` pin becomes 3).
- Replay of the same `clientId` in the same workspace returns the existing
  memo (`201`, same shape) with no duplicate row and no version bump.
- The field is exposed in the memo DTO as `clientId` (null for notes created
  without one) and documented in the OpenAPI `Memo` schema.
- Not settable via `PATCH` — it is an identity, not an editable field.

---

## 4. Mobile architecture

### 4.1 Stack (chosen for stability + Expo compatibility)

| Concern | Choice | Rationale |
| --- | --- | --- |
| Runtime | Expo SDK 53, React Native 0.79, React 19, TypeScript | Current stable SDK; development-build/EAS compatible. |
| Navigation | Expo Router v5 (typed routes) | File-based, deep-link ready, first-class modal support. |
| Server state | TanStack Query v5 | Online-only queries (sessions, storage, workspaces) + cache-invalidation bus over the local DB. The **durable source is SQLite**, not the query cache. |
| Local store | `expo-sqlite` (WAL) | Durable notes cache + outbox + sync cursors. Schema versioned (`PRAGMA user_version`). |
| Secrets | `expo-secure-store` | Server config, session cookie, per-account pointers. |
| Connectivity | `@react-native-community/netinfo` | **Treated as a hint, not truth**: reconnect triggers a sync attempt, but sync success/failure is decided by actual HTTP outcomes (§4.5). |
| Validation | Zod | Every API response parsed through a schema (forward-tolerant `passthrough`). |
| Styling | Hand-rolled typed token system (§4.6) | Evaluated available UI/UX skills first: `ui-styling` targets shadcn/ui + Radix + Tailwind — **DOM-only**, not applicable to React Native; `design-system`'s primitive→semantic→component token architecture **is** applied. NativeWind/Tamagui were rejected to keep the dependency surface small, builds reproducible, and Jest/vitest testing unencumbered. |
| Background sync | None claimed | OS background execution is best-effort and never guaranteed; sync runs on launch, foreground, reconnect, pull-to-refresh, and after each mutation (§4.5). |

### 4.2 Local data model (SQLite)

Every row is scoped by `server_key` + `user_id` (isolation by construction —
switching server or account can never leak another scope's data; covered by
tests).

```
meta(key, value)                    -- schema version, misc
accounts(server_key, user_id, email, name, created_at)
workspaces(server_key, user_id, workspace_id, name, slug, role, …)
notes(
  id            TEXT PK,           -- stable LOCAL id (uuid), never changes
  server_id     TEXT,              -- server uuid once known (UNIQUE w/ scope)
  client_id     TEXT,              -- idempotency key for create
  …memo fields…                    -- title, content, color, theme, priority,
                                    -- status, note_type, checklist_json,
                                    -- tags_json, category/folder, flags,
                                    -- due/reminder, attachments_json
  server_version  INT,             -- last seen server version (conflict base)
  server_updated_at INT, deleted_at INT,
  sync_state    TEXT               -- synced | pending | conflicted | error
)
outbox(
  id TEXT PK,                      -- operation id (uuid)
  entity ('note'), note_id, op ('create'|'update'|'delete'|'restore'|'attachment_upload'),
  payload JSON, base_version, client_id,
  status ('pending'|'in_flight'|'conflicted'|'failed'),
  attempts, next_attempt_at, last_error, created_at, updated_at
)
sync_state(scope PK, last_pull_at, last_full_sync_at, …)
folders / categories / notifications (server-shaped caches, scope-keyed)
```

Migrations are numbered and replay-safe (`migrations.ts`), mirroring the
backend's `PRAGMA user_version` approach.

### 4.3 Outbox — durable mutation queue

- **Durability first**: every mutation is committed to SQLite in the same
  transaction that updates the note row. Killing the app mid-queue loses
  nothing; there is no in-memory queue anywhere.
- **Coalescing**: a new edit while an op for the same note is still `pending`
  merges into that op (field-level last-write-wins). `create`+`update` merges
  into the create payload; `create`+`delete` elides both (the note never
  reached the server); `delete` after a pending update enqueues behind it
  (FIFO per note), so ordering is preserved.
- **Operation identity**: each op has a stable UUID, entity id, timestamps,
  attempt count, and next-attempt time (exponential backoff + jitter:
  `base 2^attempts` seconds, capped, ±30% jitter).
- **Duplicate prevention**: creates carry `clientId` (server-side unique —
  §3.2). Updates dedupe *before* retry: after an ambiguous failure (no HTTP
  response), the engine re-fetches the memo; if the server already reflects
  the patch (version advanced by our own write), the op is marked applied
  instead of replayed. Deletes/restores are naturally idempotent (404 on
  double delete = success).

### 4.4 Sync engine (push + pull)

```
trigger → if session && (outbox non-empty || pull due) → runOnce()
runOnce():
  1. push: FIFO outbox (per note), backoff-respecting
       create  → POST /memos {…payload, clientId}          (idempotent)
       update  → PATCH /memos/:serverId {…patch, version} → 409 ⇒ conflicted
       delete  → DELETE /memos/:serverId                   (404 ⇒ success)
       restore → POST /memos/:serverId/restore
       attachment_upload → multipart POST (waits for note create first)
  2. pull: per workspace, pages of 100, sortBy=updatedAt desc,
       includeDeleted=true (trashed notes stay visible in Trash)
       - incremental: stop at first page fully older than (cursor − 5 s skew margin)
       - full (first sync / manual / every 24 h): all pages, then absence
         reconciliation: local synced notes missing from the complete server
         set are marked deleted (catches permanent deletes, G-3)
  3. cursors, notification cache refresh, workspace refresh, UI events
```

- **Conflicts** (409): the op is parked as `conflicted` (nothing silently
  overwritten); the note shows a conflict banner with two explicit choices:
  *Keep mine* (re-send patch without `version` — deliberate last-write-wins)
  or *Use server* (fetch server copy, drop local patch). Both are user
  actions with confirmation; the engine never auto-resolves.
- **Pull vs. pending local edits**: server rows for notes with pending outbox
  ops are **not** clobbered locally; the divergence surfaces as a 409 at push
  time, which is the honest conflict signal.
- **Auth expiry mid-sync**: any 401 stops the run (ops stay queued, marked
  back to `pending`), clears the stored session, and routes to sign-in. The
  outbox survives re-login and resumes.
- **Partial failure**: per-op failures never abort the whole queue; HTTP
  4xx (except 401/409) parks the op as `failed` with the server message
  (surfaced in Settings → Sync), network errors keep it `pending` with backoff.

### 4.5 Triggers & connectivity

Sync runs: on app launch (after session restore), on `AppState` → active, on
NetInfo reconnect, on pull-to-refresh, after any committed mutation
(debounced), and via Settings → *Sync now* / *Full resync*. NetInfo is only a
hint — every request still has timeouts, and failures schedule retries
regardless of the "connected" flag. No background-fetch guarantees are claimed
or relied upon.

### 4.6 Design system

Typed tokens in `theme/` following the primitive → semantic → component
pattern from the `design-system` skill (the shadcn/Radix stack from
`ui-styling` is DOM-only and was consciously not ported):

- **Primitives**: 12 note palette colors matching the backend palette
  (`default, red, orange, yellow, green, teal, blue, darkblue, purple, pink,
  brown, gray`), neutral ramp, spacing (4 pt base), radii, type scale, icon
  sizes, duration scale.
- **Semantic**: `bg/surface/surfaceAlt/text/textSubtle/border/primary/
  primaryText/danger/success/warning/overlay` — full light **and** dark
  themes, honoring the OS setting with a manual override.
- **Components**: Button (primary/secondary/ghost/danger + loading),
  TextField, Card, NoteCard (sync/pin/favorite badges, checklist preview),
  Chip, Banner (offline/pending/syncing), Skeleton, EmptyState, ListRow,
  SegmentedControl, Modal + BottomSheet, Toast, Avatar, SearchBar, FAB,
  SafeArea wrappers — all with `accessibilityRole/Label/State`, ≥ 44 pt
  targets, and visible pressed/disabled states.

### 4.7 Module layout

```
mobile-apps/
  app/                      Expo Router screens (gate → server-setup → auth → tabs)
  components/               design-system components
  features/
    auth/                   session manager, credential store, login/register flows
    notes/                  repositories, note queries, editor state machine
    sync/                   outbox, engine, netinfo, sync status store
    workspaces/             workspace hooks + switcher
  services/
    api/                    fetch client (injectable transport), zod contracts,
                            typed endpoint functions, error taxonomy
    db/                     sqlite adapter (expo-sqlite | better-sqlite3 for tests),
                            schema, migrations, repositories
    storage/                secure-store wrapper (injectable), kv prefs
  hooks/                    useAppState, useDebouncedCallback, useOnline…
  theme/                    tokens, ThemeProvider
  utils/                    url, id, time, json helpers
  test/                     vitest suites (logic + engine + persistence + a11y)
```

Every RN-native dependency (fetch transport, SecureStore, SQLite driver,
NetInfo, FileSystem) sits behind a small interface so the entire domain layer
(outbox, engine, repositories, session, URL validation) runs in plain Node
under vitest — the same production code paths, not mocks of them.

---

## 5. Delivery summary

- **Backend**: `GET /api/v1/system/info`, `clientId` idempotent creates,
  migration v4, OpenAPI updates, `test/mobile-sync.test.ts`. Full backend
  suite + `tsc` green.
- **Mobile**: complete Expo app under `mobile-apps/` (see its `README.md`),
  with vitest suites covering URL validation/server detection, session
  expiry, outbox durability + coalescing + duplicate prevention, sync
  pagination/conflict/deletion/reconciliation, connectivity loss mid-request,
  account/server isolation, and persistence across restart.
- **Honest limitations** are listed in `mobile-apps/README.md` (§ Limitations):
  no guaranteed background sync, best-effort local reminders, no incremental
  hard-delete tombstones server-side, attachment upload requires the note to
  exist server-side first (queued otherwise), link previews and version
  history are online-only and not included in v1 mobile.
