# Pocket Diary FAQ & Troubleshooting

> **Audience:** End users, administrators, developers
> **Last Updated:** 2024

---

## Table of Contents

1. [Installation & Setup](#installation--setup)
2. [Login & Account](#login--account)
3. [Notes & Editor](#notes--editor)
4. [Search](#search)
5. [Reminders & Notifications](#reminders--notifications)
6. [Attachments & Images](#attachments--images)
7. [Mobile App](#mobile-app)
8. [Sync & Offline](#sync--offline)
9. [Collaboration & Workspaces](#collaboration--workspaces)
10. [Import & Export](#import--export)
11. [Performance](#performance)
12. [Administration](#administration)
13. [Security & Privacy](#security--privacy)
14. [Error Messages](#error-messages)

---

## Installation & Setup

### Q: How do I install Pocket Diary?
**A:** Use Docker Compose (recommended):
```bash
git clone https://github.com/raushan2015/Pocket-Diary.git
cd Pocket-Diary
cp .env.example .env
# Edit .env: set COOKIE_SECRET (openssl rand -hex 32) and APP_URL
docker compose up -d --build
```

### Q: What are the system requirements?
- **Docker:** Engine 24+, Compose v2
- **RAM:** 512MB minimum, 1GB+ recommended
- **Disk:** 2GB+ (database + attachments + backups)
- **CPU:** 1 vCPU minimum
- **OS:** Linux (amd64/arm64), macOS, Windows (WSL2)

### Q: Can I run without Docker?
**A:** Yes, for development:
```bash
# Backend
cd backend && npm ci && npm run dev

# Frontend (separate terminal)
cd frontend && npm run dev
```
But production **requires** Docker for proper isolation, volumes, and health checks.

### Q: How do I enable HTTPS?
**A:** Use a reverse proxy (Nginx, Caddy, Traefik) in front of the container. The app runs HTTP on port 8080 internally.

**Caddy (auto-HTTPS):**
```
notes.example.com {
    reverse_proxy pocket-diary:8080
}
```

**Nginx:** See [Admin Guide → Reverse Proxy](../admin-guide.md#reverse-proxy-production)

### Q: Why does the app require `APP_URL` in production?
**A:** Security. Email links (password reset, invitations) must use a known, trusted URL. Deriving from `Host` header allows link poisoning attacks. Set `APP_URL=https://your-domain.com` in `.env`.

---

## Login & Account

### Q: I forgot my password.
**A:** Click "Forgot password" on the login page. Requires SMTP configured. If SMTP not set up, contact your instance admin (first registered user).

### Q: Can I use Single Sign-On (SSO) / OAuth?
**A:** Not currently implemented. Only email/password with session cookies. SSO is on the roadmap.

### Q: How do I enable two-factor authentication (2FA)?
**A:** Not yet implemented. Planned for future release.

### Q: My session keeps expiring.
**A:** Sessions last 7 days of inactivity (sliding). Check:
- Browser cookies enabled for your domain
- `COOKIE_SECRET` not changed (rotating it invalidates all sessions)
- Reverse proxy passes cookies correctly (`proxy_pass_header Set-Cookie`)

### Q: How do I sign out of all devices?
**A:** Account Settings → Sessions → "Sign out everywhere" or change your password (revokes all other sessions).

### Q: Can I have multiple accounts on one instance?
**A:** Yes, each email = separate account. Each gets a personal workspace. Can be invited to shared workspaces.

---

## Notes & Editor

### Q: My note didn't save!
**A:** Check the save status indicator (top-right of editor):
- **Saving...** → Wait
- **Saved** → Synced to server
- **Saved locally** (mobile) → Will sync when online
- **Offline** → No server connection
- **Conflict** → See [Sync Conflicts](#sync-conflicts)
- **Save failed** → Retry button appears

**Common causes:**
- Network interruption (auto-retry)
- Session expired (re-login)
- Note too large (>2M chars) — split into multiple notes

### Q: Can I recover a deleted note?
**A:** Yes, within 30 days:
1. Go to **Trash** (sidebar)
2. Find note → Click **Restore**
3. Or **Empty Trash** → **Permanent** (irreversible!)

### Q: How do I use Markdown?
**A:** Type Markdown directly. Toolbar buttons insert syntax:
- `**bold**`, `*italic*`, `~~strikethrough~~`
- `- [ ] Task` → Checklist
- `# Heading`, `## Subheading`
- `` `code` ``, ```code block```
- `[link](url)`, `![image](url)`
- `> quote`, `---` (hr)

Click 👁️ for live preview.

### Q: Why can't I change note color?
**A:** Click the palette icon (🎨) in editor or note card menu. 12 colors available.

### Q: What's the difference between Pin, Favorite, and Archive?
| Feature | Purpose | Location |
|---------|---------|----------|
| **Pin** | Keep at top of Notes grid | Pinned section |
| **Favorite** | Quick access in sidebar filter | ⭐ Favorites filter |
| **Archive** | Hide from main view, keep searchable | 📦 Archive view |

### Q: Can I nest folders infinitely?
**A:** Yes, but UI shows max 3 levels. Deep nesting not recommended.

---

## Search

### Q: Search returns no results but note exists.
**A:** Check:
- **Workspace scope:** Search only searches current workspace
- **Filters:** Active filters (label, folder, status) may hide results — click ✕ chips
- **Archived/Trashed:** Enable "Include archived" or search in Archive/Trash views
- **Index rebuild:** Rare — admin can trigger FTS rebuild (not in UI yet)

### Q: Does search work with Japanese/Chinese/Korean?
**A:** Yes. SQLite FTS5 uses Unicode tokenization. Tested with English, Japanese, emoji, punctuation.

### Q: Can I search by date?
**A:** Not yet. Planned: `created:>2024-01-01`, `updated:<2024-12-31`.

### Q: Search is slow with 10k+ notes.
**A:** Uses FTS5 index. Try:
- More specific query
- Add label/folder filter
- Compact List view (less rendering)
- Archive old notes

---

## Reminders & Notifications

### Q: My reminder didn't fire.
**A:** Check:
1. **In-app:** Bell icon 🔔 — shows even if email/push failed
2. **Email:** Spam folder? SMTP configured? (Admin → Settings → Backups shows email status)
3. **Push:** Browser permission granted? VAPID configured?
4. **Mobile:** App notification permission? Background app refresh enabled?
5. **Timezone:** Reminder stored as UTC, shows in your local time

### Q: Reminder fired at wrong time.
**A:** Set your timezone in Account Settings → Profile → Timezone (IANA, e.g., `America/New_York`, `Asia/Tokyo`). Server stores UTC, displays in your TZ.

### Q: Can I get reminders on mobile without the app open?
**A:** Yes, if:
- **Push:** VAPID configured + browser permission granted
- **Mobile app:** Local notifications (best-effort, OS may delay/block)
- **Email:** SMTP configured

### Q: Why does reminder notify only me, not whole workspace?
**A:** By design. Reminders are personal — only the person who set it gets notified. Prevents spam in shared workspaces.

### Q: Can I snooze a reminder?
**A:** Not yet. Options: Dismiss, or edit reminder time.

---

## Attachments & Images

### Q: What file types can I upload?
| Type | Max Size | Preview |
|------|----------|---------|
| JPEG, PNG, WebP, GIF | 5 MB | Inline |
| PDF | 5 MB | Download |
| TXT, MD | 5 MB | Download |

### Q: Upload failed with "File too large".
**A:** Max 5 MB per file. Resize/compress images before upload. Not configurable yet.

### Q: Upload failed with "Unsupported file type".
**A:** Server validates **magic bytes** (actual content), not just extension. Ensure file is truly JPEG/PNG/PDF/etc.

### Q: Can I drag & drop images from browser?
**A:** Yes! Drag from web page or file manager directly onto note. Also paste from clipboard (`Ctrl+V`).

### Q: Where are attachments stored?
**A:** On server filesystem at `/app/data/attachments/` (inside Docker volume). Backed up with database.

### Q: Can I use cloud storage (S3, Google Drive)?
**A:** Not yet. Planned for v2.0 with PostgreSQL migration.

---

## Mobile App

### Q: How do I install the mobile app?
**A:** 
- **Production:** TestFlight (iOS) / Play Store (Android) — links in repo releases
- **Development:** `expo start` → scan QR with Expo Go app

### Q: Does mobile work offline?
**A:** **Yes!** Full offline read/write. Local SQLite database. Syncs when online.

### Q: What does "Saved locally" mean?
**A:** Note saved to phone's SQLite, queued for server sync. Shows 🟡 sync badge until uploaded.

### Q: What's a "Conflict"?
**A:** Same note edited on two devices before sync. Open note → choose:
- **Keep Mine** — your version wins
- **Use Server** — other device's version wins
**Never auto-overwrites.**

### Q: Sync stuck / not working.
**A:** Try:
1. Pull-to-refresh (Notes screen)
2. Settings → Sync → "Sync now"
3. Check WiFi / mobile data
4. Restart app
5. Check server health: `curl https://your-instance.com/health`

### Q: Does background sync work?
**A:** **Best-effort only.** iOS severely restricts background execution. Android Doze mode limits it. Don't rely on it — open app to guarantee sync.

### Q: How do I share to Pocket Diary from other apps?
**A:** Use system Share Sheet → "Pocket Diary" (iOS Share Extension / Android Share Target). Creates new note with shared content.

### Q: Biometric unlock not working.
**A:** Enable in Mobile Settings → Security → Biometric Lock. Requires device support.

---

## Sync & Offline

### Q: How does sync work?
**A:** Mobile uses **local-first** architecture:
1. Local write → SQLite + outbox (atomic)
2. Push outbox → Server (FIFO, idempotent)
3. Pull changes → Server → Local (paginated)
4. Reconcile conflicts → User resolves

### Q: Will I lose data if I uninstall the app?
**A:** **Yes, unsynced data is lost.** Always sync before uninstall. Synced data = on server = safe.

### Q: Can I use multiple accounts on mobile?
**A:** Yes, add accounts in Settings → Accounts. Each has separate local DB.

### Q: Server URL changed / I moved servers.
**A:** Settings → Accounts → Edit server URL. Or remove account + re-add.

---

## Collaboration & Workspaces

### Q: How do I share notes with someone?
**A:** Invite them to your workspace:
1. Workspace switcher → Members → Invite
2. Enter email, choose role (Editor default)
3. They accept invite → see all workspace notes

### Q: What roles exist?
| Role | Can Edit Notes | Can Invite | Can Manage Members |
|------|----------------|------------|---------------------|
| Owner | ✅ | ✅ | ✅ (including Owner) |
| Admin | ✅ | ✅ | ✅ (except Owner) |
| Editor | ✅ | ❌ | ❌ |
| Viewer | ❌ | ❌ | ❌ |

### Q: Can I share a single note without workspace?
**A:** Not directly. Workspace is the sharing unit. Create a workspace for the project/team.

### Q: What happens if I leave a workspace?
**A:** You lose access. Your notes stay in workspace. Owner must transfer ownership first.

### Q: Can I transfer ownership?
**A:** Owner → Members → ⋮ → Transfer ownership. New owner becomes Owner, you become Admin.

---

## Import & Export

### Q: Google Keep import missing data.
**A:** Takeout doesn't include: reminders, collaborators, folders, categories, due dates, priority. Only: title, text, checklists, labels, images, color, pinned, archived.

### Q: Markdown import not parsing frontmatter.
**A:** Ensure valid YAML:
```markdown
---
title: "My Note"
tags: [tag1, tag2]
---
Content here...
```

### Q: Export file is huge.
**A:** Attachments embedded as base64 in JSON. For large exports:
1. Export notes only (JSON)
2. Download attachments separately via API

### Q: Can I automate backups?
**A:** Admin → Settings → Backups shows last backup. Automatic every 24h. For external: mount `BACKUP_REPLICATION_DIR`.

---

## Performance

### Q: App is slow with many notes.
**A:** 
- Uses pagination (100 notes/page — "Load more")
- Try **Compact List** view (less rendering)
- Archive old notes
- Search uses FTS5 index (fast)

### Q: Mobile app is slow / crashes.
**A:** 
- Restart app
- Clear cache (Settings → Sync → Clear local data — **only if synced!**)
- Reinstall (ensure synced first)
- Check device storage

### Q: Database is huge (>1GB).
**A:** 
- Check `memo_versions` table (history) — bounded by coalescing
- Large attachments — consider external storage (v2.0)
- `VACUUM` after large deletes (run during maintenance)

---

## Administration

### Q: How do I backup manually?
```bash
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db ".backup /app/data/backups/manual-$(date +%s).db"
```

### Q: How do I restore from backup?
See [Admin Guide → Backup & Restore](../admin-guide.md#backup--restore)

### Q: How do I update the app?
```bash
docker compose pull && docker compose up -d
# Migrations run automatically
```

### Q: How do I check disk usage?
```bash
docker compose exec memo-manager df -h /app/data
docker compose exec memo-manager du -sh /app/data/*
```

### Q: How do I reset a user's password?
**A:** No admin password reset yet. User must use "Forgot password" (requires SMTP). Or admin can:
```bash
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db \
  "UPDATE users SET password_hash='new-argon2-hash' WHERE email='user@example.com';"
```

### Q: How do I delete a workspace?
**A:** Only Owner can. Workspace settings → Delete workspace. **Irreversible.**

---

## Security & Privacy

### Q: Is my data encrypted?
**A:** 
- **At rest:** SQLite file (use LUKS/encrypted volume for full disk encryption)
- **In transit:** HTTPS (configure reverse proxy with TLS)
- **Passwords:** Argon2id hash (never stored plaintext)
- **Sessions:** SHA-256 hash in DB, HttpOnly Secure cookies
- **Mobile:** SecureStore (Keychain/Keystore) for credentials

### Q: Can the server admin read my private notes?
**A:** 
- **Personal workspace:** No. Admin cannot access other users' personal workspaces.
- **Shared workspace:** Workspace Owner/Admin can see all notes in that workspace.

### Q: Is Pocket Diary HIPAA/GDPR compliant?
**A:** Self-hosted — compliance depends on **your** deployment. Features supporting compliance:
- Data export/deletion (GDPR Art. 17, 20)
- No telemetry/analytics
- Audit logs (activity feed)
- Encryption at rest (via infrastructure)
- Access controls (RBAC)

### Q: How do I report a security vulnerability?
**A:** Email `security@techshan.ai` — **not** public GitHub issues.

---

## Error Messages

| Error | Meaning | Fix |
|-------|---------|-----|
| `COOKIE_SECRET must be set` | Missing env var | Set in `.env` (32+ chars) |
| `APP_URL must be set` | Missing in production | Set `APP_URL=https://...` |
| `SQLITE_BUSY` / `database is locked` | Concurrent writers | Single instance only! Restart container |
| `413 Payload Too Large` | File > 5MB | Resize file |
| `415 Unsupported Media Type` | Invalid file type | Check magic bytes |
| `409 Conflict` | Version mismatch | Re-fetch note, merge, retry |
| `403 Forbidden` | Role/workspace issue | Check permissions |
| `401 Unauthorized` | Session expired | Re-login |
| `500 Internal Server Error` | Bug / misconfig | Check logs |
| `ECONNREFUSED` (health check) | App not ready | Wait / check logs |

---

## Still Stuck?

1. **Check logs:** `docker compose logs -f memo-manager`
2. **Search GitHub Issues:** [Issues](https://github.com/raushan2015/Pocket-Diary/issues)
3. **Ask in Discussions:** [GitHub Discussions](https://github.com/raushan2015/Pocket-Diary/discussions)
4. **Email support:** `support@techshan.ai` (for critical issues)

---

## Useful Links

- [Admin Guide](../admin-guide.md)
- [User Manual](../user-manual.md)
- [API Consumer Guide](../api-consumer-guide.md)
- [Migration Guide](../migration-guide.md)
- [Keyboard Shortcuts](../keyboard-shortcuts.md)
- [Architecture Docs](../)
- [GitHub Repository](https://github.com/raushan2015/Pocket-Diary)