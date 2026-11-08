# Pocket Diary - Administrator Guide

> **Audience:** Self-hosters, system administrators, DevOps engineers
> **Version:** 1.0 (matches API v1)

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Configuration](#configuration)
3. [Deployment](#deployment)
4. [Backup & Restore](#backup--restore)
5. [Monitoring & Observability](#monitoring--observability)
6. [Security Hardening](#security-hardening)
7. [Upgrading](#upgrading)
8. [Troubleshooting](#troubleshooting)
9. [Reference](#reference)

---

## Quick Start

### Prerequisites
- Docker Engine 24+ and Docker Compose v2
- 1GB+ RAM, 2GB+ disk (more for attachments)
- Domain name with TLS (recommended) or local LAN access

### 5-Minute Deploy
```bash
# 1. Clone
git clone https://github.com/raushan2015/Pocket-Diary.git
cd Pocket-Diary

# 2. Configure
cp .env.example .env
# Edit .env - REQUIRED: COOKIE_SECRET, APP_URL
openssl rand -hex 32  # Generate COOKIE_SECRET

# 3. Deploy
docker compose up -d --build

# 4. Verify
curl http://localhost:8080/health
# {"status":"ok","timestamp":1234567890}

# 5. Access
open http://localhost:8080  # Or your domain
```

---

## Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `COOKIE_SECRET` | **Required.** 32+ char random string for session signing. Generate with `openssl rand -hex 32`. Never commit. | `a1b2c3d4e5f6...` |
| `APP_URL` | **Required in production.** Public HTTPS URL for email links (invites, password reset). Must not be derived from headers. | `https://notes.example.com` |

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Host port for web interface |
| `NODE_ENV` | `production` | `development` for dev mode |
| `DATABASE_PATH` | `/app/data/memo_manager.db` | SQLite path (inside data volume) |
| `ATTACHMENTS_DIR` | `/app/data/attachments` | Attachment storage (must be in data volume) |
| `TRUST_PROXY` | `127.0.0.1` | Trusted proxy IPs for `X-Forwarded-For` (rate limiting) |
| `RATE_LIMIT_MAX` | `300` | Requests/minute global limit |
| `STORAGE_QUOTA_GB` | `10` | Per-workspace storage quota (GB) |
| `BACKUP_INTERVAL_HOURS` | `24` | Backup frequency |
| `BACKUP_RETENTION` | `7` | Local backups to keep |
| `BACKUP_REPLICATION_DIR` | *(empty)* | Off-host replication path (mount NFS/SMB) |
| `BACKUP_REPLICATION_RETENTION` | `7` | Replicated backups to keep |

### Email (SMTP) - Optional but Recommended

| Variable | Description |
|----------|-------------|
| `SMTP_HOST` | SMTP server (e.g., `smtp.gmail.com`) |
| `SMTP_PORT` | Port (587 for STARTTLS, 465 for SSL) |
| `SMTP_SECURE` | `true` for 465, `false` for 587 |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password / app password |
| `SMTP_FROM` | From address (e.g., `Notes <no-reply@notes.example.com>`) |

**Without SMTP:** Password reset & invitations work via copyable links only (admin must share manually).

### Web Push (VAPID) - Optional

| Variable | Description |
|----------|-------------|
| `VAPID_PUBLIC_KEY` | Generate: `npx web-push generate-vapid-keys` |
| `VAPID_PRIVATE_KEY` | Private key from above |
| `VAPID_SUBJECT` | `mailto:admin@notes.example.com` (contact for push service) |

**Without VAPID:** Browser push notifications disabled; in-app notifications still work.

---

## Deployment

### Docker Compose (Recommended)

```yaml
# docker-compose.yml (included)
services:
  memo-manager:
    image: memo-manager:latest
    restart: unless-stopped
    ports:
      - "${PORT:-8080}:8080"
    environment:
      - NODE_ENV=production
      - COOKIE_SECRET=${COOKIE_SECRET}
      - APP_URL=${APP_URL}
      # ... all vars from .env
    volumes:
      - memo_data:/app/data
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://127.0.0.1:8080/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s
volumes:
  memo_data:
    name: memo_manager_data
```

### Reverse Proxy (Production)

**Required for HTTPS.** The app runs HTTP on port 8080 internally.

#### Nginx Example
```nginx
server {
    listen 443 ssl http2;
    server_name notes.example.com;

    ssl_certificate /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";
    add_header Referrer-Policy "strict-origin-when-cross-origin";

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }

    # Health check bypass (optional)
    location /health {
        proxy_pass http://127.0.0.1:8080/health;
        access_log off;
    }
}
```

#### Caddy Example (Auto HTTPS)
```caddy
notes.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

### Tailscale / VPN (Private Access)
```bash
# Run behind Tailscale for zero-config private access
tailscale serve --https=443 --bg 8080
# Access at https://<machine-name>.<tailnet>.ts.net
```

### Kubernetes / Docker Swarm
> **⚠️ Single-instance only.** Do not scale replicas with shared volume (SQLite corruption).
> See [Operational Limits](../adr/ADR-002-operational-limits.md).

```yaml
# K8s example - single replica
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pocket-diary
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pocket-diary
  template:
    spec:
      containers:
      - name: app
        image: ghcr.io/raushan2015/pocket-diary:latest
        ports:
        - containerPort: 8080
        envFrom:
        - secretRef:
            name: pocket-diary-secrets
        volumeMounts:
        - name: data
          mountPath: /app/data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: pocket-diary-pvc
```

---

## Backup & Restore

### Automatic Backups
- Runs every `BACKUP_INTERVAL_HOURS` (default 24h)
- Keeps `BACKUP_RETENTION` (default 7) local snapshots
- Stored in `/app/data/backups/` inside data volume
- If `BACKUP_REPLICATION_DIR` mounted, copies there too

### Manual Backup
```bash
# Create snapshot
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db ".backup /app/data/backups/manual-$(date +%s).db"

# Verify
docker compose exec memo-manager sqlite3 /app/data/backups/manual-*.db "PRAGMA integrity_check;"
```

### Restore Procedure (Tested)
```bash
# 1. Stop app
docker compose stop memo-manager

# 2. Find latest backup
docker run --rm -v memo_manager_data:/data debian:bookworm-slim \
  ls -lt /data/backups/

# 3. Restore (replace <latest> with filename)
docker run --rm -v memo_manager_data:/data -v "$PWD":/out debian:bookworm-slim \
  sh -c "cp /data/backups/<latest> /data/memo_manager.db && rm -f /data/memo_manager.db-wal /data/memo_manager.db-shm"

# 4. Verify integrity
docker run --rm -v memo_manager_data:/data debian:bookworm-slim \
  sqlite3 /data/memo_manager.db "PRAGMA integrity_check;"

# 5. Start app
docker compose up -d memo-manager
curl -f http://localhost:8080/health
```

### Off-Host Replication
Mount external storage to `BACKUP_REPLICATION_DIR`:
```yaml
volumes:
  - /mnt/backups/notes-replica:/app/backup-replica
```
Set `BACKUP_REPLICATION_DIR=/app/backup-replica` in `.env`.

---

## Monitoring & Observability

### Health Checks
```bash
# Liveness (container orchestration)
curl -f http://localhost:8080/health
# {"status":"ok","timestamp":1234567890}

# Readiness (load balancer)
curl -f http://localhost:8080/api/v1/health
```

### Key Metrics to Monitor

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| HTTP 5xx rate | Logs / Prometheus | > 1% for 5m |
| HTTP 429 rate | Logs | > 10/min |
| Backup age | `/api/v1/system/backup-status` | > 25h |
| Disk usage | `df /app/data` | > 85% |
| DB size | `ls -lh /app/data/memo_manager.db` | > 1GB |
| WAL size | `ls -lh /app/data/memo_manager.db-wal` | > 100MB |
| Active sessions | `SELECT COUNT(*) FROM sessions WHERE expires_at > now;` | Baseline |
| Reminder delivery | `notifications` table null `emailSentAt`/`pushSentAt` | > 1h old |

### Logging
- Structured JSON logs to stdout
- Levels: `info` (default), `debug` (dev), `error` (failures)
- No PII in logs (notes, emails, tokens redacted)
- Correlate with `requestId` header

### Prometheus Metrics (Future)
> Not yet implemented. Add `prom-client` to backend for `/metrics` endpoint.

### Grafana Dashboards (Future)
> Import community dashboards for Node.js, SQLite, Docker.

---

## Security Hardening

### Checklist
- [ ] `COOKIE_SECRET` ≥ 32 chars, random, not in Git
- [ ] `APP_URL` set to HTTPS domain
- [ ] Reverse proxy terminates TLS (HTTPS only)
- [ ] `TRUST_PROXY` set to proxy IP only (not `*`)
- [ ] Rate limiting enabled (`RATE_LIMIT_MAX`)
- [ ] Data volume permissions: `node:node` (UID 1000)
- [ ] Container runs as non-root (`USER node` in Dockerfile)
- [ ] Backups encrypted if off-host (LUKS/age/gpg)
- [ ] SMTP/VAPID secrets not in logs
- [ ] Regular `docker compose pull` + rebuild for base image updates

### Cookie Security
- `HttpOnly; Secure; SameSite=Lax; Path=/`
- Session tokens: 256-bit random, stored as SHA-256 hash
- Password change revokes all other sessions
- Admin can revoke individual device sessions

### Database
- WAL mode enabled (better concurrency)
- `PRAGMA foreign_keys = ON`
- `PRAGMA busy_timeout = 5000`
- No plaintext passwords (Argon2id)

### Network
- Only port 8080 exposed (reverse proxy handles 80/443)
- Database & attachments never directly accessible
- CORS restricted to `APP_URL` in production

---

## Upgrading

### Pre-Upgrade Checklist
- [ ] Read [CHANGELOG](../CHANGELOG.md) for breaking changes
- [ ] Run backup (see above)
- [ ] Test upgrade in staging first
- [ ] Verify migration compatibility

### Upgrade Procedure
```bash
# 1. Backup
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db ".backup /app/data/backups/pre-upgrade-$(date +%s).db"

# 2. Pull new image / build
docker compose pull
# OR
git pull && docker compose build

# 3. Deploy (handles migrations automatically)
docker compose up -d

# 4. Verify
curl -f http://localhost:8080/health
docker compose logs -f memo-manager | grep -E '(migration|started|error)'

# 5. Smoke test
# - Login, create note, search, invite user
```

### Rollback
```bash
# If migration failed or issues:
docker compose stop memo-manager
# Restore pre-upgrade backup (see Restore Procedure)
docker compose up -d memo-manager
```

### Migration Safety
- Migrations are **immutable** — never edit applied migrations
- `drizzle-kit migrate` runs on startup
- Test fresh install + upgrade in CI (see [Migration Test](../ci-cd/github-actions.yml))

---

## Troubleshooting

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `COOKIE_SECRET` error on start | Missing/short secret | Set 32+ char in `.env` |
| `APP_URL` error on start | Missing in production | Set `APP_URL=https://...` in `.env` |
| "Database locked" / `SQLITE_BUSY` | Multiple writers / stale WAL | Restart container; check single instance |
| Upload fails (413) | File > 5MB limit | Increase `fastifyMultipart` limit in code |
| Email not sending | SMTP misconfigured | Check `SMTP_*` vars; test with `swaks` |
| Push not working | VAPID keys missing | Generate & set `VAPID_*` vars |
| Backup never runs | Interval not reached / crash | Check logs; manual backup works? |
| Health check fails | App not ready / port conflict | `docker compose logs`; check port 8080 free |
| Session lost on refresh | Proxy strips cookie / `Secure` on HTTP | Proxy must pass cookies; HTTPS required for `Secure` |
| Cross-workspace access | Bug / misconfig | **Critical** — check logs, verify RBAC, report |

### Debug Commands
```bash
# Container shell
docker compose exec memo-manager sh

# SQLite CLI
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db

# View logs
docker compose logs -f memo-manager --tail=100

# Check env vars
docker compose exec memo-manager env | grep -E '(COOKIE|APP_URL|SMTP|VAPID)'

# Database stats
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db \
  "SELECT 'users' as t, COUNT(*) FROM users UNION SELECT 'memos', COUNT(*) FROM memos UNION SELECT 'workspaces', COUNT(*) FROM workspaces;"

# Clear all sessions (force re-login)
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db "DELETE FROM sessions;"
```

### Log Analysis
```bash
# Errors only
docker compose logs memo-manager | grep -i error

# Slow queries (if logged)
docker compose logs memo-manager | grep -i "slow\|timeout"

# Auth failures
docker compose logs memo-manager | grep -E '40[13]'
```

---

## Reference

### File Structure (Inside Container)
```
/app/
├── backend/
│   ├── dist/           # Compiled TypeScript
│   └── node_modules/
├── frontend/           # Static assets (HTML, CSS, JS)
├── docker-entrypoint.sh
├── data/               # ← PERSISTENT VOLUME MOUNT
│   ├── memo_manager.db          # SQLite database
│   ├── memo_manager.db-wal      # WAL file
│   ├── memo_manager.db-shm      # SHM file
│   ├── attachments/             # Uploaded files
│   └── backups/                 # Automatic backups
└── backup-replica/     # ← Optional off-host replication mount
```

### API Endpoints (Admin Relevant)
| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | None | Liveness |
| `GET /api/v1/health` | None | API liveness |
| `GET /api/v1/system/backup-status` | Instance admin | Backup status |
| `GET /docs` | None | Swagger UI (if `DOCS_ENABLED=true`) |

### Instance Admin
- First registered user = instance admin (`isInstanceAdmin: true`)
- Can view backup status via Account Settings → Backups
- Cannot access other users' workspaces/notes

### Ports
| Port | Protocol | Purpose |
|------|----------|---------|
| 8080 | HTTP | Unified frontend + API (internal) |
| 3000 | HTTP | Backend only (internal, not exposed) |

### Version Compatibility
| Component | Versioning |
|-----------|------------|
| API | SemVer in `package.json` + `/api/v1` prefix |
| Database | Drizzle migrations (immutable, versioned) |
| Mobile | Checks `/api/v1/system/info` for capability negotiation |
| Frontend | Served by same container; version = API version |

---

## Support

- **Issues:** [GitHub Issues](https://github.com/raushan2015/Pocket-Diary/issues)
- **Security:** Email `security@techshan.ai` (not public issues)
- **Documentation:** This guide + [Architecture Docs](../)