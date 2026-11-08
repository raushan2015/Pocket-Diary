# Pocket Diary Migration Guide

> **Audience:** Administrators upgrading between versions
> **Policy:** SemVer — MAJOR = breaking changes, MINOR = features, PATCH = fixes

---

## Version History

| Version | Date | Type | Key Changes |
|---------|------|------|-------------|
| 1.0.0 | 2024-01 | Major | Initial release |
| 1.1.0 | 2024-02 | Minor | Added categories, reminders email, Web Push |
| 1.2.0 | 2024-03 | Minor | Google Keep import, drawing, activity feed |
| 2.0.0 | TBD | Major | PostgreSQL support, horizontal scaling |

---

## Upgrade Procedures

### Patch Upgrades (1.x.y → 1.x.z)
**Risk:** Low | **Downtime:** ~10s | **Rollback:** Automatic via backup

```bash
# 1. Backup (automatic but verify)
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db ".backup /app/data/backups/pre-patch-$(date +%s).db"

# 2. Pull new image
docker compose pull

# 3. Deploy
docker compose up -d

# 4. Verify
curl -f http://localhost:8080/health
docker compose logs memo-manager | grep -E 'started|migration'
```

**No manual steps needed.** Migrations run automatically on startup.

---

### Minor Upgrades (1.x → 1.y)
**Risk:** Low-Medium | **Downtime:** ~30s | **Rollback:** Restore backup

```bash
# 1. Read CHANGELOG for new features/config
# 2. Backup
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db ".backup /app/data/backups/pre-minor-$(date +%s).db"

# 3. Check for new env vars in .env.example
diff .env.example .env  # Add any new required vars

# 4. Pull & deploy
docker compose pull
docker compose up -d

# 5. Verify migrations
docker compose logs memo-manager | grep -A5 -B5 migration

# 6. Test new features
# - Try new functionality per CHANGELOG
```

**Common minor upgrade changes:**
- New optional env vars (add to `.env`)
- New columns with defaults (auto-migrated)
- New indexes (built in background)
- New API endpoints (backward compatible)

---

### Major Upgrades (1.x → 2.0)
**Risk:** High | **Downtime:** Minutes-hours | **Rollback:** Full restore required

> **⚠️ Major upgrades involve breaking changes. Read this entire section first.**

#### Planned 2.0 Changes
- PostgreSQL support (optional, SQLite still default)
- Horizontal scaling (multiple replicas)
- Attachment storage: S3/MinIO
- Webhook system
- API v2 with breaking changes
- New mobile sync protocol

#### Pre-Upgrade Checklist
- [ ] **Full backup** (database + attachments + config)
- [ ] **Test in staging** with production data snapshot
- [ ] **Schedule maintenance window** (notify users)
- [ ] **Review breaking changes** in CHANGELOG
- [ ] **Prepare rollback plan** (time-boxed)

#### Upgrade Steps (2.0 Example)
```bash
# 1. MAINTENANCE MODE - Stop accepting traffic
#    (Update reverse proxy to show maintenance page)

# 2. FINAL BACKUP
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db ".backup /app/data/backups/pre-2.0-$(date +%s).db"
# Also backup attachments
tar -czf /tmp/attachments-pre-2.0.tgz /app/data/attachments

# 3. MIGRATE DATABASE (if schema changes)
#    For PostgreSQL migration:
#    - Provision PostgreSQL
#    - Run migration script (provided in release)
#    - Verify row counts match

# 4. DEPLOY NEW VERSION
docker compose pull
# Update docker-compose.yml for new services (PostgreSQL, object storage)
docker compose up -d

# 5. RUN MIGRATIONS
docker compose exec memo-manager npx drizzle-kit migrate

# 6. VERIFY
curl -f http://localhost:8080/health
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db "PRAGMA integrity_check;"
# For PostgreSQL: run verification queries

# 7. SMOKE TESTS
# - Login, create note, search, invite, upload attachment
# - Mobile app sync
# - Reminder delivery

# 8. RESTORE TRAFFIC
#    Remove maintenance page

# 9. MONITOR (30 min)
#    Error rates, latency, sync success
```

#### Rollback Procedure
```bash
# 1. Stop new version
docker compose down

# 2. Restore database
docker run --rm -v memo_manager_data:/data -v /tmp:/backup debian:bookworm-slim \
  sh -c "cp /backup/pre-2.0-*.db /data/memo_manager.db && rm -f /data/memo_manager.db-wal /data/memo_manager.db-shm"

# 3. Restore attachments
tar -xzf /tmp/attachments-pre-2.0.tgz -C /app/data/

# 4. Deploy old version
docker compose -f docker-compose.old.yml up -d

# 5. Verify
curl -f http://localhost:8080/health
```

---

## Migration Testing (CI)

Automated in GitHub Actions (see [CI/CD](../ci-cd/github-actions.yml)):

```yaml
migration-test:
  - Fresh install: drizzle-kit migrate on empty DB
  - Upgrade test: Apply migrations on previous-release DB snapshot
  - Idempotency: Run migrate twice (should succeed)
  - Integrity: PRAGMA integrity_check + foreign_key_check
```

