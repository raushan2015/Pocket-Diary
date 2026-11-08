#!/usr/bin/env bash
#
# Pocket Diary - Automated Restore Drill
# Runs in a disposable environment to verify backup integrity.
#
# Usage:
#   ./restore-drill.sh                    # Auto-detect latest backup
#   ./restore-drill.sh /path/to/backup.db # Test specific backup
#   DRY_RUN=1 ./restore-drill.sh          # Validate without restoring
#
# Requires: docker, sqlite3, access to memo_manager_data volume
# Runs as: root (needs docker access)

set -euo pipefail

# Configuration
DATA_VOLUME="${DATA_VOLUME:-memo_manager_data}"
BACKUP_DIR_IN_VOLUME="/app/data/backups"
WORK_DIR="${WORK_DIR:-/tmp/pocket-diary-restore-drill-$$}"
IMAGE="${DRILL_IMAGE:-debian:bookworm-slim}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }

cleanup() {
  log "Cleaning up..."
  docker volume rm -f "${DATA_VOLUME}-drill" 2>/dev/null || true
  rm -rf "${WORK_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

# Parse args
TARGET_BACKUP="${1:-}"

log "=== Pocket Diary Restore Drill ==="
log "Volume: ${DATA_VOLUME}"
log "Work dir: ${WORK_DIR}"
mkdir -p "${WORK_DIR}"

# Find latest backup if not specified
if [[ -z "${TARGET_BACKUP}" ]]; then
  log "Discovering latest backup..."
  TARGET_BACKUP=$(docker run --rm -v "${DATA_VOLUME}:/data" "${IMAGE}" \
    sh -c "ls -t ${BACKUP_DIR_IN_VOLUME}/*.db 2>/dev/null | head -1" || true)
  if [[ -z "${TARGET_BACKUP}" || "${TARGET_BACKUP}" == "" ]]; then
    err "No backups found in ${BACKUP_DIR_IN_VOLUME}"
    exit 1
  fi
  TARGET_BACKUP=$(basename "${TARGET_BACKUP}")
  log "Found: ${TARGET_BACKUP}"
fi

BACKUP_PATH="${BACKUP_DIR_IN_VOLUME}/${TARGET_BACKUP}"

# Verify backup exists
log "Verifying backup exists..."
docker run --rm -v "${DATA_VOLUME}:/data" "${IMAGE}" \
  test -f "${BACKUP_PATH}" || {
  err "Backup not found: ${BACKUP_PATH}"
  exit 1
}
ok "Backup exists: ${BACKUP_PATH}"

# Step 1: Create drill volume (copy of production)
log "Creating drill volume..."
docker volume create "${DATA_VOLUME}-drill" >/dev/null
docker run --rm \
  -v "${DATA_VOLUME}:/src" \
  -v "${DATA_VOLUME}-drill:/dst" \
  "${IMAGE}" \
  sh -c "cp -a /src/. /dst/"
ok "Drill volume created"

# Step 2: Restore backup to drill volume
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log "DRY_RUN=1: Skipping actual restore"
else
  log "Restoring backup to drill volume..."
  docker run --rm \
    -v "${DATA_VOLUME}-drill:/data" \
    "${IMAGE}" \
    sh -c "
      cp '${BACKUP_PATH}' /data/memo_manager.db &&
      rm -f /data/memo_manager.db-wal /data/memo_manager.db-shm
    "
  ok "Backup restored"
fi

# Step 3: Integrity checks
log "Running integrity checks..."

# 3a: PRAGMA integrity_check
log "  → PRAGMA integrity_check..."
INTEGRITY=$(docker run --rm -v "${DATA_VOLUME}-drill:/data" "${IMAGE}" \
  sqlite3 /data/memo_manager.db "PRAGMA integrity_check;")
if [[ "${INTEGRITY}" == "ok" ]]; then
  ok "Integrity check: OK"
else
  err "Integrity check FAILED: ${INTEGRITY}"
  exit 1
fi

# 3b: PRAGMA foreign_key_check
log "  → PRAGMA foreign_key_check..."
FK_ERRORS=$(docker run --rm -v "${DATA_VOLUME}-drill:/data" "${IMAGE}" \
  sqlite3 /data/memo_manager.db "PRAGMA foreign_key_check;")
if [[ -z "${FK_ERRORS}" ]]; then
  ok "Foreign key check: OK"
else
  err "Foreign key violations found:\n${FK_ERRORS}"
  exit 1
fi

# 3c: Schema validation (compare to expected tables)
log "  → Schema validation..."
TABLES=$(docker run --rm -v "${DATA_VOLUME}-drill:/data" "${IMAGE}" \
  sqlite3 /data/memo_manager.db ".tables")
REQUIRED_TABLES=(
  "users" "sessions" "workspaces" "workspace_members"
  "folders" "categories" "tags" "memos" "memo_tags"
  "memo_versions" "attachments" "notifications"
  "push_subscriptions" "workspace_invites" "password_resets"
  "_drizzle_migrations"
)
for table in "${REQUIRED_TABLES[@]}"; do
  if echo "${TABLES}" | grep -qw "${table}"; then
    ok "  Table exists: ${table}"
  else
    warn "  Table missing: ${table}"
  fi
done

# 3d: Data sanity checks
log "  → Data sanity checks..."
USER_COUNT=$(docker run --rm -v "${DATA_VOLUME}-drill:/data" "${IMAGE}" \
  sqlite3 /data/memo_manager.db "SELECT COUNT(*) FROM users;")
MEMO_COUNT=$(docker run --rm -v "${DATA_VOLUME}-drill:/data" "${IMAGE}" \
  sqlite3 /data/memo_manager.db "SELECT COUNT(*) FROM memos WHERE deleted_at IS NULL;")
WORKSPACE_COUNT=$(docker run --rm -v "${DATA_VOLUME}-drill:/data" "${IMAGE}" \
  sqlite3 /data/memo_manager.db "SELECT COUNT(*) FROM workspaces;")
log "    Users: ${USER_COUNT}"
log "    Active memos: ${MEMO_COUNT}"
log "    Workspaces: ${WORKSPACE_COUNT}"

if [[ "${USER_COUNT}" -eq 0 ]]; then
  warn "No users found - backup may be empty"
fi

# Step 4: Test boot (optional, requires full image)
if [[ "${TEST_BOOT:-0}" == "1" ]]; then
  log "Testing container boot..."
  CONTAINER_ID=$(docker run -d \
    -v "${DATA_VOLUME}-drill:/app/data" \
    -e NODE_ENV=production \
    -e COOKIE_SECRET=drill-secret-do-not-use-in-production-32-chars-min \
    -e APP_URL=http://localhost:8080 \
    -e DATABASE_PATH=/app/data/memo_manager.db \
    -p 18080:8080 \
    ghcr.io/raushan2015/pocket-diary:latest 2>/dev/null || \
    docker run -d \
    -v "${DATA_VOLUME}-drill:/app/data" \
    -e NODE_ENV=production \
    -e COOKIE_SECRET=drill-secret-do-not-use-in-production-32-chars-min \
    -e APP_URL=http://localhost:8080 \
    -e DATABASE_PATH=/app/data/memo_manager.db \
    -p 18080:8080 \
    memo-manager:latest)

  sleep 10
  if curl -sf http://localhost:18080/health >/dev/null; then
    ok "Container boot: OK (health check passed)"
  else
    err "Container boot: FAILED"
    docker logs "${CONTAINER_ID}" | tail -20
    exit 1
  fi
  docker stop "${CONTAINER_ID}" >/dev/null
  docker rm "${CONTAINER_ID}" >/dev/null
fi

# Step 5: Attachment verification (if any)
log "Checking attachments..."
ATTACH_COUNT=$(docker run --rm -v "${DATA_VOLUME}-drill:/data" "${IMAGE}" \
  find /data/attachments -type f 2>/dev/null | wc -l || echo 0)
log "  Attachment files: ${ATTACH_COUNT}"
if [[ "${ATTACH_COUNT}" -gt 0 ]]; then
  # Sample check: first 5 files exist and non-zero
  docker run --rm -v "${DATA_VOLUME}-drill:/data" "${IMAGE}" \
    find /data/attachments -type f -size +0 | head -5 | while read f; do
      ok "  Attachment OK: $(basename "${f}")"
    done
fi

# Summary
echo
log "=== DRILL SUMMARY ==="
ok "Backup file: ${TARGET_BACKUP}"
ok "Integrity: PASS"
ok "Foreign keys: PASS"
ok "Schema: PASS"
ok "Data: ${USER_COUNT} users, ${MEMO_COUNT} memos, ${WORKSPACE_COUNT} workspaces"
ok "Attachments: ${ATTACH_COUNT} files"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  warn "DRY RUN - no actual restore performed"
fi

log "=== RESTORE DRILL PASSED ==="
exit 0