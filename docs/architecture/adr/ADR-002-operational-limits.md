# ADR 002: Operational Limits & Single-Instance Architecture

**Status:** Accepted
**Date:** 2024-01-15
**Deciders:** Backend Team
**Technical Story:** Deployment model definition

## Context

Self-hosted applications face a tension between operational simplicity and scalability. Pocket Diary targets personal users and small teams (1-50 users). The deployment model must be simple enough for a hobbyist to run on a $5 VPS or home server.

## Decision

**Single active instance architecture**: The application runs as exactly one container. No horizontal scaling (multiple replicas) is supported. Scale vertically (more CPU/RAM) or migrate to PostgreSQL (future, see ADR-001).

## Consequences

### Positive
- **Dramatically simpler operations**: One container, one data volume, one backup target
- **No distributed systems complexity**: No leader election, no split-brain, no consensus
- **SQLite WAL works correctly**: No cross-node locking issues
- **Attachments on local FS**: No object storage configuration needed
- **Predictable resource usage**: Easy to right-size VM

### Negative
- **Single point of failure**: Container crash = downtime (mitigated by restart policy + fast boot)
- **No rolling deploys**: Deploy = brief downtime (seconds)
- **Hard ceiling on concurrency**: ~50-100 concurrent users before SQLite contention
- **No HA**: If host dies, service is down until manual intervention or orchestrator reschedules

### Neutral
- **Backup/restore IS the HA strategy**: RPO = backup interval (default 24h), RTO = container restart + DB restore (~30s)
- **Docker restart policy** (`unless-stopped`) handles most failures automatically
- **Migration path documented**: Swap Drizzle adapter → PostgreSQL, move attachments → S3/MinIO, run multiple replicas behind LB

## Implementation Notes

- `docker-compose.yml` defines single `memo-manager` service
- `restart: unless-stopped` for automatic recovery
- Health check on `/health` endpoint (proxied to backend)
- Named volume `memo_manager_data` for persistence
- `BACKUP_REPLICATION_DIR` for off-host snapshot replication
- **Do not** use `deploy.replicas` > 1 in Compose/Swarm/K8s with shared volume

## Alternatives Considered

| Alternative | Pros | Cons | Why Not Chosen |
|-------------|------|------|----------------|
| Multi-replica with shared SQLite | Horizontal read scaling | SQLite locking kills performance; data corruption risk | Fundamentally incompatible with SQLite |
| Multi-replica with PostgreSQL | True HA, horizontal scaling | External DB dependency, complex deployment | Violates zero-config self-hosted principle |
| Active-passive with shared volume | Fast failover | Still single-writer; failover complexity | Doesn't solve write scaling; adds complexity |
| Read replicas (async) | Read scaling | Eventual consistency; complex sync | Over-engineering for target scale |

## References

- [ADR-001: SQLite as Primary Database](./ADR-001-sqlite-primary-db.md)
- [Docker Compose](./docker-compose.yml)
- [Backup & Restore Documentation](../guides/backup-restore.md)