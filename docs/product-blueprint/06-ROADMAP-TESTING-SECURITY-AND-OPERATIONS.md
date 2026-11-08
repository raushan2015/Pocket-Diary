# Pocket-Dairy: Roadmap, Testing, Security and Operations

## 1. Delivery approach
Use incremental, test-backed delivery. The repository already has backend tests, web security/unit tests, Playwright journeys, and mobile Vitest coverage. Extend these suites. A feature is not complete because the UI renders; data, permissions, offline behavior, failure recovery, and deployment must also be tested.

## 2. Baseline status and caution
The repository includes auth, workspaces, notes, tags, folders, categories, attachments, reminders, notifications, import/export, backup, and system endpoints; Keep-style web interactions; and an Expo offline-first mobile client. The audit records prior security remediation, but that is historical evidence, not a permanent guarantee. Re-run checks on the current working tree before release.

## 3. Roadmap

### Phase 0: Baseline and gap audit
- Confirm branch, dirty files, runtime versions.
- Run backend build/tests, mobile typecheck/lint/tests, web unit tests, full Playwright suite.
- Compare requirements to actual source/UI.
- Capture desktop/tablet/mobile screenshots.
- Produce prioritized gap matrix.
**Exit:** reproducible baseline and known existing changes.

### Phase 1: Capture/editor
- Improve quick capture.
- Verify note/checklist switching.
- Test autosave on slow network, offline, and concurrent edits.
- Preserve focus/cursor.
- Improve save failure and retry.
**Exit:** no silent loss in tested failure scenarios.

### Phase 2: Notes home/organization
- Refine pinned section, grid/list, card actions.
- Clarify labels/folders/categories/favorites/pins.
- Verify archive/trash/restore/permanent delete.
- Test responsive behavior and pagination.
**Exit:** clear daily workflow on desktop and mobile.

### Phase 3: Search/reminders
- Validate FTS and filters at scale.
- Test multilingual search.
- Improve reminder status and timezone behavior.
- Verify recipient ownership and deduplication.
**Exit:** fast retrieval and correct reminder delivery.

### Phase 4: Mobile parity/offline
- Close core workflow gaps.
- Improve sync status and recovery.
- Test app termination during outbox work.
- Test account/server switching, conflicts, attachment retry.
- Document background execution limits.
**Exit:** offline work survives restart and syncs safely.

### Phase 5: Attachments/portability
- Verify upload/download limits and security.
- Improve preview/cache.
- Test Keep Takeout and Markdown imports.
- Test exports with attachments.
- Restore a backup into a clean disposable instance.
**Exit:** no broken references after import/export/restore.

### Phase 6: Collaboration/polish
- Verify role matrix.
- Improve invitations and membership UX.
- Improve accessibility/localization.
- Validate responsive performance.
**Exit:** collaboration and cross-platform UX are release-ready.

### Phase 7: Operations
- Upgrade/rollback runbooks.
- Backup restore drills.
- Monitoring and security gates.
**Exit:** operators can deploy, upgrade, and recover.

## 4. Test strategy

**Backend**
- Unit/service and Fastify route tests.
- Migration tests from previous schema.
- RBAC and tenant isolation.
- Validation and malformed input.
- Attachment signature/path safety.
- Reminder dedupe/timezone.
- Backup/restore.
- OpenAPI contract.

**Web**
- Markdown sanitizer and import parser unit tests.
- Playwright user journeys.
- Console/page-error checks.
- Keyboard/focus and responsive tests.
- Offline/service worker.
- Autosave and concurrent conflict.
- Import preview/error states.

**Mobile**
- Typecheck, lint, Vitest.
- Repository/outbox/sync/auth/attachment/reminder tests.
- Real-backend integration.
- iOS/Android export/build checks.
- Manual device tests for notifications, pickers, keyboard, and permissions.

