# Pocket-Dairy: Technical Requirements and Platform

## 1. Current stack (inspected repository baseline)

| Layer | Current implementation |
|---|---|
| Web | HTML, CSS, vanilla JavaScript SPA |
| Web server/proxy | Node.js frontend server |
| API | Node.js, TypeScript, Fastify 5 |
| Database | SQLite via better-sqlite3 |
| ORM/schema | Drizzle ORM |
| Search | SQLite FTS5 |
| Auth | HTTP-only cookie sessions |
| Files | Filesystem-backed attachments under persistent data |
| Mobile | Expo Router, React Native, TypeScript |
| Mobile DB | expo-sqlite |
| Mobile sync | Durable SQLite outbox, push/pull, optimistic concurrency |
| Notifications | Server in-app, optional SMTP/Web Push, best-effort mobile local |
| Deployment | Docker Compose |
| Tests | Vitest/Node tests and Playwright E2E |

Do not migrate the stack for fashion. A rewrite must prove a concrete benefit and include migration cost, risk, and compatibility plan.

## 2. Logical topology
```text
Browser -> Frontend server / proxy -> Fastify API
                                      |
                              Auth + workspace RBAC
                                      |
                                Domain services
                                  /        \
                           SQLite + FTS   Attachments
                                  |
                         Reminder / backup jobs

Expo app -> Local SQLite + durable outbox -> Sync engine -> Fastify API
         -> SecureStore for session credentials
```
Backend is authoritative for shared workspace data. Mobile SQLite is the local working copy and offline queue.

## 3. Repository boundaries

### Web
- `frontend/index.html`: shell and view structure.
- `frontend/css/`: tokens, layout, components, editor, auth, attachments.
- `frontend/js/api.js`: API client.
- `state.js`, `workspace-data.js`: client state/data.
- `navigation.js`, `sidebar.js`: navigation.
- `editor.js`, `memo-renderer.js`, `markdown.js`: editing/rendering.
- `keep-*.js`: quick capture, modal, labels, selection, DnD, import, drawing, shortcuts, sync, popovers.
- `calendar.js`, `notifications.js`, `voice-notes.js`: related UX.
- `sw.js`: service worker cache.

### Backend
- `app.ts`, `index.ts`, `config.ts`: server lifecycle/config.
- `db/schema.ts`, `db/migrate.ts`: schema and versioned migrations.
- `plugins/auth.ts`: auth context.
- `routes/`: HTTP boundary.
- `services/`: domain logic.

### Mobile
- `app/`: Expo Router screens.
- `features/notes/`: note types and repository.
- `features/sync/`: outbox and sync engine.
- `features/auth/`: session manager.
- `features/reminders/`: local scheduling.
- `services/api/`: transport, contracts, endpoints.
- `services/db/`: local schema and drivers.
- `theme/`: design tokens and themes.

## 4. Architecture requirements

### API and domain
- Keep business rules in backend services, not only UI handlers.
- Validate inputs at Fastify boundaries and document with existing Swagger/OpenAPI.
- Keep web/mobile contracts aligned.
- Use consistent error envelopes and no-store behavior for authenticated data.
- Keep handlers thin and service logic testable.

### Authentication and authorization
- Preserve HTTP-only browser cookie sessions.
- Mobile uses its existing SecureStore-backed session handling.
- Session tokens remain high-entropy and hashed at rest.
- Verify workspace membership and role on every operation.
- Apply identical rules to web, mobile, import/export, attachments, and jobs.
- Avoid resource enumeration across workspaces.

### Database
- SQLite remains the default self-hosted database.
- Preserve WAL and transaction safety.
- Keep Drizzle schema and SQL migration definitions synchronized.
- Use immutable versioned migrations.
- Add indexes based on query plans and measured use.
- Keep binary data out of note text and FTS.
- Bound version history and define retention.
- Test upgrades from previous schema versions and fresh installs.

### Search
- Keep FTS5 as baseline.
- Index meaningful title/body text only.
- Update FTS only when indexed fields change.
- Scope every query to authorized workspace.
- Test multilingual text, punctuation, deleted/archive semantics, and filters.

### Web
- Preserve SPA/event delegation conventions unless refactor is justified.
- Centralize API calls.
- Use safe DOM APIs and the current Markdown sanitizer/URL allow-lists.
- Maintain CSP/security headers.
- Avoid full rerenders that destroy editor cursor/focus.
- Test keyboard, touch, and responsive behavior.

### Mobile
- Local SQLite provides immediate local reads/writes.
- SecureStore holds credentials, never AsyncStorage or SQLite.
- Outbox writes are durable and atomic with local note mutations.
- Preserve FIFO, idempotent create, backoff, and conflict handling.
- Do not silently resolve conflicts.
- Scope local data by server and user.
- Do not promise guaranteed background execution.

## 5. Offline sync contract
Every synced entity must define:
- Stable client ID and server ID mapping.
- Idempotency strategy.
- Mutation order and dependencies.
- Conflict policy.
- Deletion/tombstone behavior.
- Retryable and terminal error handling.
- Account/server isolation.
- Local schema migration.

Current sync flow: local transaction + outbox, FIFO push, version check, 409 conflict parking, paginated workspace pull, periodic full reconciliation, reminder reconciliation. Do not add ad hoc sync paths.

## 6. Attachments
Current server accepts JPEG, PNG, WebP, GIF, PDF, TXT, and MD subject to a 5 MB limit. Server checks magic bytes. Only safe images render inline. Mobile queues uploads and may wait for note creation first.
- Do not use user-supplied file paths.
- Prevent traversal and symlink escapes.
- Keep attachment storage private and route-authorized.
- Keep cache scoped by server/user.
- Use thumbnails and lazy loading.
- Update backend, web, mobile, tests, and docs together if limits/types change.

## 7. Reminders and notifications
- Server scan is durable source for shared workspace in-app notifications.
- Reminder recipient is the user who owns the effective reminder, not every workspace member.
- Email/Web Push are optional and degrade safely.
- Mobile local notifications are best-effort and reconciled after sync.
- Store IANA timezone; do not depend on server timezone.
- Prevent overlapping scans and duplicate delivery.

## 8. Deployment and operations
- Keep Docker Compose supported.
- Persist SQLite and attachments in data volume.
- Keep APP_URL and COOKIE_SECRET required in production.
- Preserve proxy trust, rate limits, CSP, security headers, and non-root containers.
- Health checks must not expose secrets.
- Backups include database and attachments; support off-host replication.
- Never run destructive tests against the production named volume.

## 9. Performance
- Paginate note lists; avoid unbounded workspace loads.
- Debounce search and autosave.
- Use indexed workspace filters and FTS.
- Avoid rerendering all cards for one note update.
- Benchmark 1k/10k note workspaces, attachment-heavy notes, and mobile sync.
- Define retention for versions, notifications, and logs.

## 10. Versioning and compatibility
- Keep API additions backward-compatible where possible.
- Use existing system info/capability endpoint for feature discovery.
- Treat web, API, and mobile as separately versioned but contract-compatible.
- Include migration and rollback notes.
- Do not remove API fields until supported clients have migrated.

## 11. Decisions requiring evidence
- Whether folder hierarchy and categories both add value.
- Whether favorites are distinct from pins.
- Whether Markdown is sufficient or structured blocks are needed.
- Whether attachment limits should be configurable.
- Whether sync needs server tombstones.
- Whether PostgreSQL is justified for larger concurrent deployments.