### Running Locally
```bash
# Fresh install test
cd backend
DATABASE_PATH=/tmp/fresh.db npx drizzle-kit migrate
sqlite3 /tmp/fresh.db "PRAGMA integrity_check;"

# Upgrade test (from previous tag)
git checkout v1.2.0
npm ci && npm run build
DATABASE_PATH=/tmp/upgrade.db npx drizzle-kit migrate

git checkout main
npm ci && npm run build
DATABASE_PATH=/tmp/upgrade.db npx drizzle-kit migrate  # Should be no-op
sqlite3 /tmp/upgrade.db "PRAGMA integrity_check;"
```

---

## Data Migration Patterns

### Adding Columns (Safe)
```sql
-- In migration file (timestamped, immutable)
ALTER TABLE memos ADD COLUMN new_field TEXT DEFAULT '';
-- Default handles existing rows
```

### Adding NOT NULL Columns (Careful)
```sql
-- Step 1: Add nullable
ALTER TABLE memos ADD COLUMN new_field TEXT;

-- Step 2: Backfill (in migration or separate script)
UPDATE memos SET new_field = 'default' WHERE new_field IS NULL;

-- Step 3: Add NOT NULL (if needed)
-- SQLite doesn't support ALTER COLUMN NOT NULL directly
-- Create new table → copy → rename (handled by Drizzle)
```

### Renaming Columns (Breaking)
> **Never rename.** Add new column, backfill, deprecate old.
```sql
-- ADD new column
ALTER TABLE memos ADD COLUMN new_name TEXT;
UPDATE memos SET new_name = old_name;
-- Code reads new_name, writes both for transition period
-- After 2 releases: drop old_name (new migration)
```

### Indexes
```sql
-- Add in migration (built online in SQLite WAL)
CREATE INDEX idx_memos_new_field ON memos(workspace_id, new_field);
```

### Data Transformations
```javascript
// In migration service (backend/src/services/migration.service.ts)
export async function migrateData(db) {
  const rows = db.prepare('SELECT * FROM old_table').all();
  for (const row of rows) {
    db.prepare('INSERT INTO new_table ...').run(transform(row));
  }
}
```

---

## Environment Variable Migrations

| Old Var | New Var | Action |
|---------|---------|--------|
| `PORT` | `PORT` | Same |
| `COOKIE_SECRET` | `COOKIE_SECRET` | Same (rotate periodically) |
| `APP_URL` | `APP_URL` | Same (required in prod) |
| `DATABASE_URL` | — | Removed (SQLite only) |
| — | `STORAGE_QUOTA_GB` | Add (default 10) |
| — | `BACKUP_REPLICATION_DIR` | Add for off-host backup |
| — | `VAPID_PUBLIC_KEY` | Add for Web Push |
| — | `VAPID_PRIVATE_KEY` | Add for Web Push |

**Always check `.env.example`** for new required/optional variables.

---

## Mobile App Compatibility

| Mobile Version | Min API Version | Notes |
|----------------|-----------------|-------|
| 1.0.x | 1.0 | Baseline |
| 1.1.x | 1.1 | Categories, push |
| 1.2.x | 1.2 | Keep import, drawing |
| 2.0.x | 2.0 | New sync protocol |

**Compatibility Check:** Mobile calls `GET /system/info` on startup:
```json
{
  "version": "1.2.0",
  "capabilities": ["categories", "push", "keep-import", "drawing"],
  "minMobileVersion": "1.0.0"
}
```
- If mobile < `minMobileVersion`: Show update required screen
- If API < mobile needs: Degrade gracefully (disable unsupported features)

---

## Rollback Decision Matrix

| Scenario | Can Rollback? | Procedure |
|----------|---------------|-----------|
| Patch deploy failed | ✅ Yes | `docker compose up -d` previous image |
| Minor upgrade issue | ✅ Yes | Restore pre-upgrade backup |
| Major upgrade issue | ⚠️ Complex | Full restore + old compose file |
| Migration corrupted DB | ❌ No | Restore from backup (pre-migration) |
| Data loss detected | ❌ No | Restore from backup + notify users |

**Rule:** If unsure, restore backup. Data > uptime.

---

## Communication Template

### Pre-Upgrade Notice (24h before)
```
Subject: Pocket Diary Maintenance - [Date] [Time] UTC

We'll be upgrading Pocket Diary to v[X.Y.Z] on [date] at [time] UTC.
Expected downtime: [X minutes/hours].

What's changing: [link to CHANGELOG]
Your data is safe: Automated backup runs before upgrade.
```

### Post-Upgrade Notice
```
Subject: Pocket Diary Upgrade Complete - v[X.Y.Z]

Upgrade completed successfully at [time] UTC.
New features: [highlights]
Known issues: [if any]
Report problems: [GitHub Issues link]
```

---

## Support Matrix

| Version | Status | Supported Until | Migration Path |
|---------|--------|-----------------|----------------|
| 1.0.x | Maintenance | 2024-12-31 | → 1.2.x |
| 1.1.x | Maintenance | 2025-03-31 | → 1.2.x |
| 1.2.x | Active | 2025-12-31 | → 2.0.x |
| 2.0.x | Planned | TBD | — |

**LTS:** Latest minor of each major (currently 1.2.x)