## 5. Required end-to-end journeys
1. Register, sign in, create workspace.
2. Create plain note and checklist.
3. Quick capture and autosave.
4. Edit and inspect history.
5. Concurrent edit conflict across sessions.
6. Pin, favorite, label, color, reorder.
7. Search English and Japanese content.
8. Archive, trash, restore, permanent delete.
9. Set reminder and verify intended recipient.
10. Invite member and verify role restrictions.
11. Attempt cross-workspace access.
12. Upload/view/download/delete attachment.
13. Import Google Takeout and Markdown.
14. Export and verify content.
15. Work offline, restart, reconnect, sync.
16. Resolve mobile conflict without data loss.
17. Expire session with pending edits and re-authenticate.
18. Backup and restore database plus attachments.
19. Upgrade prior schema.
20. Verify desktop/tablet/mobile layouts.

## 6. Security release gates
- No unresolved critical/high vulnerability.
- No cross-workspace exposure or role bypass.
- No XSS in Markdown, labels, imported content, notifications.
- No SSRF in previews/push.
- No unsafe attachment serving or traversal.
- No secrets in logs, static files, diagnostics, or OpenAPI.
- Rate limits and lockout remain effective behind proxy.
- Sessions/invite/reset tokens hashed at rest.
- Reminder recipients scoped correctly.
- ZIP limits and safe extraction tested.

## 7. Performance test data
Benchmark workspaces with 1k and 10k notes, large bodies, many labels/folders, image-heavy notes, long version histories, and multiple syncing devices. Measure dashboard load, first save, search, pagination, thumbnail loading, mobile cold start, sync throughput, DB size, and backup duration. Set numeric targets only after representative measurements.

## 8. Backup and disaster recovery
- Snapshot SQLite consistently.
- Include attachment directory.
- Keep deployment config separate from plaintext secrets.
- Verify checksums.
- Bound retention and support off-host replication.
- Document restore order and file permissions.
- Restore into clean instance and verify notes, workspace links, attachment references, and login.
- Define RPO/RTO per deployment.
A backup without a successful restore drill is not verified.

## 9. Deployment and upgrades
- Docker Compose is supported baseline.
- Persistent data remains in named volume or explicit bind mount.
- Use health checks, restart policy, and non-root containers.
- Document APP_URL, COOKIE_SECRET, SMTP, VAPID, and proxy settings.
- Avoid unnecessary public backend ports.
- Back up before schema upgrades.
- Test upgrade against previous-release data.
- Document rollback; DB downgrade may be unsafe, so backup restore may be required.
- Never use production data volume for tests.

## 10. Observability
Collect operational metadata, not private note content:
- API counts/latency/errors.
- DB health/size.
- Attachment storage usage.
- Reminder scan outcomes.
- Backup age/replication status.
- Mobile sync outcomes, retries, conflicts.
- App/API version and capabilities.
Redact credentials, session IDs, reset/invite tokens, private URLs, and note contents from diagnostics.

## 11. Release checklist
- [ ] Working tree reviewed; user changes preserved.
- [ ] Backend build/tests pass.
- [ ] Web unit/E2E pass.
- [ ] Mobile typecheck/lint/tests pass.
- [ ] Migrations tested from prior release.
- [ ] Tenant and RBAC tests pass.
- [ ] Import/export pass.
- [ ] Attachment and backup/restore pass.
- [ ] Offline and conflict recovery pass.
- [ ] Desktop/tablet/mobile visual checks pass.
- [ ] Security review complete.
- [ ] Release and upgrade notes written.
- [ ] No commit/push without explicit authorization.

## 12. Limitations to communicate
- Mobile background sync is not guaranteed by iOS/Android.
- Mobile local reminders are best-effort and subject to OS policy.
- Shared workspace changes require server connectivity to synchronize.
- Google Keep export does not contain every possible metadata field.
- SQLite suits many self-hosted deployments; very large concurrent workloads may justify a separately evaluated database.
- Local save does not mean server sync; UI must distinguish them.

## 13. Change control
- Product behavior changes update requirements and tests.
- API changes update OpenAPI and mobile compatibility.
- Schema changes require versioned migrations and restore/upgrade tests.
- Security changes require threat-model review.
- Git commits and pushes remain with repository owner unless explicitly delegated.
