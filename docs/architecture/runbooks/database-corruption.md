# Alert: DatabaseCorruption

**Severity:** Critical
**Source:** `PRAGMA integrity_check` fails / `SQLITE_CORRUPT` errors in logs / Backup restore verification fails
**Runbook:** This file

## Symptoms
- Logs show `SQLITE_CORRUPT`, `database disk image is malformed`
- `PRAGMA integrity_check` returns errors (not "ok")
- Queries fail with `SQLITE_CORRUPT`
- Backup verification test fails in CI

## Diagnosis Steps

1. **Confirm corruption**
   ```bash
   docker compose exec memo-manager sqlite3 /app/data/memo_manager.db "PRAGMA integrity_check;"
   # Output: *** in database main ***
   # Multiple errors listed
   ```

2. **Check WAL/SHM files**
   ```bash
   ls -lh /app/data/memo_manager.db*
   # Large -wal file? Missing -shm?
   ```

3. **Check recent events**
   - Host crash / power loss?
   - Disk full during write?
   - Container killed mid-transaction?
   - Multiple processes writing same DB?

4. **Assess scope**
   ```bash
   # Count affected tables
   docker compose exec memo-manager sqlite3 /app/data/memo_manager.db \
     "SELECT name FROM sqlite_master WHERE type='table';" | while read t; do
     echo "=== $t ===";
     docker compose exec memo-manager sqlite3 /app/data/memo_manager.db "PRAGMA integrity_check($t);"
   done
   ```

## Mitigation

**IMMEDIATE: Stop writes**
```bash
docker compose stop memo-manager
# Prevent further corruption
```

**DO NOT:**
- ❌ Run `VACUUM` on corrupted DB
- ❌ Try to `REINDEX`
- ❌ Copy corrupted file as "backup"

## Resolution

### Option 1: Restore from Backup (Preferred)
```bash
# 1. Find latest good backup
docker run --rm -v memo_manager_data:/data debian:bookworm-slim ls -lt /data/backups/

# 2. Restore
docker run --rm -v memo_manager_data:/data -v "$PWD":/out debian:bookworm-slim \
  sh -c 'cp /data/backups/<latest-good>.db /data/memo_manager.db && rm -f /data/memo_manager.db-wal /data/memo_manager.db-shm'

# 3. Verify
docker run --rm -v memo_manager_data:/data debian:bookworm-slim \
  sqlite3 /data/memo_manager.db "PRAGMA integrity_check;"

# 4. Restart
docker compose up -d memo-manager
```

### Option 2: Salvage Data (If no backup)
```bash
# Dump schema + data to SQL, recreate
docker run --rm -v memo_manager_data:/data debian:bookworm-slim \
  sqlite3 /data/memo_manager.db .dump > /tmp/salvage.sql

# Edit salvage.sql: remove corrupted rows, fix constraints
# Create fresh DB
docker run --rm -v memo_manager_data:/data debian:bookworm-slim \
  sqlite3 /data/memo_manager_new.db < /tmp/salvage.sql

# Verify + swap
docker run --rm -v memo_manager_data:/data debian:bookworm-slim \
  sqlite3 /data/memo_manager_new.db "PRAGMA integrity_check;"
# If ok: mv memo_manager_new.db memo_manager.db
```

## Escalation

- **Immediate**: Stop service, page database engineer
- **< 1 hour**: Restore from backup; verify data integrity
- **If no backup**: Salvage attempt; accept data loss; notify users

## Post-Incident

- [ ] Root cause: hardware? kernel? app bug? concurrent writers?
- [ ] Verify backup schedule & retention
- [ ] Add `PRAGMA integrity_check` to backup verification job
- [ ] Consider `PRAGMA journal_mode=WAL` + `PRAGMA synchronous=FULL` (already default)
- [ ] Document data loss scope & user communication