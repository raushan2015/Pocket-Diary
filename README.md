# Notes

A self-hosted, responsive note-taking app for capturing, organizing, searching, and managing personal or team notes. Notes provides a clean notes-first interface backed by a Fastify API and SQLite, with workspaces and tenant-aware access controls.

Repository: [github.com/raushan2015/notes](https://github.com/raushan2015/notes)

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start with Docker](#quick-start-with-docker)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Testing](#testing)
- [Data and file storage](#data-and-file-storage)
- [Security notes](#security-notes)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

## Features

### Notes and organization

- Create, edit, archive or move notes to trash, and restore trashed notes.
- Search note content with SQLite full-text search.
- Organize notes in workspaces, folders, categories, and labels.
- Pin important notes and mark favorites.
- Filter notes and sort by supported fields such as update time, creation time, due date, priority, and title.
- Set note status, priority, due dates, and checklist items.
- Choose a persistent note-card color.
- Upload and manage supported image attachments.
- Responsive, mobile-friendly interface with dark and light themes.

### Accounts and workspaces

- User registration and sign-in with password strength meter and confirmation.
- Password hashing and cookie-based sessions, with active-session management
  (sign out of all other devices) and password change in Account Settings.
- Workspace membership and role-aware authorization (owner, admin, editor, viewer).
- Email invitations with shareable invite links: invite by email, copy or revoke
  pending invitations, change member roles, and remove members.
- Tenant-aware data access to help prevent cross-workspace data exposure.
- Import legacy browser-stored notes through the migration workflow, and import
  notes from Google Keep (Google Takeout ZIP) or Markdown (.md) files directly in
  Account Settings — each Markdown file becomes a new note carrying the full
  document contents, with frontmatter title/tags applied.

### Reminders

- Keep-style reminder popover (later today, tomorrow, next week, custom time) on notes.
- Server-side reminder scanning creates persistent in-app notifications with
  unread badge and dropdown, so reminders fire even when the note list is not loaded.
- Optional email delivery (SMTP) and Web Push (VAPID) so reminders reach users
  outside the app; both degrade gracefully to in-app notifications when unconfigured.

### Operations

- Docker image and Docker Compose deployment.
- Persistent SQLite database and attachment storage in the application data volume.
- Scheduled SQLite online backups with retention, plus optional off-host
  replication (`BACKUP_REPLICATION_DIR`) outside the data volume.
- Backup status (last snapshot, replication state) visible in Account Settings.
- Request schema validation at all API boundaries and global rate limiting.
- Health endpoint for container health checks.
- Backend unit/integration tests and browser-based end-to-end tests.

> Notes is an actively developed project. Review [Known limitations](#known-limitations) before using it for sensitive or business-critical data.

## Architecture

The project is organized into three main areas:

| Path | Purpose |
| --- | --- |
| `frontend/` | Single-page web interface, CSS, client-side state, API client, editor enhancements, and Markdown rendering. |
| `backend/` | Fastify server, authentication, authorization, workspace logic, note services, database schema/migrations, and API routes. |
| `tests/` | Playwright e2e regression suite, split into independent journey files under `tests/e2e/` plus the shared harness in `tests/e2e/_helpers.js`. |
| `Dockerfile` | Multi-stage container build for the application. |
| `docker-compose.yml` | Local and self-hosted container deployment. |

The backend uses **Node.js**, **TypeScript**, **Fastify**, and **SQLite**. Drizzle ORM is included for database access/schema work, with `better-sqlite3` as the SQLite driver. The frontend is plain JavaScript, HTML, and CSS. Browser end-to-end tests use Playwright.

The application container serves the frontend and proxies application API requests to the backend. SQLite and uploaded attachments are stored under the persistent application data directory.

## Requirements

For the recommended Docker deployment:

- Docker Engine
- Docker Compose v2
- A host port available for the web interface (8080 by default)

For development without Docker:

- Node.js 22 or compatible
- npm
- Build tools required by `better-sqlite3` on platforms without a prebuilt binary
- Chromium installed through Playwright for browser tests

## Quick start with Docker

1. Clone the repository:

   ```bash
   git clone https://github.com/raushan2015/notes.git
   cd notes
   ```

2. Create a local environment file and generate a unique cookie secret:

   ```bash
   cp .env.example .env
   ```

   Generate a secret with:

   ```bash
   openssl rand -hex 32
   ```

   Put the generated value in `.env` as `COOKIE_SECRET`. Never commit this file.

3. Build and start the app:

   ```bash
   docker compose up -d --build
   ```

4. Open [http://localhost:8080](http://localhost:8080), or use the port configured with `PORT`.

5. Check service health:

   ```bash
   curl http://localhost:8080/health
   docker compose ps
   docker compose logs -f memo-manager
   ```

To stop the app without deleting persistent data:

```bash
docker compose down
```

Do not use `docker compose down -v` unless you intentionally want to delete the named data volume and its contents.

## Local development

### Backend

```bash
cd backend
npm ci
npm run dev
```

Build the backend:

```bash
npm run build
```

Run backend tests:

```bash
npm test
```

The backend supports environment-based configuration. For local development, check the database configuration and server startup code under `backend/src/`.

### Frontend

The frontend is served by the application container in the recommended setup. A lightweight development server is also available:

```bash
cd frontend
npm run dev
```

If the frontend is run separately, configure its API base/proxy to point to the backend. The frontend's `server.js` documents the local serving behavior.

### Browser end-to-end tests

Install test dependencies and the Playwright browser if needed:

```bash
cd tests
npm ci
npx playwright install chromium
```

Run the suite against a running test instance:

```bash
BASE_URL=http://127.0.0.1:8080 npm test
```

The suite is split into independent journey files (`tests/e2e/*.test.js`) that run
in parallel (up to 4 at a time). Each file launches its own isolated Chromium
instance and registers its own timestamped test accounts, except
`01-alice-core-journey.test.js`, whose journeys 1–9 form one continuous story in
a single browser. Shared helpers — browser launch, screenshot directory and the
in-memory ZIP builder — live in `tests/e2e/_helpers.js`.

Set `BASE_URL` to the URL of the instance under test. The suite creates and modifies test accounts and notes. **Do not point it at a production instance or a database containing real user data.**

## Configuration

Create a local `.env` file from `.env.example`. Available Docker Compose settings:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `COOKIE_SECRET` | Yes | None | A unique, random secret used to sign session cookies. Use at least 32 characters and keep it private. |
| `PORT` | No | `8080` | Host port published for the web interface. The application listens on port 8080 inside the container. |

The Compose service configures `DATABASE_PATH=/app/data/memo_manager.db` and the internal backend port automatically. Do not expose the database file publicly.

## Data and file storage

Docker Compose creates a named volume called `memo_manager_data` and mounts it at `/app/data`. This directory contains the SQLite database and attachment files.

- Keep the volume persistent when upgrading or recreating the container.
- Back up the database and attachments together, using a consistent backup procedure.
- Restrict filesystem and backup access because notes and uploaded files may contain private information.
- The repository ignores local data, environment files, dependency folders, and build artifacts to reduce the risk of committing private or generated content.

## Backup and restore

The backend takes automatic online snapshots of the SQLite database (default every
24 hours, newest 7 kept) into `/app/data/backups`. When `BACKUP_REPLICATION_DIR` is
configured and mounted, every fresh snapshot is also copied to that off-volume
location with its own retention (`BACKUP_REPLICATION_RETENTION`). Account Settings →
Backups shows the last snapshot time and the replication state.

### Full restore procedure (tested in `backend/test/backup.test.ts`)

1. Stop the application so no new writes race the restore:

   ```bash
   docker compose stop memo-manager
   ```

2. Copy the newest snapshot out of the data volume to a working file:

   ```bash
   docker run --rm -v memo_manager_data:/data -v "$PWD":/out alpine \
     sh -c "cp /data/backups/$(ls -t /data/backups | head -1) /out/restored.db"
   ```

3. Replace the live database with the snapshot (keep the original aside):

   ```bash
   docker run --rm -v memo_manager_data:/data -v "$PWD":/out alpine \
     sh -c "mv /data/memo_manager.db /data/memo_manager.db.pre-restore && cp /out/restored.db /data/memo_manager.db && rm -f /data/memo_manager.db-wal /data/memo_manager.db-shm"
   ```

4. Restart and verify: notes are back, and the health endpoint responds.

   ```bash
   docker compose up -d memo-manager
   curl -f http://localhost:8080/health
   ```
Snapshots are consistent SQLite backups; the automated test restores one, runs
`PRAGMA integrity_check`, and confirms the data round-trips. If attachments matter,
back up `/app/data/attachments` alongside the database volume.

## Security notes

- Use a long, random `COOKIE_SECRET` and keep it out of source control.
- Serve the application behind HTTPS when it is accessible outside a trusted local network.
- Keep Docker, Node.js, and npm dependencies updated.
- Use least-privilege accounts and restrict access to the host, data volume, and backups.
- Review authorization, upload validation, session settings, and deployment configuration before exposing the service publicly.
- Make and test backups before upgrades or schema changes.

This documentation is not a security certification. Review the implementation and deployment for your threat model before relying on it for sensitive data.

## Known limitations

- This deployment is a **self-hosted community edition**: every feature is
  enabled and there is no billing backend or paid tier.
- Authentication is email/password with session cookies. Social/OAuth provider
  sign-in is not integrated; the placeholder buttons were removed from the UI.
- Password recovery requires SMTP (`SMTP_HOST`) to be configured so reset
  emails can be delivered. Without SMTP, users should ask the instance
  administrator for help (the first registered account is the instance admin).
- Email reminders and browser push require SMTP / VAPID configuration; without
  them, reminders surface as in-app notifications while the app is open.
- Google Keep imports convert titles, text, checklists, labels, and inline
  images; note colors and pinned state are not included in Google's export format.
- The notes grid paginates 100 notes at a time via a "Load more" control; very
  large workspaces load incrementally rather than all at once.
- Attachment storage is local to the application data volume. Object storage and per-workspace quota management are not configured by default.
- This project is under active development; behavior and APIs can change between revisions.

### Operational limits and horizontal scaling (ARCH-02)

The application intentionally runs as a **single active instance**:

- **SQLite (WAL mode) is embedded in the application container.** Spreading
  traffic across replicas that share one database file will corrupt it or
  deadlock on `SQLITE_BUSY` locks. Do **not** scale this service with multiple
  replicas against the same data volume.
- **Attachments are stored on the container filesystem** (`/app/data/attachments`),
  so uploads and downloads must hit the same node that owns the data volume.
- Use a single container (as provided by `docker-compose.yml`) and scale
  vertically: SQLite in WAL mode comfortably serves small teams and personal
  instances with thousands of notes.
- For high availability, rely on the **backup scheduler with off-host
  replication** (`BACKUP_REPLICATION_DIR`) and container restart policy, not on
  replica count. See [Backup and restore](#backup-and-restore).
- If you later need multi-node horizontal scaling, the migration path is:
  1. Swap the Drizzle SQLite adapter for the PostgreSQL adapter.
  2. Move attachment storage to S3/MinIO-compatible object storage.
  3. Run multiple stateless app replicas behind a load balancer.
  These changes are deliberate non-goals of the current self-hosted edition.

## Contributing

Contributions, bug reports, and improvement suggestions are welcome.

1. Fork the repository and create a focused branch.
2. Make the change and add or update tests where appropriate.
3. Run `npm test` in `backend/` and the relevant browser tests in `tests/`.
4. Open a pull request describing the change, rationale, and verification performed.

Please do not include credentials, real user data, database files, uploaded private attachments, or environment files in issues or pull requests.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE) for the full text.
