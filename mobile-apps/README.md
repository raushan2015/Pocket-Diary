# Pocket Diary Mobile

Production-grade, offline-first mobile application for self-hosted [Pocket Diary](..) servers, built with Expo, React Native, TypeScript, Expo Router, and SQLite.

Supports **iOS** and **Android** natively, with complete offline notes creation, editing, checklist support, background reconciliation, and durable synchronization.

---

## Table of Contents

- [Key Architectural Highlights](#key-architectural-highlights)
- [Technology Stack](#technology-stack)
- [First-Launch Server Setup & Security Model](#first-launch-server-setup--security-model)
- [Offline-First Architecture & Durable Outbox](#offline-first-architecture--durable-outbox)
- [Conflict Handling & Reconciliation](#conflict-handling--reconciliation)
- [Project Structure](#project-structure)
- [Development & Testing](#development--testing)
- [Building with EAS & Development Builds](#building-with-eas--development-builds)
- [Backend Compatibility & Extensions](#backend-compatibility--extensions)

---

## Key Architectural Highlights

1. **Self-Hosted First**: The first screen on a clean install is the **Server Setup** gateway. No hardcoded server addresses; users connect to their own self-hosted Pocket Diary instances.
2. **True Offline-First**: All notes, checklists, categories, tags, and workspaces are stored locally in an embedded **SQLite** database (`pocket-diary.db`). Changes are saved immediately and work with zero network connectivity.
3. **Durable Mutation Queue (Outbox)**: Mutations are stored durably in an ACID SQLite `outbox` table with stable `clientId` UUIDs before any network request is attempted. Operation coalescing (`create` + `update` → `create`, `update` + `update` → `update`, `create` + `delete` → no-op) optimizes transmission.
4. **Secure Credential Isolation**: Sensitive tokens are strictly stored in `expo-secure-store` (iOS Keychain / Android Encrypted Keystore). Never in plain AsyncStorage or SQLite.
5. **Strict Multi-Server & Multi-Account Isolation**: All database tables and outbox queues are keyed by `(server_key, user_id)`. Switching instances or accounts never leaks data.
6. **Graceful Conflict Handling**: Detects HTTP 409 version conflicts via optimistic concurrency version numbers. Conflicted notes are flagged visually, and users choose between **"Keep Mine"** (overwriting server with local edits) or **"Use Server"** (updating to latest server copy).

---

## Technology Stack

- **Framework**: Expo SDK 53, React Native 0.79, React 19, TypeScript
- **Navigation**: Expo Router (typed file-based routes)
- **Database & Persistence**: `expo-sqlite` (production) and `better-sqlite3` (Node.js test harness)
- **Secrets Storage**: `expo-secure-store` (iOS Keychain & Android Keystore)
- **Preferences Storage**: `@react-native-async-storage/async-storage`
- **Network & Reachability**: `@react-native-community/netinfo`
- **Styling & Theming**: Custom typed token-based design system (`theme/tokens.ts`, `theme/themes.ts`) supporting Light and Dark modes
- **Validation**: Zod client-side schemas matching the backend OpenAPI specifications
- **Icons**: `@expo/vector-icons` (Ionicons)
- **Test Runner**: Vitest

---

## First-Launch Server Setup & Security Model

When launched on a fresh install, Pocket Diary routes the user to `/server-setup`:

- **URL Normalization**: Automatically trims whitespace, strips redundant paths/trailing slashes, and defaults to `https://`.
- **Capability Probe**: Connects to `GET /api/v1/system/info` (or `/health` on older servers) to verify the instance identity, version, and supported capabilities (such as `memoClientId`).
- **TLS & HTTP Policy**:
  - **HTTPS is enforced** for remote servers to protect user credentials and note content.
  - Plain **HTTP is restricted** to loopback addresses (`localhost`, `127.0.0.1`, `10.0.2.2` Android emulator alias) or private RFC1918 LANs (`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`).
  - LAN HTTP requires an explicit user acknowledgment of the unencrypted connection.
- **Authentication**: The Fastify backend issues HTTP-only `memo_session` cookies. React Native's implicit cookie jar is unreliably shared across native fetch/webview environments. Pocket Diary Mobile captures the `Set-Cookie` token upon `/auth/login` or `/auth/register`, securely persists it in `expo-secure-store`, and injects `Cookie: memo_session=<token>` on every API call with `credentials: 'omit'`.

---

## Offline-First Architecture & Durable Outbox

### Database Schema

Local SQLite database (`services/db/schema.ts`) contains:
- `notes`: Local notes with Google Keep-style checklists, colors, priority, status, tags, and sync state.
- `outbox`: Durable mutation queue with operation status (`pending`, `in_flight`, `conflicted`, `failed`), retry attempts, and exponential backoff timestamps.
- `workspaces`: Workspaces cache.
- `folders`, `categories`, `tags`: Categorization and metadata cache.
- `notifications`: Reminders and notifications cache.
- `sync_state`: Per-workspace sync cursors (`last_pull_at`, `last_full_sync_at`).

### Durable Outbox Queue

Every mutation (`create`, `update`, `delete`, `restore`) is committed locally within a transaction to `notes` and `outbox`:
- Operations have unique operation IDs and a stable `clientId` UUID.
- Exponential backoff with random jitter prevents thundering herd issues on server reconnection.
- Outbox coalescing merges multiple local edits into a single operation before network transmission.

---

## Conflict Handling & Reconciliation

- **Optimistic Locking**: Every note tracks `serverVersion`. Mutations send `baseVersion` to the server. If another device updated the note in the meantime, the server returns `409 Conflict`.
- **Conflict Resolution**: The mobile app marks the note `conflicted` and presents an actionable banner:
  - **Keep Mine**: Omits version constraints and forces an update of the server note with the local copy.
  - **Use Server**: Discards local changes and pulls down the latest server copy.
- **Absence Reconciliation**: Detects hard deletes on the server during full synchronization without accidentally resurrecting purged notes or purging freshly pushed local notes.

---

## Project Structure

```
mobile-apps/
├── app/                        # Expo Router navigation routes
│   ├── _layout.tsx             # Root layout with Theme, Auth, and Sync providers
│   ├── index.tsx               # Gateway router (server setup vs auth vs tabs)
│   ├── server-setup.tsx        # First-launch server setup & capability probe
│   ├── auth/                   # Sign in and register screens
│   │   ├── login.tsx
│   │   └── register.tsx
│   ├── (tabs)/                 # Main application tabs
│   │   ├── _layout.tsx         # Bottom tab bar configuration
│   │   ├── notes.tsx           # Notes dashboard with workspace selector & filters
│   │   ├── reminders.tsx       # Reminders grouped by overdue and upcoming
│   │   ├── search.tsx          # Instant local full-text search
│   │   └── settings.tsx        # Server, account, sync status & theme settings
│   └── note/
│       └── [id].tsx            # Note & checklist editor with conflict resolution
├── components/                 # Reusable UI component system
│   ├── ui/                     # Button, TextField, Card, Chip, Banner, EmptyState, Skeleton, ListRow, ColorPicker
│   └── notes/                  # NoteCard, ChecklistEditor
├── features/                   # Core business logic & repositories
│   ├── auth/                   # SessionManager, AuthContext
│   ├── notes/                  # NotesRepository, types, serialization
│   ├── workspaces/             # WorkspaceRepository
│   └── sync/                   # SyncEngine, OutboxQueue
├── services/                   # Storage, database, and API clients
│   ├── api/                    # ApiClient, transport, endpoints, contracts, server-check
│   ├── db/                     # SqliteDriver, schema, database runner
│   ├── storage/                # KeyValueStore, SecureStore, PrefsStore
│   └── platform.ts             # Service factory for React Native and test runtimes
├── theme/                      # Tokens, Light/Dark themes, ThemeProvider
├── test/                       # Comprehensive Vitest test suites (43 tests)
├── utils/                      # URL normalization, time formatting, ID generation
├── app.json                    # Expo configuration
├── eas.json                    # EAS Build profiles
└── package.json
```

---

## Development & Testing

### Prerequisites

- Node.js >= 20
- npm >= 10

### Setup

```bash
cd mobile-apps
npm install
```

### Running Tests

```bash
# Run all Vitest suites
npm test

# Run tests in watch mode
npm run test:watch
```

### Type Checking & Linting

```bash
# Run TypeScript check
npm run typecheck

# Run ESLint check
npm run lint

# Run predeploy validation (typecheck + lint + test)
npm run predeploy
```

### Starting Expo Development Server

```bash
# Start Metro bundler
npm run start

# Run on iOS simulator
npm run ios

# Run on Android emulator
npm run android
```

---

## Building with EAS & Development Builds

The project is configured for EAS Build (`eas.json`) and Expo Prebuild:

```bash
# Build development build for Android
npx eas-cli build --profile development --platform android

# Build development build for iOS
npx eas-cli build --profile development --platform ios

# Production release build
npx eas-cli build --profile production --platform all
```

---

## Backend Compatibility & Extensions

To ensure robust mobile synchronization, two backward-compatible additions were made to the Fastify backend:

1. **`GET /api/v1/system/info`**:
   - Public capability endpoint returning server version, API prefix, and capability flags (`memoClientId: true`).
   - Mobile clients probe this on first connect. If a legacy server returns `404`, the app gracefully falls back to `/health`.
2. **`POST /api/v1/memos` (`clientId` Support)**:
   - Optional `clientId` field stored with a unique constraint `(workspace_id, client_id)`.
   - Ensures idempotent note creation when offline network requests are retried.
