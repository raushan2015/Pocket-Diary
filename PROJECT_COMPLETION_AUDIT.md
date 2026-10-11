# Memo Manager Completion Audit

**Status:** In progress. The application is not release-certified.
**Source of truth:** `system-design.md`, `.agents/outputs/memo-manager-frontend-specification.md`, and `.agents/outputs/memo-manager-backend-architecture.md`.
**Runtime:** Docker Compose, public port 8080, persistent volume `memo_manager_data`.

## Verified in this session

- Docker image builds and the production container reports healthy.
- The existing persistent database volume was preserved. No production data reset was performed.
- Backend build passes.
- Backend tests: 38 passing across 9 test files.
- Browser end-to-end tests: 9 passing against an isolated Docker container and test-only database.
- Production dependency audit: 0 vulnerabilities.
- Local SQLite online backup creates a restorable snapshot and retains the newest 7 snapshots.
- Cross-site state-changing requests are rejected when their Origin does not match the forwarded host and protocol.
- Global request rate limiting is enabled, with tighter limits on registration and login.
- Memo creation and updates reject category or folder IDs from a different workspace.
- Memo listing validates pagination and caps page size at 100.
- JSON workspace exports now include soft-deleted memos in Trash.
- Frontend API calls use same-origin paths instead of hard-coded localhost URLs.
- Production requires a cookie secret supplied through the ignored, permission-restricted `.env` file.

## Known incomplete requirements

### Priority 0: operational safety

- [ ] Configure off-host backup replication or a separate backup destination. Local backups in the same Docker volume do not protect against loss of that volume or host.
- [ ] Document and test a full database restore procedure.
- [ ] Add an automated test that verifies backup retention and recovery after restoring the snapshot.

### Priority 1: advertised product functionality

- [x] Folder management UI now lists workspace folders, filters notes by folder, and allows assigning a note to a folder.
- [~] Memo revision history UI can load saved versions, but restoring one as a new version and polished history navigation remain unfinished.
- [x] Server-backed image attachments now support authenticated upload, list, inline download, and delete APIs, using workspace-scoped storage, 5 MB per-image limits, PNG/JPEG/WebP MIME allowlisting, and tenant authorization checks. Aggregate storage quotas and object-store integration remain future work.
- [~] Touch-friendly whiteboard canvas supports drawing, undo, clear, and inserting a PNG into a note. Its strokes are in-memory only before insertion; persistent standalone/multi-page whiteboards are not implemented.
- [~] Mobile editor now flushes dirty state before in-app back navigation and listens for browser history back; actual iOS/Android device validation remains required.
- [ ] Calendar and upcoming reminders are static mock content. There is no reminder table, API, scheduler, or real calendar filtering.
- [ ] Workspace membership/invitations and an activity audit log are not implemented.
- [ ] Storage usage and plan/upgrade UI are placeholders, not connected to real usage or billing.

### Priority 2: release hardening

- [ ] Add broader UI tests for folders, tags, categories, filters, sorting, permanent deletion, and revision history.
- [ ] Capture browser console errors and failed network requests in the E2E suite.
- [ ] Add request schema validation for all API boundaries.
- [ ] Review account recovery, session expiry cleanup, and production security headers.
- [ ] Resolve or document moderate vulnerabilities found in the development dependency tree. Production dependencies currently audit clean.
- [ ] Validate installation and upgrade from a fresh environment without removing the existing production volume.

## Safety rules

- Do not run E2E tests against the production database. Use a separate Docker container and a separate test volume.
- Do not run `docker compose down -v` for the production project.
- Do not delete or reseed `memo_manager_data` without explicit approval.
- Rebuild and verify the Docker image after code changes.
- Do not mark the project complete until the remaining requirements are either implemented and tested or explicitly removed from the approved scope.
