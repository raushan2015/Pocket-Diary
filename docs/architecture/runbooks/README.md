# Runbooks

Operational runbooks for Pocket Diary alerts. Each runbook follows the format:

```
## Alert: <Alert Name>
**Severity:** Critical | Warning | Info
**Source:** Prometheus alert rule / Log pattern / Health check
**Runbook:** <This file>

### Symptoms
- What the operator sees (dashboard, pager, log line)

### Diagnosis Steps
1. Step 1
2. Step 2

### Mitigation
- Immediate actions to reduce impact

### Resolution
- Root cause fix

### Escalation
- Who to contact if unresolved in X minutes
```

---

## Index

| Alert | Severity | Runbook |
|-------|----------|---------|
| `ServiceDown` | Critical | [service-down.md](./service-down.md) |
| `HighErrorRate` | Critical | [high-error-rate.md](./high-error-rate.md) |
| `DatabaseCorruption` | Critical | [database-corruption.md](./database-corruption.md) |
| `BackupFailed` | Critical | [backup-failed.md](./backup-failed.md) |
| `DiskSpaceCritical` | Critical | [disk-space-critical.md](./disk-space-critical.md) |
| `AuthFailureSpike` | Warning | [auth-failure-spike.md](./auth-failure-spike.md) |
| `SyncFailureRateHigh` | Warning | [sync-failure-rate.md](./sync-failure-rate.md) |
| `ReminderDeliveryFailed` | Warning | [reminder-delivery-failed.md](./reminder-delivery-failed.md) |
| `AttachmentUploadFailed` | Warning | [attachment-upload-failed.md](./attachment-upload-failed.md) |
| `MigrationFailed` | Critical | [migration-failed.md](./migration-failed.md) |

---

## Common Procedures

### Accessing the Container
```bash
# Production
docker exec -it memo-manager-app sh

# Or via compose
docker compose exec memo-manager sh
```

### Checking Logs
```bash
# Follow logs
docker compose logs -f memo-manager

# Last 100 lines
docker compose logs --tail=100 memo-manager

# Filter by level
docker compose logs memo-manager 2>&1 | grep -i error
```

### Database Access
```bash
# SQLite CLI
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db

# Or copy out for analysis
docker run --rm -v memo_manager_data:/data -v "$PWD":/out debian:bookworm-slim \
  cp /data/memo_manager.db /out/debug.db
```

### Health Check
```bash
curl -f http://localhost:8080/health
# Returns: {"status":"ok","timestamp":1234567890}
```

### Manual Backup
```bash
docker compose exec memo-manager sqlite3 /app/data/memo_manager.db ".backup /app/data/backups/manual-$(date +%s).db"
```

### Restart Service
```bash
docker compose restart memo-manager
```