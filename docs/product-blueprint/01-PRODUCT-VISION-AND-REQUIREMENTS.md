# Pocket-Dairy: Product Vision and Requirements

**Purpose:** Product baseline for a self-hosted, Google Keep-inspired notes application.  
**Principle:** Google Keep is a UX reference, not code, branding, or a specification to copy.

## 1. Vision
Pocket-Dairy is a fast, low-friction place to capture thoughts, lists, images, links, reminders, sketches, and everyday information. Users should be able to open it, capture something immediately, and organize it later. It is self-hosted: web and mobile clients connect to a user's own server. Mobile remains useful offline and reconciles changes safely when connectivity returns.

## 2. Product principles
1. Capture first, organize later.
2. Autosave by default with truthful save state.
3. Fast retrieval through search, labels, pins, reminders, and archive.
4. Progressive organization; metadata is optional.
5. Offline-capable mobile with durable local writes.
6. User-owned data with export, backup, and restore.
7. Strict workspace isolation and least-privilege permissions.
8. Accessible responsive web and native mobile UX.
9. No silent data loss or hidden sync failures.
10. Extend the existing repository instead of rewriting it without evidence.

## 3. Target users and jobs
- **Personal user:** capture a thought, make a checklist, save a link/image, set a reminder, find old notes.
- **Shared workspace member:** collaborate with invited people while keeping personal and shared content distinct.
- **Self-hosting administrator:** deploy, update, configure, monitor, back up, and restore the service.

## 4. Goals
- Make quick notes and checklists the primary everyday workflow.
- Bring capture and retrieval closer to Google Keep's simplicity.
- Make mobile a reliable companion to a self-hosted server.
- Preserve existing collaboration, import, reminder, and security behavior.
- Improve large-collection and attachment-heavy performance.
- Maintain a testable web/API/mobile contract.

## 5. Non-goals
- Copying Google branding, proprietary assets, or source code.
- Building a full word processor or project-management suite.
- Requiring users to classify notes before saving.
- Promising guaranteed mobile background sync or notification delivery.
- Making browser storage authoritative.
- Replacing the current stack as an initial project goal.

## 6. Information architecture
Primary navigation:
- Notes
- Reminders
- Labels
- Archive
- Trash
- Search
- Workspace switcher
- Settings / account

Folders and categories may remain secondary organization tools. Labels are flexible and may apply to many notes. Avoid overlapping concepts without clear user value.

## 7. Functional requirements

### 7.1 Capture and editing
- Create plain notes and checklist notes.
- Quick-capture without opening the full editor.
- Optional title and body.
- Add supported images and file attachments.
- Save URLs with safe previews.
- Change note color; pin and favorite notes.
- Assign labels, folder, category, reminder, due date, status, and priority.
- Autosave with visible saving/saved/offline/error state.
- Support Markdown editing and preview where currently available.
- Preserve cursor, focus, undo/redo, and safe close behavior.
- Handle concurrent edits with explicit conflict resolution.

### 7.2 Organization
- Pinned section, archive, trash, restore, and permanent deletion.
- Multiple labels and useful filters.
- Grid and compact list views.
- Custom ordering where drag-and-drop is supported.
- Bulk actions only with clear permission and confirmation rules.
- Empty, loading, error, and no-results states.

### 7.3 Search
- Search title and content.
- Combine text search with labels and metadata filters.
- Workspace-scoped, permission-aware results.
- Debounce input, cancel stale requests, paginate results.
- Highlight matches where practical.
- Test English, Japanese, Unicode, punctuation, and mixed-language text.

### 7.4 Reminders
- Presets and custom date/time in user's timezone.
- Dedicated upcoming/overdue reminder view.
- Server-side in-app notifications.
- Optional email and Web Push.
- Best-effort mobile local notifications reconciled after sync.
- Deduplicate delivery and restrict recipients to the reminder owner/intended recipients.

### 7.5 Attachments and drawing
- Enforce server-side type, size, and file-signature validation.
- Show progress, retry, and failure states.
- Keep file bytes outside note body text.
- Safe image previews; safe document download behavior.
- Save whiteboard output as an attachment.
- Preserve attachment references in export and restore.

### 7.6 Import/export
- Google Keep Takeout ZIP import.
- Markdown file and ZIP import.
- Preview counts and transformations before commit.
- Preserve source metadata when actually present.
- Explain metadata absent from Takeout rather than inventing it.
- Portable note export and separate full-instance backup/restore.

### 7.7 Collaboration
- Explicit workspaces and roles: owner, admin, editor, viewer.
- Invitation and consent-based acceptance.
- Enforce role checks on every route and sync operation.
- Support workspace switching, leaving, ownership transfer, and member removal.

## 8. Quality attributes
| Area | Requirement |
|---|---|
| Performance | Capture, navigation, and search feel responsive |
| Reliability | No silent loss of saved or queued edits |
| Security | Validation, authorization, safe rendering, secure sessions |
| Privacy | Strict workspace isolation |
| Accessibility | Keyboard, screen-reader labels, contrast, touch targets |
| Portability | Documented export and restorable backups |
| Maintainability | Shared API contracts and versioned migrations |

## 9. Success measures
Track metadata only, not note contents:
- Time to first saved note.
- Autosave success/failure.
- Search latency and no-result rate.
- Mobile sync success, retry, and conflict rate.
- Attachment upload success.
- Reminder delivery outcomes.
- Restore drill success.

## 10. Existing repository constraints
The repository already contains a vanilla-JS web SPA, Fastify/TypeScript API, SQLite/Drizzle, Expo mobile app, notes/checklists, labels, folders, reminders, attachments, drawing, search, trash, import/export, workspaces, and offline sync. Classify each requested feature as existing, partial, or missing before implementation. Do not duplicate existing modules.
