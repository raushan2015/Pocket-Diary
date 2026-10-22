# Pocket Diary Mobile

Production-grade, offline-first mobile application for self-hosted [Pocket Diary](..) servers, built with Expo, React Native, TypeScript, Expo Router, and SQLite.

Supports **iOS** and **Android** natively, with complete offline notes, checklists, attachments, reminders, durable synchronization, and conflict resolution.

---

## Table of Contents

- [Key Architectural Highlights](#key-architectural-highlights)
- [Technology Stack](#technology-stack)
- [First-Launch Server Setup & Security Model](#first-launch-server-setup--security-model)
- [Offline-First Architecture & Durable Outbox](#offline-first-architecture--durable-outbox)
- [Conflict Handling & Reconciliation](#conflict-handling--reconciliation)
- [Attachments](#attachments)
- [Reminders](#reminders)
- [Project Structure](#project-structure)
- [Development & Testing](#development--testing)
- [Real-Backend Integration Suite](#real-backend-integration-suite)
- [Building with EAS & Development Builds](#building-with-eas--development-builds)
- [Backend Compatibility & Extensions](#backend-compatibility--extensions)
- [Limitations & Required Manual Testing](#limitations--required-manual-testing)

---

## Key Architectural Highlights

1. **Self-Hosted First**: The first screen on a clean install is the **Server Setup** gateway. No hardcoded server addresses; users connect to their own self-hosted Pocket Diary instances. Plain HTTP is refused for public hosts; loopback/LAN development is supported (LAN requires an explicit unencrypted-connection acknowledgment).
2. **True Offline-First**: All notes, checklists, tags, and workspaces are stored locally in an embedded **SQLite** database (`pocket-diary.db`). Notes are created, edited, trashed, restored, and searched with zero connectivity.
3. **Durable Mutation Queue (Outbox)**: Mutations are committed to an ACID SQLite `outbox` table with stable `clientId` UUIDs before any network request is attempted. Operation coalescing (`create` + `update` → `create`; `update` + `update` → merged update; `create` + `delete` → no-op; `delete` elides pending attachment uploads) optimizes transmission. **Crash recovery**: operations left `in_flight` by a killed app are requeued automatically on the next launch.
4. **Secure Credential Isolation**: Session tokens are stored strictly in `expo-secure-store` (iOS Keychain / Android Keystore), never in AsyncStorage or SQLite.
5. **Strict Multi-Server & Multi-Account Isolation**: Every table (including the outbox) is keyed by `(server_key, user_id)`. Switching servers or accounts can never read another scope's data — verified against two live server instances in the integration suite.
6. **Graceful Conflict Handling**: Optimistic concurrency with server `version` checks. A 409 parks the note as `conflicted` — the pull never overwrites the local conflicted copy — and the user explicitly chooses **Keep Mine** or **Use Server**.
7. **Attachments that respect offline reality**: uploads queue in the outbox (a fresh offline note uploads its attachments only after the note itself syncs); downloads are cached on disk for offline viewing; unsupported types/sizes are refused client-side with a clear message before anything is queued.
8. **Honest reminders**: notes carry reminder times; the app mirrors server notifications and additionally schedules OS-local notifications for upcoming reminders. This is best-effort by design — see [Reminders](#reminders).

## Technology Stack

- **Framework**: Expo SDK 58, React Native 0.88, React 19.3, TypeScript 6
- **Navigation**: Expo Router (typed file-based routes)
- **Database & Persistence**: `expo-sqlite` (production) and `better-sqlite3` (Node test harness)
- **Secrets Storage**: `expo-secure-store` (iOS Keychain & Android Keystore)
- **Preferences Storage**: `@react-native-async-storage/async-storage`
- **Network & Reachability**: `@react-native-community/netinfo` (treated as a hint — HTTP outcomes decide everything)
- **Styling & Theming**: Custom typed token-based design system (`theme/tokens.ts`, `theme/themes.ts`) with Light and Dark themes (system default + manual override)
- **Validation**: Zod schemas matching the backend OpenAPI contract (forward-tolerant)
- **Icons**: `@expo/vector-icons` (Ionicons)
- **Test Runner**: Vitest (unit, engine, durability, isolation, and a real-backend integration suite)

## First-Launch Server Setup & Security Model

When launched on a fresh install, Pocket Diary routes the user to `/server-setup`:

- **URL Normalization**: trims whitespace, strips trailing slashes, defaults to `https://` (plain `http://` for loopback/LAN-looking hosts).
- **Capability Probe**: connects to `GET /api/v1/system/info` (or falls back to `/health` on older servers) to verify the instance identity, version, and capabilities (`memoClientId` idempotent creation).
- **TLS & HTTP Policy**:
  - HTTPS is enforced for remote servers.
  - Plain HTTP is restricted to loopback (`localhost`, `127.0.0.1`, `10.0.2.2`, …) and RFC1918 LANs.
  - LAN HTTP requires an explicit user acknowledgment of the unencrypted connection.
- **Authentication**: the Fastify backend issues HTTP-only `memo_session` cookies. The app captures the `Set-Cookie` token on login/register, persists it in `expo-secure-store`, and injects `Cookie: memo_session=<token>` on every request with `credentials: 'omit'` (the OS cookie jar is never consulted).
- **Session expiry mid-sync** clears the local session (routes to sign-in) while preserving the entire outbox; pending work resumes after re-authentication.

## Offline-First Architecture & Durable Outbox

### Database Schema

Local SQLite database (`services/db/schema.ts`), scope-keyed by `(server_key, user_id)`:
- `notes`: local notes with checklists, colors, tags, reminders, attachments (cached DTOs), and sync state.
- `outbox`: durable mutation queue (`create | update | delete | restore | attachment_upload | attachment_delete`), attempt counts, exponential backoff timestamps.
- `workspaces`, `folders`, `categories`, `tags`, `notifications`: server-shaped caches.
- `sync_state`: per-workspace pull cursors and full-reconciliation timestamps.

### Durable Outbox Queue

Every mutation is committed locally (note row + outbox op) before any network attempt:
- Stable operation IDs, `clientId` idempotency keys for creates, exponential backoff with jitter (capped, ±30%).
- Fatal 4xx (except 401/409/408/429) park an op as `failed` for manual retry in Settings; network errors stay `pending` with backoff.
- An app kill mid-push leaves the op `in_flight`; on the next app start the sync engine requeues all `in_flight` ops — nothing is stranded.
- A trashed note's pending uploads are elided (they could only ever 404).

### Editor durability details

- **Lazy creation**: opening "new note" writes nothing until the first real edit — backing out of an empty editor leaves no local draft and pushes nothing to the server.
- **Empty-draft cleanup**: leaving an editor whose note is still completely empty removes the draft locally and queues a server-side permanent delete if it had already synced.
- Every keystroke is a synchronous SQLite commit (coalesced in the outbox); the app can be killed at any moment without data loss.

## Conflict Handling & Reconciliation

- **Optimistic Locking**: updates send `baseVersion`; a stale version produces a server 409.
- **Conflict preservation**: a 409 marks the note `conflicted` and parks the op. The pull that follows *does not overwrite* the local conflicted copy (the same protection applies to `pending` and `error` rows) — the banner's "Keep mine" sends the actual local content.
- **Keep Mine** re-sends the patch without a version constraint (deliberate last-write-wins); **Use Server** fetches and applies the server copy. Both are explicit user actions.
- **Absence reconciliation**: incremental pulls use an `updatedAt` cursor; full reconciliations (first sync, manual resync) remove local synced notes the server no longer returns — catching hard deletes/purges without tombstones.

## Attachments

The backend contract (`backend/src/routes/attachments.ts`): ≤ 5 MB, magic-byte-verified JPEG/PNG/WebP/GIF/PDF/TXT/MD, uploads rejected for trashed notes, `GET /:id/file` requires the session cookie.

- **Client-side validation before queueing** (`features/attachments/rules.ts`): unsupported MIME, > 5 MB, or unknown types are refused with a clear message — nothing is queued that can only ever fail.
- **Pickers**: images via `expo-image-picker`, documents via `expo-document-picker` (both copied to the app cache so the URI stays valid offline).
- **Queued upload**: `attachment_upload` ops wait (retryable, non-fatal) until the note itself has a server ID; then a multipart upload runs and the returned DTO merges into the local note. A 404 (note deleted server-side) completes the op.
- **Offline viewing**: server attachments are auth-protected, so the app downloads them through the API client (with the session cookie) into an on-disk cache (`services/attachments/cache.*.ts`). Images render from the cache; PDFs/TXT/MD offer "Open" via `expo-sharing`. Not-yet-downloaded files show a "download needed — go online" state, never a broken image.
- **Deletion**: `attachment_delete` ops are idempotent (404 = success) and update the local cached list immediately.

## Reminders

- Notes support `reminderTime` (set/clear from the editor with the platform date/time pickers).
- The **Reminders** tab groups notes into Overdue / Today / Upcoming from local data (fully offline).
- After every sync, the app reconciles **OS-local notifications** for the next 7 days of reminders (`features/reminders/notifications.ts`): permission is requested once, Android uses a dedicated notification channel, and stale schedules are cancelled when reminders change.
- **This is best-effort and honest**: neither iOS nor Android guarantees background delivery; notifications may be delayed or coalesced. The server's email/Web-Push reminder delivery is unchanged and unaffected.

## Project Structure

```
mobile-apps/
├── app/                        # Expo Router navigation routes
│   ├── _layout.tsx             # Root layout (services → Theme → Auth → Sync providers)
│   ├── index.tsx               # Gateway (no server → setup; no session → login; else tabs)
│   ├── server-setup.tsx        # First-launch server setup & capability probe
│   ├── auth/                   # login.tsx, register.tsx
│   ├── (tabs)/                 # notes (filters, trash, workspace switcher),
│   │                           # reminders, search, settings
│   └── note/[id].tsx           # Editor: checklists, color, reminder, tags,
│                               # attachments, conflict + trash banners
├── components/                 # Design-system components
│   ├── ui/                     # Button, TextField, Card, Chip, Banner, EmptyState,
│   │                           # Skeleton, ListRow, ColorPicker
│   └── notes/                  # NoteCard, ChecklistEditor, ReminderRow,
│                               # TagEditor, AttachmentStrip
├── features/
│   ├── auth/                   # SessionManager (SecureStore), AuthContext
│   ├── attachments/            # rules.ts (validation mirroring the server)
│   ├── notes/                  # NotesRepository, types
│   ├── reminders/              # local-notification scheduling (interface + RN impl)
│   ├── sync/                    # SyncEngine, OutboxQueue, SyncContext
│   └── workspaces/             # WorkspaceRepository (folders/tags/notifications)
├── services/
│   ├── api/                    # ApiClient, transports, zod contracts, endpoints,
│   │                           # server-check probe ladder
│   ├── attachments/            # binary cache (RN + Node implementations)
│   ├── db/                     # schema, migrations, expo-sqlite + better-sqlite3 drivers
│   ├── storage/                # SecureStore/AsyncStorage wrappers (injectable)
│   └── platform.ts             # RN service factory (db, prefs, secure, transport,
│                               # attachment cache, reminder scheduler)
├── theme/                      # tokens (primitive), themes (semantic), ThemeProvider
├── test/                       # vitest suites incl. real-backend integration
├── utils/                      # url policy, ids, time, json helpers
├── app.json                    # Expo configuration (splash via plugin, edge-to-edge)
├── eas.json                    # EAS Build profiles
└── package.json
```

## Development & Testing

### Prerequisites

- Node.js >= 20, npm >= 10

### Setup

```bash
cd mobile-apps
npm install
```

### Checks

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (includes React-compiler-era hooks/purity rules)
npm test            # 70 tests: unit + engine + durability + isolation + real backend
npm run predeploy   # all of the above
npx expo-doctor     # project & dependency health (20/20 checks)
```

### Starting the app

```bash
npm run start       # Metro bundler
npm run android     # dev server for a connected device/emulator
npm run ios         # dev server for a simulator
```

The first screen on a fresh install is always **Server Setup** — point it at your own Pocket Diary server (e.g. `http://10.0.2.2:3000` from an Android emulator running the backend on the host).

## Real-Backend Integration Suite

`test/real-backend.test.ts` boots the **actual compiled backend** (`backend/dist`, Fastify + SQLite) on ephemeral ports and drives the real mobile domain stack against it over real HTTP (production fetch transport, real cookie parsing, real SQLite file persistence). It verifies, in order:

1. Server probe + capability detection + sign-in
2. Download of existing notes; offline availability afterwards
3. Fully offline note creation and editing
4. Pending work surviving an app restart (driver reopen + session rebuild from SecureStore)
5. Reconnection syncing pending work **exactly once** (idempotent `clientId`)
6. Concurrent edits surfacing a 409 conflict (and "Keep mine" landing the local content server-side)
7. Deletes and restores synchronizing in both directions
8. Expired sessions preserving pending work; safe re-authentication; the outbox resuming
9. Two independent servers: switching between them never leaks either side's cached data
10. Attachments: offline-queued upload on a fresh note, byte-exact cached download, deletion, and server-side 415 rejection of mismatched magic bytes
11. Full reconciliation removing notes permanently purged server-side

```bash
cd ../backend && npm run build   # keep backend/dist current
cd ../mobile-apps && npm test
```

## Building with EAS & Development Builds

```bash
npx eas-cli build --profile development --platform android
npx eas-cli build --profile development --platform ios
npx eas-cli build --profile production --platform all
```

`eas.json` defines `development` (dev client, APK/simulator), `preview` (internal distribution), and `production` profiles. To use EAS cloud builds, run `npx eas-cli init` once to bind an EAS `projectId` into `app.json > extra.eas` (it is intentionally empty in the repo).

Local verification performed in this workspace (no Android SDK/Xcode available here):
- `npx expo export --platform android` and `--platform ios`: both Hermes bundles build cleanly.
- `npx expo prebuild --platform android --no-install`: native project, manifest (permissions, `adjustResize`, single-task launch), icons, and the notification icon all generate correctly.
- TypeScript/ESLint/tests/Expo Doctor all pass (see [Development & Testing](#development--testing)).

What still requires a machine with the native toolchains (or EAS): compiling and launching the actual APK/IPA, on-device permission prompts, notification delivery, and picker behavior. No claim is made that those were verified here.

## Backend Compatibility & Extensions

Backward-compatible additions shipped with this app:

1. **`GET /api/v1/system/info`** — public capability endpoint (`{name, version, apiPrefix, capabilities}`) used by the first-launch probe. Older servers fall back to `/health` with degraded capabilities.
2. **`POST /api/v1/memos` `clientId`** — optional idempotency key (8–64 chars) with a per-workspace UNIQUE index (migration v4): replaying an offline create returns the original memo instead of duplicating it.

Both are additive; the web frontend is untouched and the full backend suite (146 tests) passes.

## Limitations & Required Manual Testing

- **No background sync guarantee**: sync runs on launch, foreground, reconnect, pull-to-refresh, after mutations (debounced), and via Settings → Sync now / Full resync. The OS never guarantees background execution, and the app does not claim otherwise.
- **Local reminder notifications are best-effort**; delivery depends on OS scheduling. Server-side email/Web-Push reminders are the reliable channel.
- **Not editable on mobile (v1)**: note priority/status/folder/category assignment, link previews, version history, workspace invites — manage those from the web UI (they display on mobile).
- **Attachment uploads require the note to exist server-side first**; offline uploads queue and run after the note's create lands.
- **Requires device/emulator verification** (not possible in this environment): cold-start to first sync, on-device attachment pickers (photo library permissions), OS notification delivery, biometric-prompt behavior of SecureStore, and real-network conditions (TLS to a production host).
- **EAS project ID** must be bound (`npx eas-cli init`) before cloud builds.
