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
| Runtime | Expo SDK 58, React Native 0.88, React 19.3, TypeScript 6 | Upgraded incrementally 53→54→55→56→57→58; every step re-validated with typecheck, lint, tests, and expo-doctor. |
| Navigation | Expo Router (typed routes) | File-based, deep-link ready, first-class modal support. |
| Server state | TanStack Query v5 | Online-only queries (sessions, storage, workspaces) + cache-invalidation bus over the local DB. The **durable source is SQLite**, not the query cache. |
| Local store | `expo-sqlite` (WAL) | Durable notes cache + outbox + sync cursors. Schema versioned (`PRAGMA user_version`). |
| Secrets | `expo-secure-store` | Server config, session cookie, per-account pointers. |
| Connectivity | `@react-native-community/netinfo` | **Treated as a hint, not truth**: reconnect triggers a sync attempt, but sync success/failure is decided by actual HTTP outcomes (§4.5). |
| Validation | Zod | Every API response parsed through a schema (forward-tolerant `passthrough`). |
| Styling | Hand-rolled typed token system (§4.6) | Evaluated available UI/UX skills first: `ui-styling` targets shadcn/ui + Radix + Tailwind — **DOM-only**, not applicable to React Native; `design-system`'s primitive→semantic→component token architecture **is** applied. NativeWind/Tamagui were rejected to keep the dependency surface small, builds reproducible, and Jest/vitest testing unencumbered. |
| Background sync | None claimed | OS background execution is best-effort and never guaranteed; sync runs on launch, foreground, reconnect, pull-to-refresh, and after each mutation (§4.5). |
| Local reminders | expo-notifications (best-effort) | OS-local notifications scheduled after each sync for upcoming note reminders; delivery is never guaranteed (§G-4). |
| Attachments | expo-image-picker + expo-document-picker, outbox-queued uploads, on-disk download cache | Server attachments are cookie-protected; uploads queue offline (§4.8). |

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
  entity ('note'), note_id, op ('create'|'update'|'delete'|'restore'
                                    |'attachment_upload'|'attachment_delete'),
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
- **Crash recovery**: an op marked `in_flight` right before its HTTP call
  would be stranded forever (the queue picker only selects `pending`). The
  engine constructor requeues every `in_flight` op for the current scope on
  app start; replay is safe because ops are idempotent or version-guarded.
- **Coalescing**: a new edit while an op for the same note is still `pending`
  merges into that op (field-level last-write-wins). `create`+`update` merges
  into the create payload; `create`+`delete` elides both (the note never
  reached the server); `delete` after a pending update replaces it (FIFO per
  note, ordering preserved). Attachment ops **never coalesce into lifecycle
  ops** (a pending upload must not hide an older lifecycle op); a re-picked
  upload replaces its own pending predecessor, and a note delete elides that
  note's pending uploads (they could only ever 404).
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
       delete  → DELETE /memos/:serverId[?permanent=true]  (404 ⇒ success)
       restore → POST /memos/:serverId/restore
       attachment_upload → multipart POST (waits for note create first;
                            404 = note gone ⇒ completed)
       attachment_delete → DELETE /attachments/:id         (404 ⇒ success)
  2. pull: per workspace, pages of 100, sortBy=updatedAt desc,
       includeDeleted=true (trashed notes stay visible in Trash)
       - incremental: stop at first page fully older than (cursor − 5 s skew margin)
       - full (first sync / manual / every 24 h): all pages, then absence
         reconciliation: local synced notes missing from the complete server
         set are marked deleted (catches permanent deletes, G-3)
  3. cursors, notification cache refresh, workspace refresh,
     local-reminder reconciliation, UI events
