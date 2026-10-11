#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Memo Manager - SQLite Backup Replication & Disaster Recovery Restore
# ==============================================================================

BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
REMOTE_DEST="${REMOTE_BACKUP_DEST:-}" # e.g. s3://my-bucket/backups or user@remote:/path
DB_PATH="${DATABASE_PATH:-/data/memo_manager.db}"

usage() {
  echo "Usage: $0 [options]"
  echo "  --sync              Verify and replicate latest local backup to off-host target"
  echo "  --restore <file>    Perform a verified database restore from specified snapshot"
  echo "  --verify <file>     Run SQLite PRAGMA integrity check on snapshot"
  exit 1
}

verify_snapshot() {
  local snapshot="$1"
  if [ ! -f "$snapshot" ]; then
    echo "Error: Snapshot file does not exist: $snapshot" >&2
    exit 1
  fi
  echo "Verifying snapshot integrity: $snapshot"
  if command -v sqlite3 >/dev/null 2>&1; then
    local check
    check=$(sqlite3 "$snapshot" "PRAGMA integrity_check;")
    if [ "$check" != "ok" ]; then
      echo "Error: Integrity check failed for $snapshot (result: $check)" >&2
      exit 1
    fi
    echo "✓ Integrity verified: ok"
  else
    echo "Notice: sqlite3 binary not found, checking file size and header..."
    local header
    header=$(head -c 16 "$snapshot" || true)
    if [[ "$header" != *"SQLite format 3"* ]]; then
      echo "Error: File is not a valid SQLite database header" >&2
      exit 1
    fi
    echo "✓ SQLite header verified"
  fi
}

sync_backups() {
  echo "Finding latest local backup in $BACKUP_DIR..."
  if [ ! -d "$BACKUP_DIR" ]; then
    echo "Backup directory $BACKUP_DIR does not exist." >&2
    exit 1
  fi

  local latest
  latest=$(find "$BACKUP_DIR" -name "memo-manager-*.db" -type f | sort -r | head -n 1)

  if [ -z "$latest" ]; then
    echo "No snapshots found in $BACKUP_DIR" >&2
    exit 1
  fi

  verify_snapshot "$latest"

  if [ -n "$REMOTE_DEST" ]; then
    echo "Replicating $latest to $REMOTE_DEST..."
    if [[ "$REMOTE_DEST" =~ ^s3:// ]]; then
      aws s3 cp "$latest" "$REMOTE_DEST/$(basename "$latest")"
    elif [[ "$REMOTE_DEST" =~ ^gs:// ]]; then
      gcloud storage cp "$latest" "$REMOTE_DEST/$(basename "$latest")"
    elif [[ "$REMOTE_DEST" =~ : ]]; then
      scp "$latest" "$REMOTE_DEST/"
    else
      mkdir -p "$REMOTE_DEST"
      cp -p "$latest" "$REMOTE_DEST/"
    fi
    echo "✓ Off-host replication completed successfully"
  else
    echo "Notice: REMOTE_BACKUP_DEST not configured. Local snapshot is verified."
  fi
}

restore_snapshot() {
  local snapshot="$1"
  verify_snapshot "$snapshot"

  echo "Restoring database from $snapshot..."
  echo "Target database path: $DB_PATH"

  local backup_curr="${DB_PATH}.pre-restore-$(date +%s)"
  if [ -f "$DB_PATH" ]; then
    echo "Preserving existing database to $backup_curr..."
    cp -p "$DB_PATH" "$backup_curr"
  fi

  # Safely replace database and remove stale WAL / SHM files
  cp -f "$snapshot" "${DB_PATH}.tmp"
  mv -f "${DB_PATH}.tmp" "$DB_PATH"
  rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"

  echo "✓ Database restored successfully. Verifying restored database..."
  verify_snapshot "$DB_PATH"
  echo "✓ Database restore and integrity check complete!"
}

case "${1:-}" in
  --sync)
    sync_backups
    ;;
  --verify)
    if [ -z "${2:-}" ]; then usage; fi
    verify_snapshot "$2"
    ;;
  --restore)
    if [ -z "${2:-}" ]; then usage; fi
    restore_snapshot "$2"
    ;;
  *)
    usage
    ;;
esac
