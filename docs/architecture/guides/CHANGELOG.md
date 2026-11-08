# Pocket Diary Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] - Main Branch

### Added
- **Internationalization (i18n)** — Language switcher beside the login button; Japanese (日本語) as the first additional language; English remains the base/fallback dictionary; preference stored locally (`localStorage["memo_language"]`); `<html lang>` kept in sync; locale-aware `Intl` date/time helpers; 3-step recipe for adding future languages (`docs/architecture/guides/i18n-guide.md`)
- Design tokens & component library documentation
- Architecture Decision Records (ADRs) for key decisions
- Operational runbooks for critical alerts
- CI/CD pipeline definition (GitHub Actions)
- Admin guide, user manual, API consumer guide
- Migration guide, keyboard shortcuts, FAQ

### Changed
- Comprehensive documentation overhaul

### Security
- Documented security hardening checklist

---

## [1.2.0] - 2024-03-15

### Added
- **Google Keep Takeout Import** — Full ZIP import with titles, text, checklists, labels, images, colors, pinned/archived state
- **Markdown File Import** — Drag & drop `.md` files, frontmatter support
- **Drawing / Whiteboard** — Pen, eraser, shapes, text, save as attachment
- **Activity Feed** — Workspace-level: note edits, creations, member joins (latest 40)
- **Workspace Storage Meter** — Byte-accurate usage vs quota (Settings → Backups)
- **Reminder Email Delivery** — SMTP support for reminder notifications
- **Web Push (VAPID)** — Browser push notifications for reminders
- **Account Deletion** — Self-service with password confirmation; solo workspaces removed, shared notes reassigned
- **Session Management** — List devices, revoke individually, "sign out everywhere"
- **Password Change Revokes Sessions** — Security improvement
- **Instance Admin** — First user gets `isInstanceAdmin` flag, sees backup status
- **Backup Replication** — Off-host copy to `BACKUP_REPLICATION_DIR` with separate retention
- **Rate Limiting** — Global + stricter auth limits; per-IP + per-account lockout
- **CSP & Security Headers** — Hardened for Swagger UI and app
- **SSRF Protection** — Link preview & web push fetch guarded against DNS rebinding
- **ZIP Import Hardening** — Limits on entries, size, depth; traversal protection

### Changed
- **Reminder Recipient Fix** — Now notifies only the user who set the reminder (not whole workspace)
- **Timezone Handling** — User timezone stored per-account; reminders formatted in user TZ
- **Attachment Storage Path** — Fixed to be inside data volume (`/app/data/attachments`)
- **Cookie Security** — `SameSite=Lax`, `Secure` in production, HttpOnly
- **Trust Proxy** — Default `127.0.0.1` only; configurable via `TRUST_PROXY`
- **Database Byte Counting** — Fixed multi-byte character storage calculation (CJK/emoji)
- **Invitation Flow** — Refresh existing instead of duplicate; identical response for registered/unregistered emails

### Fixed
- Cross-workspace access prevention (audit findings)
- Session fixation on password change
- Race condition in Keep-style modal concurrency
- Voice typing cleanup on mobile
- Trash empty upgrade path
- OpenAPI docs test added to CI

### Security
- Argon2id password hashing (memory-hard)
- Session tokens: 256-bit random, stored as SHA-256
- Magic byte validation for uploads
- Path traversal prevention in imports/attachments
- No secrets in logs, OpenAPI spec, or diagnostics

---

## [1.1.0] - 2024-02-01

### Added
- **Categories** — Colored categories with icons for notes
- **Enhanced Reminders** — Presets (Later today, Tomorrow, Next week) + custom date/time
- **In-App Notifications** — Persistent bell icon with unread badge + dropdown
- **Workspace Invitations** — Email + copyable link; consent-based acceptance
- **Member Roles** — Owner, Admin, Editor, Viewer with granular permissions
- **Workspace Switcher** — Top bar dropdown for multi-workspace users
- **Storage Quota** — Per-workspace configurable limit (`STORAGE_QUOTA_GB`)
- **Full-Text Search** — SQLite FTS5 with multi-language support
- **Pinned Notes Section** — Visual separation at top of grid
- **Note Colors** — 12 Keep-style colors
- **Checklist Progress** — Shows on card (e.g., "3/5 done")
- **Drag & Drop Reorder** — Manual card order (owner/admin/editor)
- **Bulk Trash Empty** — Permanent delete all trashed notes + attachments

### Changed
- **Schema:** Added `categories`, `notifications`, `push_subscriptions`, `workspace_invites`, `password_resets` tables
- **Auth:** Session sliding expiry (7 days), device tracking
- **Mobile:** Expo SDK 50, React Native 0.74, TypeScript strict mode

### Fixed
- Mobile offline sync conflict resolution
- Attachment cleanup on note delete
- Search pagination edge cases

---

## [1.0.0] - 2024-01-15

### Added
- **Core Notes** — Create, edit, delete, archive, trash, restore
- **Checklists** — Toggle items, progress indicator
- **Labels/Tags** — Multi-label, inline creation, case-insensitive dedup
- **Folders** — Hierarchical, drag-drop organization
- **Workspaces** — Multi-tenant isolation, personal + shared
- **Authentication** — Register, login, session cookies, password strength
- **Reminders** — Date/time, in-app notifications
- **Attachments** — Images (inline), PDF/TXT/MD (download), 5MB limit
- **Search** — Full-text (FTS5), filters, pagination
- **Import/Export** — Pocket Diary JSON format
- **Mobile App** — Expo/React Native, offline-first, SQLite, secure storage
- **Docker Deployment** — Multi-stage build, health checks, volumes
- **Backup Scheduler** — Automatic SQLite snapshots, retention
- **OpenAPI/Swagger** — `/docs` endpoint with full spec
- **Playwright E2E Tests** — 20+ journey tests
- **Vitest Unit Tests** — Backend services, mobile sync, auth

### Infrastructure
- Fastify 5 + TypeScript backend
- Vanilla JS SPA frontend (no framework)
- SQLite + better-sqlite3 + Drizzle ORM
- Expo Router + expo-sqlite mobile

---

## Versioning Policy

| Version | Meaning | Example |
|---------|---------|---------|
| **MAJOR** | Breaking API/DB changes, migration required | 1.0.0 → 2.0.0 |
| **MINOR** | New features, backward compatible | 1.1.0 → 1.2.0 |
| **PATCH** | Bug fixes, no new features | 1.2.0 → 1.2.1 |

### Release Cadence
- **Patch:** As needed (security/critical bugs)
- **Minor:** ~Monthly
- **Major:** ~Yearly (with migration guide)

### Support Window
| Version | Status | Supported Until |
|---------|--------|-----------------|
| 1.0.x | Maintenance | 2024-12-31 |
| 1.1.x | Maintenance | 2025-03-31 |
| 1.2.x | **Active (LTS)** | 2025-12-31 |

---

## Upgrade Notes

### 1.1.x → 1.2.0
- **New env vars:** `SMTP_*`, `VAPID_*`, `BACKUP_REPLICATION_DIR`, `STORAGE_QUOTA_GB`
- **Auto-migrations:** New tables created on startup
- **Breaking:** None (backward compatible)

### 1.0.x → 1.1.0
- **New env vars:** `STORAGE_QUOTA_GB`
- **Auto-migrations:** Category, notification, invite tables
- **Breaking:** None

---

## Contributors

Thanks to all contributors! See [GitHub Contributors](https://github.com/raushan2015/Pocket-Diary/graphs/contributors).

---

## License

MIT License — see [LICENSE](../../LICENSE)