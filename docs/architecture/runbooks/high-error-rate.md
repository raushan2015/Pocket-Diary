# Alert: HighErrorRate

**Severity:** Critical
**Source:** Prometheus: `rate(http_requests_total{status=~"5.."}[5m]) > 0.05` or `rate(http_requests_total{status=~"4.."}[5m]) > 0.1`
**Runbook:** This file

## Symptoms
- Elevated 5xx error rate in Grafana / Prometheus
- Users report "Something went wrong" toasts
- Sentry / error tracking shows spike
- API latency may also be elevated

## Diagnosis Steps

1. **Identify error pattern**
   ```bash
   docker compose logs memo-manager --since=10m | grep -E '"status":5[0-9]{2}' | head -20
   # Group by endpoint, error message
   ```

2. **Check specific endpoints**
   ```bash
   # Most common: /api/v1/memos, /api/v1/auth/*, /api/v1/attachments
   docker compose logs memo-manager --since=10m | jq -r 'select(.status >= 500) | "\(.url) \(.msg)"' | sort | uniq -c | sort -rn
   ```

3. **Check database**
   ```bash
   docker compose exec memo-manager sqlite3 /app/data/memo_manager.db "PRAGMA integrity_check;"
   # Also check: WAL file size, lock contention
   ls -lh /app/data/memo_manager.db*
   ```

4. **Check recent deployments**
   ```bash
   git log --oneline -10
   # Any schema changes? New routes? Config changes?
   ```

5. **Check external dependencies**
   - SMTP reachable? (email errors)
   - VAPID keys valid? (push errors)
   - Disk space? (`df -h /app/data`)

## Mitigation

| Error Type | Immediate Action |
|------------|------------------|
| 500 on all routes | Restart container: `docker compose restart memo-manager` |
| 500 on `/auth/*` | Check `COOKIE_SECRET`, session table; truncate expired sessions |
| 500 on `/memos` | Check SQLite locks; `PRAGMA busy_timeout=5000` |
| 500 on `/attachments` | Check disk space, permissions on `/app/data/attachments` |
| 503 / 429 spike | Check rate limit config; reduce `RATE_LIMIT_MAX` temporarily |
| 502 from proxy | Backend crashed; see [ServiceDown](./service-down.md) |

## Resolution

| Root Cause | Fix |
|------------|-----|
| Uncaught exception | Fix code; deploy patch |
| SQLite `SQLITE_BUSY` | Increase `busy_timeout`; check for long transactions |
| Migration partial | Complete migration manually; verify schema version |
| Config validation failure | Fix `.env`; restart |
| External service down | Circuit breaker; degrade gracefully (email→in-app) |

## Escalation

- **< 10 min**: On-call investigates; check Sentry for stack traces
- **< 30 min**: If unknown cause, rollback to last known-good image
- **< 1 hour**: Incident response; communicate degraded status

## Post-Incident

- [ ] Add specific alert for the error pattern
- [ ] Improve error handling / logging for the root cause
- [ ] Verify error budget not exhausted