# Alert: DiskSpaceCritical

**Severity:** Critical
**Source:** `df -h` on data volume > 90% used / Prometheus `disk_usage_percent > 90`
**Runbook:** This file

## Symptoms
- `docker compose exec memo-manager df -h /app/data` shows >90% used
- New attachment uploads fail with "No space left on device"
- SQLite writes fail: `SQLITE_FULL`
- Container may crash / become unresponsive

## Diagnosis Steps

1. **Check disk usage breakdown**
   ```bash
   docker compose exec memo-manager du -sh /app/data/*
   # Typical: memo_manager.db, backups/, attachments/, memo_manager.db-wal
   ```

2. **Identify largest consumers**
   ```bash
   docker compose exec memo-manager find /app/data -type f -size +10M -ls
   ```

3. **Check backup retention**
   ```bash
   docker compose exec memo-manager ls -la /app/data/backups/
   # Too many? Retention not working?
   ```

4. **Check attachment storage**
   ```bash
   docker compose exec memo-manager du -sh /app/data/attachments/
   # Large uploads? Orphaned files?
   ```

5. **Check WAL file size**
   ```bash
   ls -lh /app/data/memo_manager.db*
   # -wal > 100MB indicates long-running transaction or checkpoint issue
   ```

## Mitigation

| Issue | Immediate Action |
|-------|------------------|
| Backups piling up | `docker compose exec memo-manager find /app/data/backups -mtime +7 -delete` |
| Attachments large | Identify large files; consider user quota enforcement |
| WAL file huge | `docker compose restart memo-manager` (triggers checkpoint) |
| Logs filling disk | Docker log driver: `json-file` with `max-size: 10m, max-file: 3` |
| Volume full | Expand volume (cloud) or add disk (VM); then resize FS |

## Resolution

| Root Cause | Fix |
|------------|-----|
| Backup retention not enforced | Fix backup job: `BACKUP_RETENTION=7`; add cleanup |
| No attachment quota | Implement per-workspace quota (`STORAGE_QUOTA_GB`) |
| Long transactions | Review code for missing `commit`; add timeouts |
| Docker logs | Configure log rotation in `docker-compose.yml` |
| Database bloat | `VACUUM` after large deletes (run during maintenance) |

## Escalation

- **< 30 min**: On-call frees space; restarts service
- **< 2 hours**: If recurring, expand volume permanently
- **< 24 hours**: Implement quota enforcement; alert at 70%

## Post-Incident

- [ ] Add disk usage alert at 70% (warning), 85% (critical)
- [ ] Implement attachment quota enforcement
- [ ] Verify backup cleanup runs
- [ ] Document volume expansion procedure