```

- **Conflicts** (409): the op is parked as `conflicted` (nothing silently
  overwritten); the note shows a conflict banner with two explicit choices:
  *Keep mine* (re-send patch without `version` — deliberate last-write-wins)
  or *Use server* (fetch server copy, drop local patch). Both are user
  actions with confirmation; the engine never auto-resolves.
- **Pull vs. unsynced local state**: server rows for notes whose local sync
  state is `pending`, `conflicted` **or `error`** are **not** clobbered by
  pull. (A previous version only protected `pending` — the pull following a
  409 used to overwrite the local conflicted copy, silently destroying the
  user's version and making "Keep mine" a no-op. Regression-tested.)
- **Auth expiry mid-sync**: any 401 (push *or* pull) stops the run, marks the
  op back to `pending` with backoff, calls the host's `onAuthExpired` hook —
  which deletes only the stored token (`expireSessionLocally`, no server
  call, outbox untouched) — and the gateway routes to sign-in. After
  re-login the same ops resume and push.
- **Concurrent runSync calls** join the in-flight run (its promise is
  returned) instead of silently reporting zero work.
- **Partial failure**: per-op failures never abort the whole queue; HTTP
  4xx (except 401/409) parks the op as `failed` with the server message
  (surfaced in Settings → Sync), network errors keep it `pending` with backoff.
  An `attachment_upload` whose note has not reached the server yet waits as a
  retryable pending op (never a fatal client error).

### 4.5 Triggers & connectivity

Sync runs: on app launch (NetInfo's initial callback fires once a session
exists), on `AppState` → active, on NetInfo reconnect, on pull-to-refresh,
after any committed mutation (debounced 400 ms in the editor), and via
Settings → *Sync now* / *Full resync*. NetInfo is only a hint — every request
still has timeouts, and failures schedule retries regardless of the
"connected" flag. No background-fetch guarantees are claimed or relied upon.
After each successful sync the upcoming note reminders are reconciled into
the OS-local notification scheduler (§4.8) — also strictly best-effort.

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
- **Components**: Button (primary/secondary/outline/ghost/destructive +
  loading), TextField, Card, NoteCard (sync/pin/favorite badges, checklist
  preview), Chip, Banner (info/warning/error/success/conflict, primary +
  secondary actions, dismiss), Skeleton (pulse), EmptyState, ListRow,
  ColorPicker, ChecklistEditor, ReminderRow (iOS compact / Android staged
  date→time pickers), TagEditor (chips + inline add), AttachmentStrip
  (thumbnails, pending/failed upload states with retry, full-screen image
  viewer, document open via expo-sharing), FAB pair (note/checklist), modal
  workspace switcher — all with `accessibilityRole/Label/State`, ≥ 44 pt
  targets (hitSlop where visual density demands), and visible pressed /
  disabled states. Edge-to-edge is mandatory from SDK 55: the editor footer
  pads by the bottom safe-area inset and tab screens use SafeAreaView
  top edges.
- **React-compiler-era lint** (eslint-config-expo ≥ 56) is enforced: no
  setState-in-effect cascades (screens derive SQLite data via `useMemo` with
  explicit invalidation triggers), no impure calls during render (picker
  dates are captured in event handlers; "now" for reminder bucketing comes
  from a lazy state initializer refreshed by sync completion).

### 4.7 Module layout

```
mobile-apps/
  app/                      Expo Router screens (gate → server-setup → auth → tabs → editor)
  components/               design-system components (ui/ + notes/)
  features/
    auth/                   session manager, credential store, login/register flows
    attachments/            client-side validation mirroring the server contract
    notes/                  repositories, note queries, editor state machine
    reminders/              local-notification scheduler (interface + expo impl)
    sync/                   outbox, engine, sync context (NetInfo/AppState triggers)
    workspaces/             workspace repository (folders/tags/notifications)
  services/
    api/                    fetch client (injectable transport), zod contracts,
                            typed endpoint functions, error taxonomy, probe ladder
    attachments/            binary download cache (expo-file-system | Node)
    db/                     sqlite adapter (expo-sqlite | better-sqlite3 for tests),
                            schema, migrations
    storage/                secure-store wrapper (injectable), kv prefs
    platform.ts             RN service factory (db, prefs, secure, transport,
                            attachment cache, reminder scheduler)
  theme/                    tokens, themes, ThemeProvider
  utils/                    url, id, time, json helpers
  test/                     vitest suites: unit (url, server-check, auth, outbox,
                            offline notes, engine, attachments) + real-backend
                            integration (11 scenarios)
