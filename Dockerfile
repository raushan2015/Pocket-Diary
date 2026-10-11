# Multi-stage production Dockerfile for Memo Manager SaaS
# TECHSHAN AI Office — High performance, unified deployment

# ----------------------------------------------------
# Stage 1: Build backend TypeScript
# ----------------------------------------------------
FROM node:22-bookworm-slim AS backend-builder
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
# Stage 2: Final runtime container
# ----------------------------------------------------
FROM node:22-bookworm-slim AS runner

LABEL maintainer="TECHSHAN AI Office"
LABEL application="Memo Manager SaaS"
LABEL version="1.0.0"

WORKDIR /app

# Install runtime utilities (curl for container health checks)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    BACKEND_PORT=3000 \
    DATABASE_PATH=/app/data/memo_manager.db

# Ensure persistent data directory exists
RUN mkdir -p /app/data /app/data/attachments && chmod 755 /app/data /app/data/attachments

# Copy backend distribution and production node_modules
COPY --from=backend-builder /build/backend/dist /app/backend/dist
COPY --from=backend-builder /build/backend/node_modules /app/backend/node_modules
COPY backend/package.json /app/backend/package.json

# Copy frontend assets and proxy server
COPY frontend /app/frontend

# Copy entrypoint orchestration script
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Expose unified public application port
EXPOSE 8080

# Persistent volume for SQLite database and WAL files
VOLUME ["/app/data"]

# Health check probing frontend proxy to backend /health
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
