# Alert: ServiceDown

**Severity:** Critical
**Source:** Health check failure (`/health` endpoint) / Container restart loop
**Runbook:** This file

## Symptoms
- Health check returns non-200 or times out
- Container shows `unhealthy` in `docker compose ps`
- Users report "Cannot connect" / "Site unavailable"
- PagerDuty / alertmanager fires `ServiceDown`

## Diagnosis Steps

1. **Check container status**
   ```bash
   docker compose ps
   # Look for: Restarting, Unhealthy, Exit codes
   ```

2. **Check recent logs**
   ```bash
   docker compose logs --tail=200 memo-manager
   # Look for: PANIC, FATAL, uncaughtException, EADDRINUSE, SQLITE_BUSY
   ```

3. **Check resource usage**
   ```bash
   docker stats memo-manager-app --no-stream
   # CPU > 90%? Memory > limit? Disk full?
   ```

4. **Check database accessibility**
   ```bash
   docker compose exec memo-manager sqlite3 /app/data/memo_manager.db "PRAGMA integrity_check;"
   # Should return "ok"
   ```

5. **Check port binding**
   ```bash
   curl -v http://127.0.0.1:8080/health
   # Connection refused? Timeout? 502?
   ```

## Mitigation

| Scenario | Action |
|----------|--------|
| Container restarting (OOM) | Increase memory limit in `docker-compose.yml` |
| Port conflict | Check `PORT` env var; ensure no other process on 8080 |
| Database locked | `docker compose restart memo-manager` (releases WAL locks) |
| Config error | Verify `.env` has `COOKIE_SECRET`, `APP_URL`; check logs for startup errors |
| Migration stuck | See [MigrationFailed](./migration-failed.md) |

## Resolution

| Root Cause | Fix |
|------------|-----|
| OOM | Optimize queries; increase memory; add swap |
| SQLite corruption | Restore from backup (see [BackupFailed](./backup-failed.md)) |
| Schema migration error | Rollback to previous image; run migration manually |
| Env var missing | Add required vars to `.env`; restart |
| Dependency failure (SMTP, etc.) | Make optional services non-blocking; degrade gracefully |

## Escalation

- **< 5 min**: On-call engineer investigates
- **< 15 min**: Escalate to team lead; consider rolling back to previous image
- **< 30 min**: Incident commander; communicate status to users
- **> 30 min**: Full incident response; consider maintenance page

## Post-Incident

- [ ] Root cause analysis within 48h
- [ ] Add/improve alert to catch earlier
- [ ] Update runbook with new findings
- [ ] Verify backup/restore still works