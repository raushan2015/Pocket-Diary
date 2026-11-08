# Alert: MigrationFailed

**Severity:** Critical
**Source:** Startup logs: "Migration failed" / Drizzle migration error / Schema version mismatch / Health check fails after deploy
**Runbook:** This file

## Symptoms
- Container fails to start / health check fails
- Logs: `Error: Migration failed`, `SQLITE_ERROR: duplicate column`, `relation already exists`
- `drizzle-kit migrate` exits non-zero
- Schema version in `_drizzle_migrations` doesn't match code

## Diagnosis Steps

1. **Check migration logs**
   ```bash
   docker compose logs memo-manager | grep -A 20 -i migration
   # Exact error: column exists? constraint? data type?
   ```

2. **Check applied migrations**
   ```bash
   docker compose exec memo-manager sqlite3 /app/data/memo_manager.db \
     "SELECT * FROM _drizzle_migrations ORDER BY created_at;"
   ```

3. **Check current schema**
   ```bash
   docker compose exec memo-manager sqlite3 /app/data/memo_manager.db .schema
   # Compare to backend/src/db/schema.ts
   ```

4. **Identify failure point**
   - New migration file added?
   - Migration edited after apply? (NEVER DO THIS)
   - Data migration failing (e.g., NOT NULL on existing rows)?

## Mitigation

**IMMEDIATE: Rollback to previous image**
```bash
# If using tagged images
docker compose pull memo-manager:previous-tag
docker compose up -d memo-manager

# Or if using local build
git checkout <last-known-good-commit>
docker compose up -d --build memo-manager
```

**DO NOT:**
- ❌ Edit migration files after they've run
- ❌ Manually hack schema to "fix" migration
- ❌ Delete `_drizzle_migrations` table

## Resolution

| Failure Type | Fix |
|--------------|-----|
| Duplicate column | Migration already applied; check version table; skip if idempotent |
| NOT NULL violation | Add default in migration; or backfill data first |
| FK constraint fails | Ensure referenced data exists; order migrations correctly |
| Migration edited | Restore original migration; create new correction migration |
| Schema drift | Generate fresh migration: `drizzle-kit generate` (review carefully!) |

### Safe Migration Recovery Procedure

```bash
# 1. Stop app
docker compose stop memo-manager

# 2. Backup DB
docker run --rm -v memo_manager_data:/data -v "$PWD":/out debian:bookworm-slim \
  cp /data/memo_manager.db /out/pre-migration-fix.db

# 3. Manually apply fix (if simple)
docker run --rm -v memo_manager_data:/data debian:bookworm-slim \
  sqlite3 /data/memo_manager.db "ALTER TABLE memos ADD COLUMN new_col TEXT DEFAULT '';"

# 4. Mark migration as applied (if Drizzle thinks it's pending)
docker run --rm -v memo_manager_data:/data debian:bookworm-slim \
  sqlite3 /data/memo_manager.db \
  "INSERT INTO _drizzle_migrations (id, name, created_at) VALUES ('<hash>', '<migration_name>', $(date +%s)000);"

# 5. Verify schema matches code
docker run --rm -v memo_manager_data:/data debian:bookworm-slim \
  sqlite3 /data/memo_manager.db .schema | diff - backend/src/db/schema.sql

# 6. Restart
docker compose up -d memo-manager
```

## Escalation

- **Immediate**: Rollback; page backend engineer
- **< 30 min**: If rollback works, investigate migration in staging
- **< 2 hours**: Fix migration; test in staging; redeploy
- **If data loss**: Restore from backup (see [BackupFailed](./backup-failed.md))

## Post-Incident

- [ ] Add migration test to CI: `drizzle-kit migrate` on fresh + upgraded DB
- [ ] Never edit applied migrations (enforce in CI)
- [ ] Document migration authoring rules
- [ ] Add pre-deploy migration dry-run step