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

- User registration and sign-in.
- Password hashing and cookie-based sessions.
- Workspace membership and role-aware authorization.
- Tenant-aware data access to help prevent cross-workspace data exposure.
- Import legacy browser-stored notes through the migration workflow.

### Operations

- Docker image and Docker Compose deployment.
- Persistent SQLite database and attachment storage in the application data volume.
- Health endpoint for container health checks.
- Backend unit/integration tests and browser-based end-to-end tests.

> Notes is an actively developed project. Review [Known limitations](#known-limitations) before using it for sensitive or business-critical data.

## Architecture

The project is organized into three main areas:

| Path | Purpose |
| --- | --- |
| `frontend/` | Single-page web interface, CSS, client-side state, API client, editor enhancements, and Markdown rendering. |
| `backend/` | Fastify server, authentication, authorization, workspace logic, note services, database schema/migrations, and API routes. |
| `tests/` | Playwright browser-based end-to-end regression suite. |
| `system-design.md` | System design notes and API/data architecture documentation. |
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

## Security notes

- Use a long, random `COOKIE_SECRET` and keep it out of source control.
- Serve the application behind HTTPS when it is accessible outside a trusted local network.
- Keep Docker, Node.js, and npm dependencies updated.
- Use least-privilege accounts and restrict access to the host, data volume, and backups.
- Review authorization, upload validation, session settings, and deployment configuration before exposing the service publicly.
- Make and test backups before upgrades or schema changes.

This documentation is not a security certification. Review the implementation and deployment for your threat model before relying on it for sensitive data.

## Known limitations

- Authentication providers such as social login are not configured by default.
- Password recovery and external email/push reminders require additional integration; the current reminder experience is in-app.
- Secure sharing and external notification delivery may require future implementation.
- Attachment storage is local to the application data volume. Object storage and per-workspace quota management are not configured by default.
- This project is under active development; behavior and APIs can change between revisions.

## Contributing

Contributions, bug reports, and improvement suggestions are welcome.

1. Fork the repository and create a focused branch.
2. Make the change and add or update tests where appropriate.
3. Run `npm test` in `backend/` and the relevant browser tests in `tests/`.
4. Open a pull request describing the change, rationale, and verification performed.

Please do not include credentials, real user data, database files, uploaded private attachments, or environment files in issues or pull requests.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE) for the full text.
