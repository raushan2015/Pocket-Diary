# Backup, Replication & Disaster Recovery Guide

## Architecture Overview
Pocket Diary utilizes an embedded SQLite database running in Write-Ahead Logging (`WAL`) mode with automatic online backups managed by `backend/src/services/backup.service.ts`.

1. **Automated Online Snapshots**: Every 24 hours (configurable via `BACKUP_INTERVAL_HOURS`), a live snapshot is taken using SQLite's native backup API into `BACKUP_DIR` (`/data/backups`).
2. **Snapshot Retention**: The newest 7 snapshots (configurable via `BACKUP_RETENTION`) are retained locally; older snapshots are safely rotated.
3. **Off-Host Replication**: Snapshots can be mirrored off-host via `backend/scripts/backup-sync.sh --sync` targeting Amazon S3, Google Cloud Storage, or SSH/rsync targets.

---

## Remote Backup Replication Setup
Set the `REMOTE_BACKUP_DEST` environment variable:
```bash
# Example for AWS S3
export REMOTE_BACKUP_DEST="s3://my-backup-bucket/memo-manager"

# Example for Google Cloud Storage
export REMOTE_BACKUP_DEST="gs://my-backup-bucket/memo-manager"

# Example for remote SSH server
export REMOTE_BACKUP_DEST="backupuser@backup.internal:/var/backups/notes"
```
Run replication manually or via cron:
```bash
./backend/scripts/backup-sync.sh --sync
```

---

## Verifying Snapshot Integrity
Before applying a restore, verify the snapshot's SQLite B-tree structure:
```bash
./backend/scripts/backup-sync.sh --verify /data/backups/memo-manager-2026-10-11T12-00-00-000Z-abcd1234.db
```

---

## Disaster Recovery Restore Procedure

To restore a snapshot:
1. Stop the application service or Docker container:
   ```bash
   docker compose stop backend
   ```
2. Execute the restore script with the target snapshot file:
   ```bash
   ./backend/scripts/backup-sync.sh --restore /data/backups/memo-manager-2026-10-11T12-00-00-000Z-abcd1234.db
   ```
   *The script creates a pre-restore safety copy of the current database, performs an atomic copy of the snapshot, removes stale `-wal` and `-shm` index files, and verifies database integrity with `PRAGMA integrity_check`.*
3. Restart the service:
   ```bash
   docker compose start backend
   ```
4. Verify application health:
   ```bash
   curl -f http://127.0.0.1:8080/health
   ```
