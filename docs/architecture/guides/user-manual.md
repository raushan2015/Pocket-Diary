# Pocket Diary - User Manual

> **Audience:** End users (personal, team members)
> **Version:** 1.0

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Creating Notes](#creating-notes)
3. [Organizing Notes](#organizing-notes)
4. [Search & Retrieval](#search--retrieval)
5. [Reminders](#reminders)
6. [Attachments & Drawings](#attachments--drawings)
7. [Collaboration & Workspaces](#collaboration--workspaces)
8. [Import & Export](#import--export)
9. [Mobile App](#mobile-app)
10. [Settings & Account](#settings--account)
11. [Keyboard Shortcuts](#keyboard-shortcuts)
12. [FAQ & Troubleshooting](#faq--troubleshooting)

---

## Getting Started

### What is Pocket Diary?
A self-hosted, Google Keep-inspired notes app. You run your own server — your data stays with you. Works on web (desktop/tablet/phone) and native mobile apps (iOS/Android).

### First Login
1. Open your instance URL (e.g., `https://notes.example.com`)
2. **Register** with email + password (min 8 chars, letter + number)
3. You're in! A personal workspace is created automatically.

### Interface Overview

**Desktop:**
```
┌─────────────────────────────────────────────────────────────┐
│ Pocket Diary  🔍 Search          🔔  🌓  👤 Account          │
├─────────────┬───────────────────────────────────────────────┤
│  Navigation │                                               │
│  📝 Notes   │  Quick Capture: [ Title  ▼ ] [ Content... ]   │
│  ⏰ Remind. │  ──────────────────────────────────────────   │
│  🏷️ Labels  │  📌 Pinned Notes                              │
│  📦 Archive │  ──────────────────────────────────────────   │
│  🗑️ Trash   │  Notes Grid (color cards)                     │
│             │                                               │
│  ⚙️ Settings│                                               │
└─────────────┴───────────────────────────────────────────────┘
```

**Mobile:**
- Bottom navigation: Notes, Search, Reminders, More (Settings)
- Floating `+` button for quick capture
- Pull-to-refresh sync

---

## Creating Notes

### Quick Capture (Fastest)
1. Click the **Quick Capture** bar at top of Notes
2. Type title (optional) and content
3. Press `Enter` or click outside → **Auto-saves instantly**
4. No need to open full editor

### Full Editor
1. Click any note card or press `N` (new note)
2. **Toolbar:** Bold, Italic, Strikethrough, Code, Link, Checklist, Image, Drawing
3. **Markdown:** Type `**bold**`, `*italic*`, `- [ ] task`, `# Heading`
4. **Split preview:** Click 👁️ to toggle side-by-side Markdown preview
5. **Auto-save:** Shows "Saving..." → "Saved" → "Saved locally" (mobile offline)

### Note Types
| Type | Use For | Shortcut |
|------|---------|----------|
| **Text** | Free-form notes, Markdown | Default |
| **Checklist** | Todo lists, shopping, tasks | Click checklist icon or `- [ ]` |

### Note Metadata (Optional)
| Field | Purpose | Where |
|-------|---------|-------|
| **Color** | Visual grouping (12 colors) | Palette icon |
| **Pin** | Stays at top of grid | 📌 icon |
| **Favorite** | Quick access in sidebar | ⭐ icon |
| **Labels** | Flexible tags (multi-select) | 🏷️ icon |
| **Folder** | Hierarchical organization | 📁 icon |
| **Category** | Colored categories with icons | 🎨 icon |
| **Reminder** | Date/time + notification | ⏰ icon |
| **Due Date** | Deadline tracking | 📅 icon |
| **Priority** | Low / Medium / High / Urgent | Flag icon |
| **Status** | Draft / Pending / In Progress / Done | Dropdown |

---

## Organizing Notes

### Views
- **Grid:** Visual cards (default) — great for images, colors
- **Compact List:** Dense rows — more notes on screen
- **Pinned Section:** Always at top when non-empty

### Filters & Sorting
- **Filter by:** Label, Folder, Category, Status, Priority, Pinned, Favorite, Archived, Has Reminder
- **Sort by:** Updated, Created, Title, Due Date, Priority, Manual (drag-drop)
- **Active filters** show as chips — click ✕ to clear

### Labels (Tags)
- Create inline: Type in label field → Enter
- Case-insensitive deduplication ("Design" = "design")
- Rename/Delete shows affected note count
- Filter: Click label chip on any note or sidebar

### Folders
- Hierarchical (nestable)
- Drag notes between folders
- Right-click folder → Rename, Delete, New subfolder
- Notes in deleted folder become un-foldered

### Archive & Trash
| Action | Effect | Recoverable? |
|--------|--------|--------------|
| **Archive** | Removes from Notes, keeps in Archive view | Yes (Restore) |
| **Trash** | Moves to Trash, 30-day auto-purge | Yes (Restore) |
| **Empty Trash** | Permanently deletes + attachments | **NO** |

---

## Search & Retrieval

### Search Bar
- **Global:** Top bar (desktop) / Search tab (mobile)
- **Real-time:** Debounced, results as you type
- **Scope:** Current workspace only

### Query Syntax
| Query | Example | Matches |
|-------|---------|---------|
| Plain text | `meeting notes` | Title + content |
| Label | `label:design` | Notes with "design" label |
| Folder | `folder:projects` | Notes in "projects" folder |
| Category | `category:work` | Notes with "work" category |
| Status | `status:pending` | Pending notes |
| Priority | `priority:high` | High/Urgent notes |
| Pinned | `pinned:true` | Pinned notes |
| Favorite | `favorite:true` | Favorited notes |
| Reminder | `reminder:true` | Notes with reminders |
| Combined | `label:design status:pending` | AND logic |

### Search Tips
- **Multi-language:** Works with English, Japanese, emoji, punctuation
- **No results?** Check filters, try broader terms, clear all filters
- **Keyboard:** `/` focuses search, `Esc` clears

---

## Reminders

### Setting a Reminder
1. Open note → Click ⏰ bell icon
2. Choose preset: **Later today, Tomorrow, Next week, Custom...**
3. Custom: Pick date + time (your timezone)
4. **Location reminder** (optional): "When I arrive at Office"

### Reminder Views
- **⏰ Reminders tab:** Upcoming (next 7 days) + Overdue
- **In-app notification:** Bell icon 🔔 shows unread count
- **Email:** If SMTP configured (check spam folder)
- **Push:** If enabled in browser + VAPID configured
- **Mobile:** Local notification (best-effort, OS-dependent)

### Reminder Behavior
- **Only notifies YOU** (the person who set it) — never whole workspace
- **Timezone:** Stored as UTC, displayed in your local time
- **Snooze:** Not yet implemented — dismiss or edit time
- **Overdue:** Stays in Overdue section until dismissed

---

## Attachments & Drawings

### Supported Files
| Type | Max Size | Inline Preview |
|------|----------|----------------|
| JPEG, PNG, WebP, GIF | 5 MB | ✅ Yes |
| PDF | 5 MB | ❌ Download only |
| TXT, MD | 5 MB | ❌ Download only |

### Adding Attachments
1. **Drag & drop** onto note
2. **Paste** image from clipboard (`Ctrl+V`)
3. **Click 📎** attachment icon → choose file
4. **Mobile:** Camera / Photo library / Files app

### Drawings (Whiteboard)
1. Click 🎨 drawing icon in editor
2. Draw with pen, eraser, shapes, text
3. **Save** → Adds as PNG attachment
4. **Edit later:** Click drawing → reopens whiteboard

### Attachment Management
- **Preview:** Click image to enlarge
- **Download:** Right-click → Save / long-press mobile
- **Delete:** Hover attachment → 🗑️ / swipe mobile
- **Storage counts** toward workspace quota

---

## Collaboration & Workspaces

### Personal vs. Shared Workspaces
- **Personal:** Created on signup, only you
- **Shared:** Invite others, role-based access

### Roles & Permissions
| Action | Owner | Admin | Editor | Viewer |
|--------|-------|-------|--------|--------|
| Create/edit/delete notes | ✅ | ✅ | ✅ | ❌ |
| Manage labels/folders/categories | ✅ | ✅ | ✅ | ❌ |
| Invite/remove members | ✅ | ✅ | ❌ | ❌ |
| Change member roles | ✅ | Admin+ | ❌ | ❌ |
| Transfer ownership | ✅ | ❌ | ❌ | ❌ |
| Delete workspace | ✅ | ❌ | ❌ | ❌ |
| View storage usage | ✅ | ✅ | ✅ | ✅ |
| View activity feed | ✅ | ✅ | ✅ | ✅ |

### Inviting Members
1. Workspace switcher → **Members** → **Invite**
2. Enter email, choose role (Editor default)
3. **Email sent** (if SMTP) + copyable invite link
4. Recipient clicks link → accepts → joins

### Workspace Switching
- Top bar: Click workspace name → select another
- Each workspace = isolated data (notes, labels, members)
- Search/scope limited to current workspace

### Leaving / Ownership Transfer
- **Leave:** Members can leave (Owner must transfer first)
- **Transfer:** Owner → Members → ⋮ → Transfer ownership
- **Remove:** Owner/Admin can remove members (not Owner)

---

## Import & Export

### Import Sources
| Source | Format | What Imports |
|--------|--------|--------------|
| **Google Keep Takeout** | ZIP | Titles, text, checklists, labels, images, colors, pinned, archived |
| **Markdown files** | `.md` + frontmatter | Each file = note; frontmatter → title, tags |
| **Pocket Diary Export** | JSON | Full fidelity (all metadata, attachments) |

### How to Import
1. Settings → **Import & Export** → **Import**
2. Choose source: Google Keep ZIP / Markdown files / Pocket Diary JSON
3. **Preview** shows counts, transformations, skipped items
4. **Confirm** to commit

### Export
- **Notes Export:** JSON + attachments (portable, for backup/migration)
- **Full Backup:** Database + attachments (Admin only, for disaster recovery)

### Google Keep Takeout Notes
- Download Takeout from Google → `Keep` folder → ZIP
- Upload ZIP directly (no extraction needed)
- **Preserved:** Title, content, checklist items, labels, images, color, pinned, archived
- **Not in Takeout:** Reminders, collaborators, folders, categories, due dates, priority
- **Trashed Keep notes:** Skipped (not imported)

---

## Mobile App

### Installation
- **TestFlight / Play Store** (production)
- **Expo Go** (development): Scan QR from `expo start`

### Key Features
- **Offline-first:** Full read/write without internet
- **Sync indicator:** 🟢 Synced / 🟡 Pending / 🔴 Conflict / ⚪ Offline
- **Pull-to-refresh:** Manual sync
- **Share extension:** Share → Pocket Diary from any app
- **Camera/Photos:** Direct attachment capture
- **Biometric unlock:** Face ID / Fingerprint (optional)

### Offline Behavior
- **Local edits** save instantly to device SQLite
- **Pending sync** badge shows count
- **Conflicts:** "Keep Mine" / "Use Server" — never auto-overwrite
- **App kill/restart:** Pending ops survive
- **Background sync:** Best-effort (iOS/Android limits apply)

### Mobile Settings
- **Theme:** Light / Dark / System
- **Sync:** WiFi only / Any network / Manual
- **Notifications:** Reminder permissions
- **Biometrics:** App lock

---

## Settings & Account

### Account Settings (👤 Menu)
| Section | Options |
|---------|---------|
| **Profile** | Name, avatar, timezone (IANA, e.g., `Asia/Tokyo`) |
| **Password** | Change (revokes other sessions) |
| **Sessions** | View devices, revoke individually, "Sign out everywhere" |
| **2FA** | Not yet implemented |
| **Delete Account** | Requires password; solo workspaces deleted, shared notes reassigned |

### App Settings (⚙️ Gear)
| Setting | Description |
|---------|-------------|
| **Theme** | Light / Dark / System |
| **Density** | Comfortable / Compact (card spacing) |
| **Language** | English / Japanese (more planned) |
| **Editor** | Auto-save delay, Markdown preview default |
| **Reminders** | Default preset, notification sound |
| **Backup** | View last backup, trigger manual (admin) |

### Instance Admin (First User Only)
- **Backups:** View local + replication status, trigger manual backup
- **System Info:** Version, uptime, DB size, active users

---

## Keyboard Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| `N` | New note | Notes list |
| `/` | Focus search | Anywhere |
| `Esc` | Close modal / clear search | Modal / Search |
| `Ctrl/Cmd + S` | Save (explicit) | Editor |
| `Ctrl/Cmd + B` | Bold | Editor |
| `Ctrl/Cmd + I` | Italic | Editor |
| `Ctrl/Cmd + K` | Insert link | Editor |
| `Ctrl/Cmd + Shift + 7` | Toggle checklist | Editor |
| `Ctrl/Cmd + Shift + .` | Toggle code | Editor |
| `Ctrl/Cmd + Enter` | Submit form / Save | Forms |
| `Tab` | Next focusable | Anywhere |
| `Shift + Tab` | Previous focusable | Anywhere |
| `Arrow keys` | Navigate dropdowns/popovers | Open menus |
| `Enter` | Activate button/select | Focused |
| `Space` | Toggle checkbox | Checklist item |

**Mobile (External Keyboard):** Same as above + `Cmd + N` (new note)

---

## FAQ & Troubleshooting

### General

**Q: I forgot my password.**
A: Click "Forgot password" on login. Requires SMTP configured. If not, ask instance admin.

**Q: Can I use Pocket Diary without internet?**
A: **Mobile:** Yes, fully offline. **Web:** Limited — Service Worker caches assets, but needs server for data.

**Q: Is there a browser extension?**
A: Not yet. Use mobile share extension or "Add to Home Screen" (PWA).

**Q: How do I backup my notes?**
A: Settings → Export → Download JSON + attachments. Or ask admin for full backup.

### Sync & Mobile

**Q: My mobile note says "Conflict".**
A: You edited same note on two devices. Open note → choose "Keep Mine" or "Use Server".

**Q: Sync stuck / not working.**
A: Pull-to-refresh. Check WiFi. Settings → Sync → "Sync now". Restart app.

**Q: Reminder didn't fire on phone.**
A: Check notification permissions (Settings → Pocket Diary → Notifications). iOS/Android may delay/block background execution.

**Q: Attachment won't upload.**
A: Check file size (<5MB), type (JPG/PNG/PDF/TXT/MD), and disk space. Retry on WiFi.

### Data & Privacy

**Q: Where is my data stored?**
A: On your server (SQLite database + attachment files). Nowhere else.

**Q: Can the server admin read my notes?**
A: **Personal workspace:** No (admin can't access). **Shared workspace:** Workspace Owner/Admin can see all notes in that workspace.

**Q: Is there encryption?**
A: At rest: SQLite file (OS-level encryption recommended). In transit: HTTPS (configure reverse proxy). Mobile: SecureStore for credentials.

**Q: How do I delete everything?**
A: Account Settings → Delete Account. Requires password. Irreversible.

### Import/Export

**Q: Google Keep import missing reminders.**
A: Google Takeout doesn't include reminder data. Re-add manually.

**Q: Markdown import didn't parse frontmatter.**
A: Ensure valid YAML frontmatter: `---\\ntitle: "X"\\ntags: [a, b]\\n---`

**Q: Export file is huge.**
A: Large attachments. Export notes only (JSON) + separately download attachments.

### Performance

**Q: App is slow with many notes.**
A: Uses pagination (100 notes/page). Try Compact List view. Archive old notes.

**Q: Search is slow.**
A: Uses SQLite FTS5. Index rebuild: Admin → trigger reindex (not yet in UI).

---

## Support

- **In-app:** Settings → Help (links to this manual)
- **Issues:** [GitHub Issues](https://github.com/raushan2015/Pocket-Diary/issues)
- **Feature requests:** GitHub Discussions
- **Security:** `security@techshan.ai`