# Notes — Project Audit

**Date:** 2026-10-16 · **Commit audited:** `e804dcf` (branch `main`)
**Scope:** the full repository: `backend/` (Fastify + SQLite), `frontend/` (vanilla JS SPA, proxy server, service worker), `tests/`, Docker and Compose files.

---

## 0. Remediation log — applied 2026-10-16 (same day as the audit)

All findings from the “Today” and “This week” tiers of §7 are fixed, plus most of the “Next sprint” tier and several backlog hardening items. Verification: `tsc --noEmit` clean, **114/114 backend tests** (99 original + 15 new audit regression tests in `backend/test/audit-remediation.test.ts`), **19/19 frontend unit tests** (including the new `tests/markdown-xss.test.js`), `npm audit --omit=dev` clean, and a live two-process smoke run (proxy headers, rate limiting, security headers, C-3 fail-fast).

| Finding | Status | What changed |
| --- | --- | --- |
| 🔴 C-1 Stored XSS in Markdown renderer | ✅ **Fixed** | `frontend/js/markdown.js` rewritten: inline formatting is tokenized on raw text before escaping; code spans/images/links build their attributes with `escapeHtml()` exactly once, so no later regex pass can break out of an attribute. URL allow-lists (`safeLinkUrl`/`safeImageUrl`) reject `javascript:`/`data:text` schemes. Allow-list DOM sanitizer (`sanitizeMarkdownHtml`) as defense in depth. Collateral bugs fixed: underscore URLs, `snake_case`, `mailto:` links. Regression tests: `tests/markdown-xss.test.js` (18 payloads incl. the audit's exact PoC). |
| 🔴 C-2 XSS in the invite banner | ✅ **Fixed** | `frontend/js/auth.js` `renderInviteBanner` rebuilt with DOM APIs + `textContent`; the attacker-controlled `workspaceName` never passes through `innerHTML`. |
| 🔴 C-3 Password-reset link poisoning | ✅ **Fixed** | `APP_URL` is **required in production** (fail-fast at startup, like `COOKIE_SECRET`) and validated as an absolute http(s) URL. Single `resolveAppUrl()` in `config.ts`; all three diverging copies removed; email links are never derived from request headers. `.env.example`/compose updated (`APP_URL` now mandatory). |
| 🟠 H-1 Rate-limit bypass via spoofed XFF | ✅ **Fixed** | Frontend proxy **overwrites** `X-Forwarded-For/Proto/Host` with self-observed values; backend `trustProxy` defaults to `127.0.0.1` (configurable via `TRUST_PROXY`); **per-account login lockout** (5 failures → 15 min) makes brute force impossible regardless of source IP. Login timing equalized with a dummy argon2 verify for unknown accounts (part of M-14). Verified live: 17 rotating spoofed XFFs through the proxy → 429 on request 16. |
| 🟠 H-2 Reminders fan out to the whole workspace | ✅ **Fixed** | New `memos.reminder_set_by` column (additive migration + backfill). The scan notifies **only the user who set the effective reminder** (`COALESCE(reminder_set_by, created_by)`), never the workspace. Setting/changing a reminder reassigns ownership to the editor. Regression tests pin both paths. |
| 🟠 H-3 Consent-bypassing direct member add + enumeration | ✅ **Fixed** | `POST /workspaces/:id/members` **removed**. All additions flow through invitations (email-ownership enforced, identical response whether or not the account exists). Frontend `addWorkspaceMember` API removed (UI already used invites). |
| 🟠 H-4 Viewers can reorder notes | ✅ **Fixed** | `/memos/reorder` now requires `['owner','admin','editor']`. Regression test covers viewer-403 / editor-200. |
| 🟠 H-5 Keep modal overwrites concurrent edits | ✅ **Fixed** | On 409 the modal auto-retries **only** when the server's title/content/checklist still match the base it loaded (metadata-only change); a genuine content conflict shows an explicit banner — *Keep my changes* (deliberate overwrite) or *Load latest version*. Saves and modal close are blocked while the conflict is unresolved, so nothing is silently lost or overwritten. |
| 🟠 H-6 Password change doesn't revoke sessions | ✅ **Fixed** | `PATCH /auth/profile` with a new password deletes every other session for the account (current session survives). Regression test asserts second-device 401. |
| 🟠 H-7 Session tokens stored in plaintext | ✅ **Fixed** | Sessions are stored as **SHA-256 hashes** (`hashSessionToken`) and looked up by hash — DB/backup readers can no longer impersonate users. **Invite tokens are hashed too**; a fresh raw token is returned exactly once at creation (also fixes M-1). |
| 🟠 H-8 Admins can demote other admins | ✅ **Fixed** | `changeMemberRole` now mirrors `removeWorkspaceMember`: only the owner may change an admin's role or grant admin. Regression tests cover demote-admin-403 and grant-admin-403 by an admin. |
| 🟠 H-9 First-user race | ✅ **Fixed** | The first-user check runs **inside** the insert transaction, so two simultaneous sign-ups can no longer both become instance admin. (Explicit `ADMIN_EMAIL` bootstrap and registration modes remain a backlog suggestion.) |
| 🟡 M-1 Re-invite returns expired link | ✅ **Fixed** | Re-inviting a pending (or expired-pending) address issues a **fresh token** and a full new expiry window. Regression test proves the stale link dies and the new one accepts. |
| 🟡 M-2 Imported colors make notes unsaveable | ✅ **Fixed** | Import normalizes colors against the palette (`RED`→`red`, unknown→`default`); `updateMemo` only validates color/theme when the request actually changes them. Both paths regression-tested. |
| 🟡 M-3 Duplicate tags 500 | ✅ **Fixed** | Tag lists are deduped case-insensitively (create, update **and** import); tag lookup is case-insensitive. `normalizeTagNames` unit-tested. |
| 🟡 M-4 Folder self-parent/cycles/cross-workspace | ✅ **Fixed** | `validateParent` rejects self-parent, missing parents, foreign-workspace parents and cycles with typed 400s. All four cases regression-tested. |
| 🟡 M-5 Silent cascade delete of subfolders | ✅ **Fixed** | `deleteFolder` detaches subfolders (`parent_id = NULL`) before deleting; fresh installs use `ON DELETE SET NULL` so SQL and Drizzle agree. Test asserts the child survives. |
| 🟡 M-6 Blank names / duplicate slugs 500 | ✅ **Fixed** | Folder blank names → `FolderValidationError` (400); duplicate workspace slug → 409 Conflict with a typed error. |
| 🟡 M-7 Unbounded version growth | ✅ **Fixed** | Snapshots coalesce (new one only when content differs from the last snapshot **and** the last is older than 5 min) and history is pruned to the newest 50 entries per note. |
| 🟡 M-8 FTS rebuilt every boot / on every write | ✅ **Fixed** | Update trigger now fires only `WHEN new.title != old.title OR new.content != old.content`; full rebuild is gated on `PRAGMA user_version` (one-time upgrade), not every startup. |
| 🟡 M-9 Reminder scan cost / overlap | ✅ **Fixed** | Expression index on `COALESCE(reminder_time, due_date)`; scheduler has an in-progress guard. (Silent loss after >2 h downtime remains: fresh-window behavior is intentional anti-spam.) |
| 🟡 M-10 Push endpoint SSRF | ✅ **Fixed** | `/push/subscribe` requires an `https` endpoint resolving to a public address (same guard as link preview). |
| 🟡 M-11 DNS-rebinding bypass in link preview | ✅ **Fixed** | New `safe-fetch.ts` (`guardedFetch`): resolves + validates once, then connects **directly to the validated IPs** with correct Host header and TLS SNI — `fetch()`'s second resolution can no longer diverge from the checked one. |
| 🟡 M-12 Backups on every boot; attachments not backed up | ✅ **Fixed** | Startup snapshot only runs when the newest one is older than the minimum interval; each backup also mirrors the attachments directory incrementally. |
| 🟡 M-13 Standalone image loses attachments | ✅ **Fixed** | `ENV ATTACHMENTS_DIR=/app/data/attachments` in both Dockerfiles (inside the data volume). |
| 🟡 M-15 Reset token usable twice in a race | ✅ **Fixed** | The claim is a conditional `UPDATE … WHERE used_at IS NULL` inside the transaction; the loser rolls back. Regression-tested. |
| 🟡 M-14 Reset/login enumeration timing | ◐ Partial | Login timing equalized (dummy argon2 verify) and responses stay identical; forgot-password still `await`s SMTP for real accounts — full fix needs async email queueing (backlog). |
| 🔵 L-1 Security headers | ✅ **Fixed** | CSP (`script-src 'self'`, `frame-ancestors 'none'`, …), `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` on every response. The 7 static inline `onclick` attributes in generated HTML were removed (delegated via one `closest()` guard) so the CSP needs no `'unsafe-inline'` for scripts. |
| 🔵 L-2 Static server exposure / no caching / no timeout | ✅ **Fixed** | Deny-list for `server.js`/`package.json`/Dockerfile/`.env*` (now 403), gzip for text >1 KB, ETag + `Cache-Control`, proxy request timeout. |
| 🔵 L-3 Containers run as root | ✅ **Fixed** | `USER node` + chowned data dirs in both Dockerfiles. |
| 🔵 L-4 `showToast` innerHTML sink | ✅ **Fixed** | Toast message inserted via `textContent`; only the static icon markup uses `insertAdjacentHTML`. |
| 🔵 L-5 `javascript:` link-preview URLs | ✅ **Fixed** | Memo create/update sanitize stored `linkPreviews` to http(s)/`/api/` URLs (server-side, in addition to the CSP). |
| 🔵 L-14 Entrypoint exits 0 on crash | ✅ **Fixed** | `wait -n` propagates the failing child's exit code; SIGTERM still exits 0 after cleanup. Compose health-check start period raised to 30 s. |
| 🔵 L-15 Missing indexes / schema drift | ◐ Partial | Added `memo_versions(memo_id)`, `attachments(memo_id)`, `memo_tags(tag_id)` + reminder expression index; `PRAGMA user_version` introduced for the FTS upgrade; general ad-hoc migration versioning remains backlog. |
| 🟡 M-16, M-17 · 🔵 L-6–L-13 | ⏳ Open | Backlog (timezone-aware reminder emails, Keep Takeout JSON parsing, magic-byte MIME checks, session renewal/cleanup, account deletion, storage meter bytes, `api.js` error UX, service-worker precache, member-removal notification cleanup). |

**Deployment notes for upgraders**

- `APP_URL` is now **required in production** — set it in `.env` before upgrading, or the backend refuses to start (fail-fast is intentional).
- Existing sessions become invalid (tokens are now stored hashed) — users simply sign in again.
- Outstanding invitations issued before the upgrade become invalid for the same reason — re-invite those members (one click per pending invite; see M-1, which also guarantees the new link actually works).
- If the backend sits behind a proxy other than the bundled loopback one, set `TRUST_PROXY` to the proxy's address/subnet (`false` when directly exposed).

---

## 1. Summary

### Health checks run

| Check | Result |
| --- | --- |
| `tsc --noEmit` (backend) | ✅ Clean |
| `vitest run` (backend) | ✅ 15 files, **99/99 tests pass** |
| `node --test md-import.test.js` (frontend unit) | ✅ 13/13 pass |
| `npm audit --omit=dev` (backend) | ✅ 0 known vulnerabilities |
| Playwright e2e suite (`tests/e2e`) | ⏭ Not run. It needs a disposable running instance. |

The build is green and the existing tests pass. The suite still misses several real defects. Most of the findings below were **reproduced at runtime**: an in-memory app driven through `app.inject`, and headless Chromium for the frontend XSS. The rest come from reading the code. Each finding is marked:

- **[Verified]**: reproduced during this audit.
- **[Code]**: found by reading the code; the path is clear but it was not run.

### Severity overview

| Severity | Count | Headline |
| --- | --- | --- |
| 🔴 Critical | 3 | Stored XSS in the Markdown renderer, XSS in the invite banner, password-reset link poisoning |
| 🟠 High | 9 | Rate limit bypass, reminders sent to the whole workspace, RBAC gaps, a conflict "fix" that overwrites other users' edits, and more |
| 🟡 Medium | 17 | Validation 500s, broken re-invites, folder cycles, unbounded version growth, operational risks |
| 🔵 Low | 15 | Hardening, consistency, UX edge cases |

---

## 2. Critical

### C-1 Stored XSS in the Markdown renderer [Verified]
**Where:** `frontend/js/markdown.js:189-226` (`formatInline`). The output is assigned with `innerHTML` in `frontend/js/editor.js:647-648`.

`formatInline` escapes the text and then runs a chain of regex replacements over the escaped HTML: code, bold, italic, strike, then images, then links. Later passes match inside the HTML that earlier passes produced, so an image followed by a link nested in the image URL breaks out of the `src` attribute.

**Payload (stored in a note's content):**
```
![a](https://x.invalid/[b](http:///onerror=document.title=7//)
```
Rendering it in Chromium produced `<img ... onerror="document.title=7//&quot;">` and the handler **executed** (the page title became `7`). Any editor in a shared workspace can plant this. Any member who opens the note's Markdown preview runs the attacker's JavaScript on the app origin. That code can call every API with the victim's session: export notes, change roles, invite accounts.

The same pipeline also breaks normal content:
- `https://example.com/my_page_name` becomes `href="https://example.com/my<em>page</em>name"`, so links that contain `_` are broken.
- `snake_case_name` renders as `snake<em>case</em>name` (emphasis inside words).
- `[t](mailto:a@b.com)` becomes `https://mailto:a@b.com`.
- A backtick span in alt text or a URL inserts `<code class="md-inline-code">` inside an attribute.

**Fix:** replace the hand-written renderer with a real parser (`marked` or `markdown-it`) and pass its output through **DOMPurify** before any `innerHTML`. Allow-list URL schemes (`http`, `https`, `mailto`, `/api/`) after parsing, not before. Add a regression test using the payload above.

### C-2 XSS in the workspace-invite banner [Code]
**Where:** `frontend/js/auth.js:251-252`

```js
banner.innerHTML = `... join “${ctx.workspaceName}” ... <strong>${ctx.role}</strong> for <strong>${ctx.email}</strong>`;
```
`workspaceName` can be set by any user (120 characters, no character restrictions), and it reaches this line without escaping. Attack:
1. Create a workspace named `<img src=x onerror=…>`.
2. Invite any address.
3. Send the `/#invite=<token>` link to a victim.

The script runs on the app origin when the link opens, including for victims who are already signed in, because `loadInviteContext` runs for both signed-in and signed-out visitors.

**Fix:** build the banner with `textContent` or `escapeHtml()`. Separately, audit every `innerHTML` sink (there are 85+ in `frontend/js`).

### C-3 Password-reset link poisoning through the Host header [Verified]
**Where:** `backend/src/routes/auth.ts:239` → `config.ts:12` (`resolveAppUrlForRequest`), plus `frontend/server.js:42`.

When `APP_URL` is unset (it is optional and commented out in `.env.example`), the reset link is built from the request's `Host` header. `resolveAppUrlForRequest('http', 'evil.example')` returns `http://evil.example`. An attacker can request a reset for the victim's email with a forged Host or X-Forwarded-Host header. The victim receives a genuine email whose link sends the reset token to the attacker's domain, which gives the attacker the account.

**Fix:** make `APP_URL` **required** in production (fail fast at startup, like `COOKIE_SECRET`) and never derive email links from request headers. Use a single `resolveAppUrl()`. Today there are three diverging copies: `config.ts`, `index.ts:10`, and `routes/workspaces.ts:75`.

---

## 3. High

### H-1 Rate limiting can be bypassed with a spoofed X-Forwarded-For [Verified]
**Where:** `backend/src/app.ts:22` (`trustProxy: true`); `frontend/server.js:36-46` forwards the client's own `X-Forwarded-*` headers.

The rate limiter keys on `request.ip`, which comes from a header the client controls. Control test: 20 failed logins from one IP got **429**. The same 20 attempts with a different `X-Forwarded-For` each got **401** every time, so no limit applied. This removes brute-force protection on `/login`, `/forgot-password` and `/reset-password`. Clients also control `request.protocol`, which decides the cookie's `Secure` flag.

**Fix:**
- Make the frontend proxy overwrite (not pass through) `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`.
- Set `trustProxy` to the proxy's address (`'127.0.0.1'`) or make it configurable.
- Add per-account login throttling or lockout.

### H-2 Reminders go to every member of the workspace [Verified]
**Where:** `backend/src/services/notification.service.ts:136-142`

Each due reminder fans out to **all non-viewer members**, by in-app notification, email and push. In the test, user B received user A's reminder "A private reminder". In a team workspace, every member gets every other member's personal reminders. That is noisy, and it leaks note titles and the first 160 characters of the body.

**Fix:** notify the user who set the reminder. Store a `reminder_owner_id` or `reminder_set_by` on the memo, or keep reminders in a per-user table. Optionally let users opt in to watching a note.

### H-3 Admins can add any registered user to a workspace without consent, and the endpoint enumerates accounts [Verified]
**Where:** `backend/src/routes/workspaces.ts:241-310` (`POST /workspaces/:id/members`)

- The endpoint bypasses the invite flow's email-ownership check (SEC-02). Any user can create a workspace and silently pull any other account into it.
- It returns `404 "User with this email was not found"` versus `201`, so **any signed-in user can check whether an email address has an account**.

**Fix:** remove the endpoint, or route it through invitations. Return the same response whether or not the account exists.

### H-4 Viewers can reorder notes [Verified]
**Where:** `backend/src/routes/memos.ts:510-530`. `verifyWorkspaceMembership` is called without role restrictions.

A viewer's `POST /memos/reorder` returned **200** and changed `sort_order` for everyone.

**Fix:** pass `['owner','admin','editor']`.

### H-5 The Keep modal's conflict "fix" overwrites concurrent edits [Code]
**Where:** `frontend/js/keep-modal.js:150-162`

On a `409` version conflict, the modal fetches the latest version number and re-sends **its own full payload** with that number. Another user's (or another tab's) edits are overwritten without notice, which makes optimistic locking useless. The full editor (`editor.js:838`) correctly shows a conflict banner instead.

**Fix:** show the conflict banner or a merge choice: keep mine, keep theirs, or view diff. At least, only retry automatically when the server's title and content still match the base this client last loaded.

### H-6 Changing your password does not sign out other sessions [Verified]
**Where:** `backend/src/routes/auth.ts:300-335`

After `PATCH /auth/profile` with a new password, a second session stayed valid (`/auth/me` returned **200**). The reset flow does revoke sessions; this flow does not. A stolen session survives the usual fix of changing the password.

**Fix:** delete every session except the current one in the same transaction.

### H-7 Session tokens are stored in plaintext [Verified]
**Where:** `backend/src/services/auth.service.ts:113`. `sessions.id` is the raw cookie value.

Anyone with read access to the database, a backup snapshot, or the off-host replica can impersonate any user. Password-reset tokens are already stored as SHA-256 hashes, so sessions should be too. Invite tokens (`workspace_invites.token`) are also plaintext.

**Fix:** store `sha256(token)` and look sessions up by hash.

### H-8 Workspace admins can demote other admins [Code]
**Where:** `backend/src/services/workspace.service.ts:153-176` (`changeMemberRole`)

`removeWorkspaceMember` blocks an admin from removing another admin, but `changeMemberRole` lets an admin demote another admin to viewer, and then remove them. Admins can also promote anyone to admin. That is an inconsistent privilege model.

**Fix:** apply the same rule. Only the owner can change an admin's role or grant admin.

### H-9 The first account on an instance becomes admin, with a race [Code]
**Where:** `backend/src/services/auth.service.ts:75`

`isFirstUser` is read **outside** the insert transaction, so two simultaneous sign-ups on a fresh instance can both become instance admin. On a public deployment, whoever reaches `/register` first owns the instance.

**Fix:**
- Do the check-and-set inside the transaction.
- Better: make admin bootstrap explicit (`ADMIN_EMAIL` env var or a one-time setup token).
- Add an option to disable open registration (`REGISTRATION=invite-only|open|closed`).

---

## 4. Medium

| ID | Finding | Where | Evidence |
| --- | --- | --- | --- |
| M-1 | **Re-inviting after an invite expires returns an invite that is already expired.** `createInvite` reuses any `pending` row and keeps its old `expiresAt`, so the new link fails immediately with "expired". | `invite.service.ts:66-78` | [Verified]: same id, `expiresAt` in the past |
| M-2 | **An imported note with a non-standard color can never be saved again.** Import stores any `color` string (for example `RED`). Every later PATCH, even just pinning, fails with `400 Invalid memo color`, because `updateMemo` re-validates the stored value. | `migration.service.ts:229`, `memo.service.ts:707-709` | [Verified] |
| M-3 | **Duplicate tag names cause a 500.** `tags: ["x","x"]` makes a second `memo_tags` insert, which violates the primary key and returns HTTP 500. Tags are case-sensitive in the memo service but case-insensitive in import, so `Work` and `work` behave differently depending on the path. | `memo.service.ts:640-662, 786-808` | [Verified]: 500 |
| M-4 | **Folders can be their own parent, form cycles, or point to another workspace.** `parentId` is never validated: self-parent returns 200, and a nonexistent parent returns 500 (FK error). A cycle can hang any recursive folder tree in the UI. | `folder.service.ts:43, 80` | [Verified] |
| M-5 | **Deleting a folder silently deletes all its subfolders.** The SQL schema uses `parent_id … ON DELETE CASCADE`; the Drizzle schema has no FK, so the two disagree. | `migrate.ts` folders table; `schema.ts:60-68` | [Code] |
| M-6 | **Blank names and duplicate slugs return 500 instead of 400.** A folder, category or tag name of `"   "` throws a plain `Error`. Creating a workspace with a slug that already exists violates the UNIQUE constraint. | `folder.service.ts:33`, `workspace.service.ts:84` | [Verified]: 500 for each |
| M-7 | **Version history grows without limit.** Autosave fires 400–450 ms after the user stops typing (`editor.js:69`, `keep-modal.js:95`), and every save that changes content writes a **full copy** of the note to `memo_versions`. Notes can hold up to 2 MB of data-URI images, so one long editing session can add hundreds of MB. Nothing prunes or merges these rows. | `memo.service.ts:813` | [Code] |
| M-8 | **The full-text index rebuilds on every startup** (`INSERT INTO memos_fts(memos_fts) VALUES('rebuild')`), which costs O(all notes) per boot. The `memos_au` trigger re-indexes title and content on **every** update, including pin, color and reorder changes. Base64 images in content are indexed too. | `migrate.ts:202, 249` | [Code] |
| M-9 | **Reminder scans cannot use an index.** Every 30 s the scan uses `COALESCE(reminder_time, due_date)` across all workspaces, which forces a full table scan. Ticks can also overlap (`setInterval` with an async tick and no in-progress guard). Reminders are lost **silently** if the server is down for more than the 2-hour window. | `notification.service.ts:115-125, 236` | [Code] |
| M-10 | **Push subscription endpoints are not validated (SSRF).** `/push/subscribe` accepts any URL as `endpoint`, and the reminder job later POSTs to it from the server, including internal or metadata addresses. | `routes/push.ts:17` | [Code] |
| M-11 | **The link-preview SSRF guard can be bypassed with DNS rebinding.** `assertPublicHttpUrl` resolves the hostname, then `fetch` resolves it **again**, so the IP that gets connected to may differ from the one that was checked. | `url-guard.ts`, `routes/memos.ts:600+` | [Code] |
| M-12 | **Backups run on every startup**, so a crash-looping container can push all 7 good snapshots out of retention within minutes. Attachments are **not** backed up. Snapshots are unencrypted, and session tokens inside them are plaintext (see H-7). | `backup.service.ts:174` | [Code] |
| M-13 | **The standalone backend image loses attachments.** `backend/Dockerfile` does not set `ATTACHMENTS_DIR`, so the default `../data/attachments` resolves to `/data/attachments`, which is **outside** the `/app/data` volume. Absolute `storage_path` values in the DB also break when the data directory moves. | `attachments.ts:20`, `backend/Dockerfile` | [Code] |
| M-14 | **Forgot-password response time reveals whether an account exists.** For real accounts the handler `await`s the SMTP send; for unknown emails it returns at once. Login does the same: it skips argon2 for unknown emails (`auth.service.ts:148`), and registration returns 409 for existing emails. | `password-reset.service.ts:94` | [Code] |
| M-15 | **A reset token can be used twice in a race.** The `usedAt` check runs before the async argon2 hash, and the final UPDATE is not conditional on `used_at IS NULL`. | `password-reset.service.ts:121-143` | [Code] |
| M-16 | **Reminder email times use the server's timezone** (UTC in Docker), not the user's. `users.timezone` exists but nothing ever sets or reads it. | `mailer.service.ts:75` | [Code] |
| M-17 | **Google Keep import ignores the Takeout JSON files.** Only `*.html` is parsed, so each note's `color`, `isPinned`, `isArchived` and **`isTrashed`** values are dropped, and notes from the Keep trash come back as active notes. The README claims Takeout has no colors or pinned state; the JSON files do contain them. | `keep-import.js` | [Code] |

---

## 5. Low / hardening

| ID | Finding | Where |
| --- | --- | --- |
| L-1 | No security headers: CSP, `X-Frame-Options` / `frame-ancestors` (clickjacking), HSTS, `Referrer-Policy`. Inline `onclick=` handlers in generated HTML block a strict CSP. | `frontend/server.js`, `memo-renderer.js` |
| L-2 | The static server serves every file in `frontend/`, including `server.js`, `Dockerfile` and `package.json`. Static files have no gzip, `ETag` or cache headers. The proxy has no timeout. | `frontend/server.js` |
| L-3 | Containers run as **root** (no `USER node`). | `Dockerfile`, both sub-Dockerfiles |
| L-4 | `showToast` writes `message` with `innerHTML`. Some messages include server or file data, for example a ZIP entry name in `keep-import.js:88`. This is a latent XSS sink. | `utils.js:29` |
| L-5 | Link-preview `url` is stored without a scheme check, and cards render `href="${escapeHtml(lp.url)}"`. `javascript:` URLs are accepted. Chromium blocked execution under `noopener`; other browsers may not. | `memo-renderer.js:179`, `routes/memos.ts` schema |
| L-6 | Attachment MIME type comes from the client (no magic-byte check). PDF and text are served `inline`. Data-URI images in content bypass the 5 MB per-file limit and the quota. | `routes/attachments.ts` |
| L-7 | Expired sessions, used or expired password resets, and old invites are never deleted. No sliding session renewal. | `auth.service.ts` |
| L-8 | No endpoint to revoke a single session, delete an account, delete or leave a workspace, or transfer ownership. | — |
| L-9 | Password policy is a 6-character minimum with no breached-password check, and the client-side meter is not enforced on the server. | `routes/auth.ts`, `password-reset.service.ts:22` |
| L-10 | The storage meter counts **characters** (`LENGTH`), not bytes, and hardcodes 10 GB. | `routes/workspaces.ts:140` |
| L-11 | `api.js` only recognises network errors whose message contains "fetch". Safari's `Load failed` gets past that check and shows a raw TypeError. There is no global 401 handler, so an expired session fails one action at a time instead of sending the user back to sign-in. | `api.js:75` |
| L-12 | The service worker's precache misses `js/voice-notes.js` and `js/md-import.js`, which are statically imported, so the cold offline shell fails to load. The `CACHE_NAME` version never changes. | `sw.js` |
| L-13 | When a member is removed, their notifications for that workspace (titles and snippets) remain. Their push subscriptions are untouched. | `workspace.service.ts` |
| L-14 | The entrypoint exits **0** when a child process crashes (`wait -n` → `cleanup` → `exit 0`), which hides failures from orchestrators. The 5 s health-check start period is short given M-8. | `docker-entrypoint.sh` |
| L-15 | Schema drift and missing indexes: the Drizzle schema and the raw SQL disagree (folder FK). No index on `memo_versions(memo_id)`, `attachments(memo_id)`, `memo_tags(tag_id)` or `memos(reminder_time)`. Migrations are ad-hoc `PRAGMA table_info` checks with no `user_version`. | `db/schema.ts`, `db/migrate.ts` |

---

## 6. Test-suite gaps

The 99 backend tests did not catch any finding in sections 3 or 4. Add regression tests for at least:
- the C-1 Markdown payload, using DOMPurify'd output;
- spoofed `X-Forwarded-For` against the login limiter;
- a viewer calling `/memos/reorder`;
- re-inviting after expiry;
- import with color `RED`, then PATCH;
- duplicate tags;
- a self-parent folder;
- session survival after a password change;
- reminder recipients in a shared workspace.

Also run the Playwright e2e suite in CI against an ephemeral container.

---

## 7. Recommended fix order

1. **Today:** C-1, C-2 (XSS), C-3 (require `APP_URL`), H-1 (proxy headers and `trustProxy`).
2. **This week:** H-2, H-3, H-4, H-5, H-6, H-7, H-8, M-1, M-2, M-3, M-6.
3. **Next sprint:** M-4, M-5, M-7, M-8, M-9, M-10, M-11, M-12, M-13, plus security headers (L-1) and a non-root image (L-3).
4. **Backlog:** the remaining Medium and Low items, migration versioning, index additions.

---

## 8. Feature suggestions (28)

Effort: **S** ≈ days, **M** ≈ 1–2 weeks, **L** ≈ multi-week. Ordered roughly by value within each group.

### Editing and content
1. **Rich-text / block editor (M–L).** Replace the textarea and regex Markdown with TipTap, ProseMirror or Milkdown: WYSIWYG with Markdown shortcuts, tables, code highlighting, and pasted images stored as attachments instead of data URIs. This also fixes C-1 and M-7 at the root.
2. **Version history diff and restore UI (S).** The `memo_versions` data and endpoint already exist. Add a side-by-side diff, "restore this version", and named snapshots. Combine with time-based coalescing of autosave versions.
3. **Real-time collaborative editing (L).** Yjs or Automerge over WebSocket, with presence avatars and live cursors. This replaces the 409 conflict flow (H-5).
4. **Backlinks and `[[wiki links]]` (M).** Link notes to each other, show "linked from" panels, and later a graph view.
5. **Note templates (S).** Templates per workspace (meeting notes, daily journal, recipe), plus a "daily note" shortcut.
6. **Advanced checklists (S–M).** Nested sub-items, drag-to-reorder, "move checked to bottom", due dates or assignees per item.
7. **Code-block syntax highlighting and LaTeX/math (S).** Shiki or Prism, and KaTeX.

### Organization and search
8. **Saved searches / smart folders (S).** Persist filter combinations, for example `tag:work priority:high has:reminder`.
9. **Search operators and highlighting (S–M).** `tag:`, `in:folder`, `is:pinned`, `before:`/`after:`, exact phrases, plus highlighted matches and snippets (FTS5 `snippet()` / `highlight()`).
10. **Full-text search inside attachments (M).** Extract text from PDFs and run OCR on images (Tesseract), then index it in FTS.
11. **Nested tags and tag colors (S).** `work/projectA` hierarchy and per-tag color chips.
12. **Bulk operations (S).** The selection UI exists; add bulk tag, move to folder, color, and export.

### Collaboration and sharing
13. **Public share links (M).** Read-only (optionally password-protected or expiring) links to a single note, rendered server-side and sanitized.
14. **Per-note permissions (M).** Share a single note with someone outside the workspace (the `collaborators` column exists but has no behaviour).
15. **Comments and @mentions (M).** Threaded comments on notes, with mention notifications through the existing notification and push pipeline.
16. **Activity feed and audit log (S–M).** Extend `/activities` with deletes, restores, role changes and logins. Audit logs are a common requirement in SaaS sales.

### Reminders and productivity
17. **Recurring reminders (S–M).** Daily, weekly or custom RRULE schedules, plus snooze from the notification. Fix H-2 first.
18. **Location-based reminders (M).** The `reminder_location` column exists; add geofencing in the PWA.
19. **Calendar sync (M).** An ICS feed of due dates and reminders, and optionally two-way Google/Outlook sync.
20. **Kanban board view (S–M).** The status values (`pending`, `in_progress`, `completed`) are already there; add a drag-and-drop board per workspace or folder.

### Platform
21. **Offline-first PWA with sync (L).** Cache notes in IndexedDB, queue mutations offline, and reconcile on reconnect. The service worker today only caches the app shell.
22. **Public REST API with personal access tokens and webhooks (M).** Scoped API keys (stored hashed), OpenAPI docs generated from the existing Fastify schemas, and outbound webhooks on note events, which enables Zapier, n8n and similar.
23. **Web clipper browser extension (M).** Save a page, selection or screenshot to a note, using the link-preview pipeline.
24. **Import and export expansion (M).** Notion, Evernote (`.enex`), Apple Notes and Obsidian vault import. Export to a Markdown ZIP with attachments, and to PDF.
25. **AI assistant (M).** Summarize a note, generate action items, semantic search ("notes about the Q3 budget") with embeddings, auto-tag suggestions, and voice-note transcription cleanup. Keep it opt-in per workspace for self-hosters.

### Accounts, security and SaaS
26. **Two-factor authentication and OAuth/SSO (M).** TOTP and passkeys (WebAuthn); Google, GitHub and OIDC sign-in; SAML for business tiers.
27. **End-to-end encrypted notes or vaults (L).** Client-side encryption for selected notes, using a key derived from a passphrase. A strong selling point for a privacy-focused self-hosted product.
28. **Billing, plans and an admin console (M–L).** Stripe subscriptions, per-plan quotas (storage, members, version-history retention), and an instance admin dashboard (users, suspensions, storage, backup health, invite-only toggle). The README notes that no billing backend exists yet.

---

*All [Verified] findings were reproduced with throwaway scripts against an in-memory database or headless Chromium. Those scripts were removed afterwards, and no repository files other than this report were changed.*
