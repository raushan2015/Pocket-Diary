# Multi-stage production Dockerfile for Pocket Diary SaaS
# TECHSHAN AI Office — High performance, unified deployment

# ----------------------------------------------------
# Stage 1: Build backend TypeScript
# ----------------------------------------------------
FROM node:24.22.1-bookworm-slim AS backend-builder
WORKDIR /build/backend

# Install build dependencies for native better-sqlite3 compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci

COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build
RUN npm prune --omit=dev

# ----------------------------------------------------
# Stage 1b: Build frontend with Vite
# ----------------------------------------------------
FROM node:24.22.1-bookworm-slim AS frontend-builder
WORKDIR /build/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/vite.config.ts ./
COPY frontend/index.html ./
COPY frontend/design-tokens.json ./
COPY frontend/scripts ./scripts
COPY frontend/css ./css
COPY frontend/js ./js
COPY frontend/icons ./icons
COPY frontend/manifest.json ./
COPY frontend/sw.js ./
COPY frontend/server.js ./

RUN npm run build

# Copy server.js to the dist folder for production
RUN cp server.js dist/

# ----------------------------------------------------
# Stage 2: Final runtime container
# ----------------------------------------------------
FROM node:24.22.1-bookworm-slim AS runner

LABEL maintainer="TECHSHAN AI Office"
LABEL application="Pocket Diary SaaS"
LABEL version="1.0.0"

WORKDIR /app

# Install runtime utilities (curl for health checks, python3 for PTY OAuth bridge)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install Antigravity CLI (`agy`) system-wide for Google Subscription AI chat
RUN HOME=/tmp/agy-install-home bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin' \
    && rm -rf /tmp/agy-install-home \
    && chmod 755 /usr/local/bin/agy

ENV NODE_ENV=production \
    PORT=8080 \
    BACKEND_PORT=3000 \
    DATABASE_PATH=/app/data/memo_manager.db \
    ATTACHMENTS_DIR=/app/data/attachments

# Ensure persistent data directory exists (audit M-13: ATTACHMENTS_DIR must
# point INSIDE the /app/data volume — the default relative path previously
# resolved to /data/attachments outside it, silently losing uploads when
# the container was recreated)
RUN mkdir -p /app/data /app/data/attachments /app/data/agy-homes /app/data/agy-sandbox \
    && chmod 755 /app/data /app/data/attachments /app/data/agy-homes /app/data/agy-sandbox

# Copy backend distribution and production node_modules
COPY --from=backend-builder /build/backend/dist /app/backend/dist
COPY --from=backend-builder /build/backend/node_modules /app/backend/node_modules
COPY backend/package.json /app/backend/package.json

# Copy built frontend from frontend-builder
COPY --from=frontend-builder /build/frontend/dist /app/frontend

# Copy entrypoint orchestration script
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Security (audit L-3): the container runs as the unprivileged `node` user
# instead of root. Data directories are chowned so the named volume
# initializes with the right ownership.
RUN chown -R node:node /app/data /app/frontend /app/backend /app/docker-entrypoint.sh
USER node

# Expose unified public application port
EXPOSE 8080

# Persistent volume for SQLite database and WAL files
VOLUME ["/app/data"]

# Health check probing frontend proxy to backend /health
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