```

Every RN-native dependency (fetch transport, SecureStore, SQLite driver,
NetInfo, FileSystem, Notifications, pickers) sits behind a small interface so
the entire domain layer (outbox, engine, repositories, session, URL
validation, attachment queueing, reminder reconciliation) runs in plain Node
under vitest — the same production code paths, not mocks of them. The
integration suite additionally drives those paths against the **real
compiled backend** over real HTTP (see §6).

### 4.8 Attachments & local reminders (mobile-only flows)

- **Attachment queueing** (op payloads are JSON-serializable by design):
  a device payload carries `{uri, fileName, mimeType, fileSize}` (the picker
  copies files into the app cache, so the URI stays valid across restarts);
  the Node harness carries `{fileBytesB64}`. `buildAttachmentForm` turns
  either into a `file` multipart part.
- **Validation before queueing** mirrors the server: allowed MIME set
  (JPEG/PNG/WebP/GIF/PDF/TXT/MD), ≤ 5 MB, non-empty — refused with a
  user-facing reason instead of an endlessly failing queue entry.
- **Download cache**: `GET /attachments/:id/file` requires the session
  cookie, so files are fetched through the API client and cached on disk;
  images render from the cache offline, documents open via `expo-sharing`,
  and uncached-offline files show a "download needed" state.
- **Local reminders**: after every sync the next 7 days of note reminders
  (cap 25) are reconciled into expo-notifications — a stable scheduling key
  per (note, reminderTime), stale entries cancelled, Android channel
  registered, permission requested once. **Best-effort by design**: OS may
  delay/coalesce; no background delivery guarantee is claimed.

---

## 5. Delivery summary

- **Backend**: `GET /api/v1/system/info`, `clientId` idempotent creates,
  migration v4, OpenAPI updates, `test/mobile-sync.test.ts`. Full backend
  suite (146 tests) + `tsc` green.
- **Mobile**: complete Expo app under `mobile-apps/` (see its `README.md`),
  with 70 vitest tests: URL validation/server detection, session expiry,
  outbox durability + coalescing + duplicate prevention + crash recovery,
  sync pagination/conflict/deletion/reconciliation, connectivity loss
  mid-request, account/server isolation, persistence across restart,
  attachment rules/queueing/push, and reminder scheduling selection — plus
  the 11-scenario real-backend integration suite (§6).
- **Honest limitations** are listed in `mobile-apps/README.md` (§ Limitations):
  no guaranteed background sync, best-effort local reminders, no incremental
  hard-delete tombstones server-side, attachment upload requires the note to
  exist server-side first (queued otherwise), link previews and version
  history are online-only and not included in v1 mobile.

---

## 6. Verification status (final audit)

**Verified in this workspace** (commands + results):

| Check | Result |
| --- | --- |
| `npm run typecheck` | ✅ clean (TypeScript 6, strict) |
| `npm run lint` | ✅ 0 errors, 0 warnings (eslint-config-expo 56+, React-compiler rules) |
| `npm test` | ✅ 70/70 across 9 files (incl. 11 real-backend integration scenarios) |
| `npx expo-doctor` | ✅ 20/20 checks |
| `npx expo export --platform android` | ✅ Hermes bundle (3.6 MB) |
| `npx expo export --platform ios` | ✅ Hermes bundle (3.6 MB) |
| `npx expo prebuild --platform android --no-install` | ✅ native project, manifest (permissions, `adjustResize`, single-task), icons, notification icon generate correctly |
| backend `npm test` | ✅ 146/146 |

**Not verifiable here** (no JDK, no Android SDK, no Xcode in this environment):
compiling/launching the APK or IPA, on-device permission prompts, OS
notification delivery, and picker behavior on a real screen. Commands to
finish: `npx expo run:android` (needs Android SDK + JDK 17+), `npx expo
run:ios` (needs macOS + Xcode + CocoaPods), or `npx eas-cli build --profile
development --platform all` (needs an EAS account; run `npx eas-cli init`
first to bind `extra.eas.projectId`).

**Bugs found by the audit and fixed** (regression tests included):

1. **Conflict clobbering** — `upsertSyncedNote` protected only `pending`
   local rows, so the pull that follows a 409 overwrote the local conflicted
   copy with the server version. "Keep mine" then re-sent the server's own
   content: silent data loss. Now `conflicted` and `error` rows are preserved
   exactly like `pending` ones.
2. **Stranded in-flight ops** — an app kill between `markInFlight` and the
   HTTP response left ops `in_flight` forever (the queue picker only selects
   `pending`). The engine now requeues them on construction.
3. **Editor duplicate/empty drafts** — the new-note effect re-ran on
   theme/scope changes (and StrictMode), creating duplicate notes, and every
   open-and-back-out pushed an empty note to the server. Notes are now
   created lazily on first edit, and still-empty drafts are cleaned up (and
   permanently deleted server-side if they already synced).
4. **Doc/code mismatches closed** — attachment upload/delete (outbox ops,
   engine cases, validation, UI, offline cache) and best-effort local
   reminder notifications are now actually implemented; restore-from-trash,
   delete-forever and empty-trash affordances were added; the editor's update
   payload now carries the full editable field set (previously reminderTime/
   tags edits would never have reached the server).
5. **401 mid-sync** previously left a dead session in place while every sync
   silently failed. It now clears the stored token via
   `SessionManager.expireSessionLocally()` (outbox untouched) and the
   gateway routes to sign-in; pending work resumes after re-login.
6. **Concurrent `runSync` calls** now join the in-flight run instead of
   reporting zero work.

**Expo SDK upgrade path taken**: 53 → 54 → 55 → 56 → 57 → 58, each step
validated with typecheck + lint + all tests + expo-doctor before continuing.
API migrations handled along the way: `expo-file-system` legacy subpath,
removed `newArchEnabled`/`edgeToEdgeEnabled`/`splash` config keys (splash
moved to the `expo-splash-screen` plugin), `TextInputInstance` typing,
`AndroidImportance` relocation, TypeScript 6 `baseUrl` removal, and RN 0.88
ListHeaderComponent/tab-bar color typing. One environment note: npm needed
`legacy-peer-deps` for SDK 56's `react-native-reanimated` peer-range mismatch,
and SDK 56 itself was skipped because expo-doctor flags its Hermes regression
(upgrading to ≥ 57.0.9 is the documented remedy).
