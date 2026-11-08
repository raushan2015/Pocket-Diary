# Alert: BackupFailed

**Severity:** Critical
**Source:** Backup job logs / Prometheus `backup_last_success_timestamp` stale / Backup verification test fails
**Runbook:** This file

## Symptoms
- Backup job logs show error (permission denied, disk full, sqlite3 .backup fails)
- `BACKUP_REPLICATION_DIR` replication fails
- Backup age > 25 hours (default interval 24h)
- Account Settings → Backups shows "Never" or old timestamp
- CI backup verification test fails

## Diagnosis Steps

1. **Check backup job logs**
   ```bash
   docker compose logs memo-manager --since=2h | grep -i backup
   # Look for: "backup failed", "permission denied", "disk full", "sqlite3: not found"
   ```

2. **Check backup directory**
   ```bash
   docker compose exec memo-manager ls -la /app/data/backups/
   # Any recent .db files? Permissions ok?
   ```

3. **Check disk space**
   ```bash
   df -h /app/data
   # Available space > backup size?
   ```

4. **Check replication directory (if configured)**
   ```bash
   docker compose exec memo-manager ls -la /app/backup-replica/
   # Mount present? Writable?
   ```

5. **Test manual backup**
   ```bash
   docker compose exec memo-manager sqlite3 /app/data/memo_manager.db ".backup /app/data/backups/test-$(date +%s).db"
   echo $?
   # 0 = success
   ```

## Mitigation

| Issue | Action |
|-------|--------|
| Disk full | Clean old backups: `find /app/data/backups -mtime +7 -delete`; increase volume |
| Permission denied | `chown -R node:node /app/data/backups`; check volume mount ownership |
| Replication mount missing | Verify `BACKUP_REPLICATION_DIR` mount in compose; remount |
| sqlite3 not found | Image should have it; verify Dockerfile |
| DB locked | Retry; backup uses `.backup` which handles locks |

## Resolution

| Root Cause | Fix |
|------------|-----|
| Cron not running | Check container health; backup runs in main process |
| Config error | Verify `BACKUP_INTERVAL_HOURS`, `BACKUP_RETENTION` env vars |
| Volume not persistent | Ensure named volume `memo_manager_data` not recreated |
| Replication path | Fix mount; ensure network share (NFS/SMB) available |

## Escalation

- **< 1 hour**: On-call investigates; manual backup if automated fails
- **< 4 hours**: If no backup for >24h, escalate; data loss risk
- **< 24 hours**: Must have working backup; restore drill required

## Post-Incident

- [ ] Verify backup + replication both work
- [ ] Run restore drill in staging
- [ ] Update alert threshold (backup age > 25h → critical)
- [ ] Document any data loss window