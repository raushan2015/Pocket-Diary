#!/usr/bin/env bash
set -e

# Memo Manager SaaS Container Entrypoint
# TECHSHAN AI Office — Orchestrates unified backend and frontend reverse proxy

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${APP_DIR}/backend"
FRONTEND_DIR="${APP_DIR}/frontend"

# Network configuration
export BACKEND_PORT="${BACKEND_PORT:-3000}"
export BACKEND_HOST="127.0.0.1"
export PORT="${PORT:-8080}"
export FRONTEND_PORT="${FRONTEND_PORT:-$PORT}"
export BACKEND_URL="http://${BACKEND_HOST}:${BACKEND_PORT}"
export DATABASE_PATH="${DATABASE_PATH:-${APP_DIR}/data/memo_manager.db}"
export ATTACHMENTS_DIR="${ATTACHMENTS_DIR:-${APP_DIR}/data/attachments}"
mkdir -p "${ATTACHMENTS_DIR}"
export NODE_ENV="${NODE_ENV:-production}"

echo "========================================================"
echo " Starting Memo Manager SaaS Application"
echo " Environment: ${NODE_ENV}"
echo " Frontend / Public Port: ${FRONTEND_PORT}"
echo " Backend Internal Port:  ${BACKEND_PORT}"
echo " Database Path:          ${DATABASE_PATH}"
echo "========================================================"

# Ensure database directory exists
mkdir -p "$(dirname "${DATABASE_PATH}")"

# Graceful termination handler
cleanup() {
  echo ""
  echo "Received shutdown signal. Stopping Memo Manager services..."
  if [ -n "${FRONTEND_PID}" ]; then
    kill -TERM "${FRONTEND_PID}" 2>/dev/null || true
  fi
  if [ -n "${BACKEND_PID}" ]; then
    kill -TERM "${BACKEND_PID}" 2>/dev/null || true
  fi
  wait
  echo "Memo Manager services terminated cleanly."
}

# Graceful shutdown on signals: children are stopped and the container exits 0.
# A crashing child is handled separately in the main flow below (audit L-14).
trap 'cleanup; exit 0' SIGTERM SIGINT

# 1. Start Backend Fastify service
echo "Starting Memo Manager Backend service on ${BACKEND_HOST}:${BACKEND_PORT}..."
(
  cd "${BACKEND_DIR}"
  export PORT="${BACKEND_PORT}"
  export HOST="${BACKEND_HOST}"
  if [ "${NODE_ENV}" = "development" ]; then
    echo "Running backend in development mode with live watch..."
    exec node --watch dist/index.js
  else
    exec node dist/index.js
  fi
) &
BACKEND_PID=$!

# Wait for backend readiness via /health probe
echo "Waiting for backend service to become ready..."
MAX_RETRIES=30
RETRIES=0
READY=0

while [ ${RETRIES} -lt ${MAX_RETRIES} ]; do
  if node -e "fetch('http://${BACKEND_HOST}:${BACKEND_PORT}/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 0.5
  RETRIES=$((RETRIES + 1))
done

if [ ${READY} -ne 1 ]; then
  echo "Error: Backend service failed to become ready within 15 seconds."
  kill -TERM "${BACKEND_PID}" 2>/dev/null || true
  exit 1
fi

echo "Backend is ready and responding at http://${BACKEND_HOST}:${BACKEND_PORT}/health"

# 2. Start Frontend reverse proxy service
echo "Starting Memo Manager Frontend service on 0.0.0.0:${FRONTEND_PORT} (proxying to ${BACKEND_URL})..."
(
  cd "${FRONTEND_DIR}"
  export FRONTEND_PORT="${FRONTEND_PORT}"
  export BACKEND_URL="${BACKEND_URL}"
  exec node server.js
) &
FRONTEND_PID=$!

echo "========================================================"
echo " Memo Manager SaaS is running successfully!"
echo " Public URL:   http://0.0.0.0:${FRONTEND_PORT}/"
echo " Health Check: http://0.0.0.0:${FRONTEND_PORT}/health"
echo " API Endpoint: http://0.0.0.0:${FRONTEND_PORT}/api/v1"
echo "========================================================"

# Wait for either child process to exit (audit L-14). The previous handler
# always exited 0, hiding crashes from Docker/orchestrator restart policies
# and letting a crash-looping container look "successful".
EXIT_CODE=0
set +e
wait -n "${BACKEND_PID}" "${FRONTEND_PID}"; EXIT_CODE=$?
set -e
if [ "${EXIT_CODE}" -ne 0 ]; then
  echo "A Memo Manager service exited unexpectedly with code ${EXIT_CODE}."
fi
cleanup
if [ "${EXIT_CODE}" -ne 0 ]; then
  echo "Memo Manager shutting down with exit code ${EXIT_CODE}."
  exit "${EXIT_CODE}"
fi
