# Pocket-Dairy: Implementation Plan, API and Data Evolution

## 1. Strategy
Improve the current repository incrementally. First inventory actual behavior, then close gaps, then consider structural changes. Do not rewrite the vanilla-JS frontend into a new framework or replace SQLite as a starting assumption. Existing features and tests represent real investment.

## 2. Workstream A: Product gap audit
- Map every current screen and navigation state.
- Compare requirements with source and browser behavior.
- Mark features existing, partial, broken, or missing.
- Identify overlapping concepts (folders/categories/labels, favorites/pins).
- Capture desktop, tablet, and mobile screenshots.
- Record severity, affected layer, dependencies, and acceptance criteria.

Deliverable: prioritized product gap matrix.

## 3. Workstream B: Capture and editor
- Make quick capture immediately available.
- Make text and checklist modes equally discoverable.
- Verify autosave on slow network, offline, and concurrent edits.
- Preserve cursor/focus during rerender.
- Show accurate save states and retry.
- Improve attachment/link preview feedback.
- Make close/back safe while saves are in flight.
- Test mobile editing with keyboard open.
- Verify undo/redo and whiteboard insertion.

Acceptance: saved edits survive reload; failures are visible/retryable; concurrent edits never silently overwrite.

## 4. Workstream C: Notes home and organization
- Refine pinned section, responsive grid, and compact list.
- Improve card actions and touch equivalents.
- Clarify label/folder/category/favorite/pin semantics.
- Distinguish archive, trash, restore, and permanent delete.
- Add bulk selection only with explicit permission rules.
- Preserve pagination and stable custom order.
- Add loading, empty, error, and no-results states.

## 5. Workstream D: Search and retrieval
- Audit FTS5 triggers and query plans.
- Test English, Japanese, emoji, punctuation, and mixed-language notes.
- Combine text search and filters.
- Cancel stale searches and debounce.
- Keep results workspace-scoped.
- Define archive/trash search behavior.
- Test pagination and sort ties.

## 6. Workstream E: Mobile parity and offline
- Audit web/mobile parity screen by screen.
- Prioritize capture, checklist, labels, pin/archive/trash, search, reminders, attachments, and themes.
- Keep local-first reads/writes and durable outbox.
- Test termination during sync/upload.
- Test server/account switching.
- Test conflicts, retry, and session expiry.
- Distinguish "Saved on device" from "Synced to server".
- Document OS background execution limits.

## 7. Workstream F: Collaboration
- Verify role behavior for every existing route.
- Improve workspace switcher and invite UX.
- Clarify personal/shared workspace context.
- Test invite expiry/revocation/acceptance.
- Test owner transfer, leave, member removal, and reminder recipient behavior.
- Add activity history only with explicit privacy and retention rules.

## 8. Workstream G: Import/export
- Test real Google Takeout ZIP and extracted folder formats.
- Preserve only metadata present in source.
- Preview counts and transformations.
- Report skipped/failed entries.
- Handle duplicate imports predictably.
- Harden malformed JSON, oversized archives, nested paths, and filenames.
- Export notes and attachments with stable references.
- Document full backup separately from user export.

## 9. Existing API domains

Prefix: `/api/v1`. Use Fastify schemas, OpenAPI, thin handlers, services, workspace scoping, pagination, and optimistic concurrency.

| Domain | Existing route family |
|---|---|
| Auth | `/auth` |
| Notes | `/memos` |
| Attachments | `/attachments` |
| Folders | `/folders` |
| Categories | `/categories` |
| Tags / labels | `/tags` |
| Workspaces / members | `/workspaces` |
| Invitations | `/invites` |
| Notifications | `/notifications` |
| Push | `/push` |
| Import / export | `/migration` |
| System / capabilities / backup status | `/system` |

Do not add duplicate endpoints for existing capabilities.

## 10. Data evolution rules
- Update Drizzle schema and SQL migration together.
- Use immutable versioned migrations.
- Test fresh install and upgrade from previous version.
- Preserve note and attachment IDs.
- Avoid destructive renames without compatibility migration.
- Keep mobile local schema migration separate but API-compatible.
- Add indexes only with query evidence.
- Potential future enhancements (not assumed implemented): explicit import provenance, server deletion tombstones, attachment checksums/deduplication, structured note blocks.

## 11. Delivery phases

| Phase | Focus | Exit condition |
|---|---|---|
| 0 | Baseline and gap audit | Current behavior classified and reproducible |
| 1 | Capture/editor reliability | No silent loss; autosave/conflicts verified |
| 2 | Notes home/organization | Fast capture, labels, pin, archive, trash stable |
| 3 | Search/reminders | Fast scoped retrieval and correct delivery |
| 4 | Mobile parity | Core workflows offline with safe sync |
| 5 | Attachments/portability | Secure media, import/export, restore verified |
| 6 | Collaboration/accessibility | Roles and responsive UX verified |
| 7 | Operations | Upgrade, backup, monitoring, security gates |

## 12. Definition of implementation task
Every task states:
- User problem and current behavior.
- Expected behavior and acceptance criteria.
- Source files and affected layer.
- API/data impact.
- Web and mobile impact.
- Offline/sync impact.
- Permission and tenant impact.
- Migration/rollback impact.
- Test plan.
- Files/modules explicitly out of scope.

## 13. Change discipline
- Inspect branch and working tree before editing.
- Preserve unrelated uncommitted changes.
- Use a disposable development database, never production volume.
- Keep changes focused.
- Run targeted tests then full suites.
- Update docs with contract changes.
- Do not commit or push unless explicitly requested.
