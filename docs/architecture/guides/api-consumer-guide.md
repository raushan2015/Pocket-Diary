# Pocket Diary API Consumer Guide

> **Audience:** Developers building integrations, custom clients, automation
> **Version:** API v1
> **Base URL:** `https://your-instance.com/api/v1`
> **OpenAPI Spec:** `https://your-instance.com/docs/json`

---

## Table of Contents

1. [Authentication](#authentication)
2. [Rate Limits](#rate-limits)
3. [Pagination](#pagination)
4. [Error Handling](#error-handling)
5. [Core Workflows](#core-workflows)
6. [Webhooks (Future)](#webhooks-future)
7. [SDKs & Examples](#sdks--examples)

---

## Authentication

### Session Cookie (Browser / Server-to-Server)
```
Cookie: memo_session=<session-token>
```
- Obtained via `POST /auth/login` or `POST /auth/register`
- **HttpOnly** — not accessible to JavaScript (security)
- **SameSite=Lax** — CSRF protection
- Include `credentials: 'include'` in fetch

### Login Flow
```bash
# 1. Register (if new user)
curl -X POST https://notes.example.com/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"SecurePass123","name":"User"}' \
  -c cookies.txt

# 2. Login (returns session cookie)
curl -X POST https://notes.example.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"SecurePass123"}' \
  -c cookies.txt -b cookies.txt

# 3. Use cookie for subsequent requests
curl -b cookies.txt https://notes.example.com/api/v1/memos?workspaceId=ws_123
```

### Mobile / Non-Browser Clients
- Store session token securely (Keychain/Keystore)
- Send as `Cookie: memo_session=<token>` header
- Token = raw 256-bit value (server stores SHA-256 hash)
- Session expires after 7 days inactivity (sliding)

### Session Management
| Endpoint | Description |
|----------|-------------|
| `GET /auth/me` | Current user + sessions |
| `GET /auth/sessions` | List active sessions (device, IP, UA) |
| `DELETE /auth/sessions/:id` | Revoke one session |
| `DELETE /auth/sessions` | Revoke all EXCEPT current |
| `PATCH /auth/password` | Change password (revokes all others) |

---

## Rate Limits

| Tier | Limit | Window | Scope |
|------|-------|--------|-------|
| Global | 300 req | 1 minute | Per IP |
| Auth (login/register) | 10 req | 1 minute | Per IP + Per email |
| Attachment upload | 20 req | 1 minute | Per user |

**Headers:**
```
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 299
X-RateLimit-Reset: 1700000000  # Unix epoch seconds
Retry-After: 45  # Seconds (on 429)
```

**On 429:** Back off exponentially, respect `Retry-After`

---

## Pagination

All list endpoints support:
```
GET /memos?workspaceId=ws_123&page=1&limit=50
```

**Query Parameters:**
| Param | Default | Max | Description |
|-------|---------|-----|-------------|
| `page` | 1 | 100000 | Page number (1-indexed) |
| `limit` | 50 | 100 | Items per page |

**Response:**
```json
{
  "memos": [...],
  "total": 1234,
  "page": 1,
  "limit": 50
}
```

**Total pages:** `Math.ceil(total / limit)`

---

## Error Handling

### Error Envelope (All non-2xx)
```json
{
  "error": "Bad Request",
  "message": "Human-readable explanation"
}
```

### HTTP Status Codes
| Code | Meaning | Retryable? |
|------|---------|------------|
| 400 | Invalid input / validation failed | No (fix request) |
| 401 | Unauthenticated / session expired | No (re-login) |
| 403 | Forbidden (role / workspace) | No |
| 404 | Not found (or cross-workspace) | No |
| 409 | Conflict (version mismatch / duplicate) | No (resolve conflict) |
| 413 | Payload too large | No (reduce size) |
| 415 | Unsupported media type | No |
| 429 | Rate limited | **Yes** (after Retry-After) |
| 500 | Server error | **Yes** (exponential backoff) |
| 503 | Service unavailable | **Yes** |

### Special Error: 409 Version Conflict (Memos)
```json
{
  "error": "Conflict",
  "message": "Version conflict: another editor saved a newer version. Re-fetch the memo, merge, and retry.",
  "currentVersion": 5
}
```
**Resolution:** `GET /memos/:id` → merge changes → `PATCH` with `version: 5`

---

## Core Workflows

### 1. Create a Note
```bash
curl -X POST https://notes.example.com/api/v1/memos \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "ws_abc123",
    "title": "Meeting notes",
    "content": "Discussed Q4 roadmap...",
    "noteType": "text",
    "color": "blue",
    "tags": ["meeting", "q4"],
    "isPinned": true
  }'
```

**Response (201):**
```json
{
  "memo": {
    "id": "memo_xyz789",
    "workspaceId": "ws_abc123",
    "title": "Meeting notes",
    "content": "Discussed Q4 roadmap...",
    "noteType": "text",
    "color": "blue",
    "tags": ["meeting", "q4"],
    "isPinned": true,
    "version": 1,
    "createdAt": 1700000000000,
    "updatedAt": 1700000000000,
    "attachments": [],
    "category": null,
    "folderId": null,
    ...
  }
}
```

### 2. List Notes with Filters
```bash
# Search + filter
curl -b cookies.txt "https://notes.example.com/api/v1/memos?workspaceId=ws_abc123&search=roadmap&label=meeting&isPinned=true&page=1&limit=20&sortBy=updatedAt&sortOrder=desc"
```

**Filter Parameters:**
| Param | Type | Example |
|-------|------|---------|
| `workspaceId` | string (required) | `ws_abc123` |
| `status` | string | `pending`, `archived` |
| `priority` | string | `high`, `urgent` |
| `categoryId` | string | `cat_123` |
| `tagId` / `tagName` | string | `tag_456` / `meeting` |
| `folderId` | string | `folder_789` |
| `isFavorite` | `true`/`false` | `true` |
| `isPinned` | `true`/`false` | `true` |
| `isArchived` | `true`/`false` | `false` |
| `hasReminder` | `true`/`false` | `true` |
| `includeDeleted` | `true`/`false` | `false` |
| `deletedOnly` | `true`/`false` | `false` |
| `search` | string | `roadmap` |

### 3. Update Note (Optimistic Concurrency)
```bash
curl -X PATCH https://notes.example.com/api/v1/memos/memo_xyz789 \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Updated content...",
    "version": 1
  }'
```

**If 409:** Re-fetch note, get `currentVersion`, merge, retry with new version.

### 4. Upload Attachment
```bash
curl -X POST https://notes.example.com/api/v1/attachments \
  -b cookies.txt \
  -F "memoId=memo_xyz789" \
  -F "file=@/path/to/image.png"
```

**Response (201):**
```json
{
  "attachment": {
    "id": "att_123",
    "memoId": "memo_xyz789",
    "fileName": "image.png",
    "fileSize": 123456,
    "mimeType": "image/png",
    "url": "/api/v1/attachments/att_123",
    "createdAt": 1700000000000
  }
}
```

**Download:** `GET /attachments/:id` (streams file, same auth)
**Inline images:** `GET /attachments/:id?inline=true` (for safe images only)

### 5. Set Reminder
```bash
curl -X PATCH https://notes.example.com/api/v1/memos/memo_xyz789 \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{
    "reminderTime": 1700050000000,
    "version": 2
  }'
```
- `reminderTime` = Unix epoch **milliseconds** (UTC)
- Server scans every 30s (configurable) → creates in-app notification
- Email/Push if configured

### 6. Workspace Collaboration
```bash
# List my workspaces
curl -b cookies.txt https://notes.example.com/api/v1/workspaces

# Create workspace
curl -X POST https://notes.example.com/api/v1/workspaces \
  -b cookies.txt -H "Content-Type: application/json" \
  -d '{"name": "Team Project"}'

# Invite member
curl -X POST https://notes.example.com/api/v1/workspaces/ws_abc123/invites \
  -b cookies.txt -H "Content-Type: application/json" \
  -d '{"email": "colleague@example.com", "role": "editor"}'

# Response includes inviteUrl (shareable link) + raw token (once)
```

### 7. Search
```bash
curl -b cookies.txt "https://notes.example.com/api/v1/memos?workspaceId=ws_abc123&search=roadmap&tagName=meeting"
```

### 8. Export Workspace (Full Fidelity)
```bash
curl -b cookies.txt https://notes.example.com/api/v1/migration/export?workspaceId=ws_abc123
```
Returns `ExportedWorkspace` — importable via `POST /migration/import-local`

---

## Webhooks (Future)

> **Not yet implemented.** Planned for v2.

Planned events:
- `memo.created`, `memo.updated`, `memo.deleted`, `memo.restored`
- `workspace.member_added`, `workspace.member_removed`, `workspace.role_changed`
- `reminder.triggered`
- `attachment.uploaded`, `attachment.deleted`

---

## SDKs & Examples

### JavaScript / TypeScript (Node + Browser)
```typescript
// Simple fetch wrapper
class PocketDiaryClient {
  constructor(baseUrl, cookieJar) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cookies = cookieJar;
  }

  async request(path, options = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!res.ok) {
      const err = await res.json();
      throw new PocketDiaryError(res.status, err.error, err.message);
    }
    return res.json();
  }

  // Auth
  login(email, password) { return this.request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); }
  register(email, password, name) { return this.request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) }); }

  // Memos
  listMemos(workspaceId, params = {}) {
    const qs = new URLSearchParams({ workspaceId, ...params }).toString();
    return this.request(`/memos?${qs}`);
  }
  getMemo(id) { return this.request(`/memos/${id}`); }
  createMemo(data) { return this.request('/memos', { method: 'POST', body: JSON.stringify(data) }); }
  updateMemo(id, data) { return this.request(`/memos/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteMemo(id, permanent = false) { return this.request(`/memos/${id}?permanent=${permanent}`, { method: 'DELETE' }); }

  // Attachments
  uploadAttachment(memoId, file) {
    const form = new FormData();
    form.append('memoId', memoId);
    form.append('file', file);
    return this.request('/attachments', { method: 'POST', body: form, headers: {} });
  }

  // Workspaces
  listWorkspaces() { return this.request('/workspaces'); }
  inviteMember(workspaceId, email, role = 'editor') {
    return this.request(`/workspaces/${workspaceId}/invites`, { method: 'POST', body: JSON.stringify({ email, role }) });
  }
}
```

### Python Example
```python
import requests
from requests.cookies import RequestsCookieJar

class PocketDiaryClient:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip('/')
        self.session = requests.Session()
    
    def login(self, email, password):
        resp = self.session.post(f'{self.base_url}/auth/login', json={'email': email, 'password': password})
        resp.raise_for_status()
        return resp.json()
    
    def list_memos(self, workspace_id, **params):
        params['workspaceId'] = workspace_id
        resp = self.session.get(f'{self.base_url}/memos', params=params)
        resp.raise_for_status()
        return resp.json()
    
    def create_memo(self, workspace_id, **data):
        data['workspaceId'] = workspace_id
        resp = self.session.post(f'{self.base_url}/memos', json=data)
        resp.raise_for_status()
        return resp.json()

# Usage
client = PocketDiaryClient('https://notes.example.com/api/v1')
client.login('user@example.com', 'password')
notes = client.list_memos('ws_abc123', search='meeting', limit=10)
```

### cURL Cheatsheet
```bash
# Login & save cookies
curl -c cookies.txt -X POST -H "Content-Type: application/json" \
  -d '{"email":"u@e.com","password":"p"}' https://notes.example.com/api/v1/auth/login

# All subsequent requests use -b cookies.txt
curl -b cookies.txt https://notes.example.com/api/v1/memos?workspaceId=ws_123
curl -b cookies.txt -X POST -H "Content-Type: application/json" -d '{"workspaceId":"ws_123","title":"Hi"}' https://notes.example.com/api/v1/memos
curl -b cookies.txt -X PATCH -H "Content-Type: application/json" -d '{"content":"New","version":1}' https://notes.example.com/api/v1/memos/memo_123
curl -b cookies.txt -X POST -F "memoId=memo_123" -F "file=@img.png" https://notes.example.com/api/v1/attachments
```

---

## Versioning & Compatibility

- **API Version:** `/api/v1` prefix — breaking changes = `/api/v2`
- **Capability Discovery:** `GET /system/info` returns version + features
- **Mobile Compatibility:** Checks `/system/info` on startup; degrades gracefully
- **Deprecation:** 6-month notice, `Sunset` header, changelog

---

## Testing

### Test Instance
```bash
# Run local test instance
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
BASE_URL=http://localhost:8080 npm test  # In tests/ directory
```

### Postman Collection
> Available at `/docs/json` — import into Postman for interactive testing

---

## Support

- **API Issues:** GitHub Issues with `api` label
- **Breaking Changes:** Announced in releases + `Sunset` headers
- **Custom Integrations:** Discuss in GitHub Discussions before building