# Backend Dockerfile for standalone microservice deployment
FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/memo_manager.db \
    ATTACHMENTS_DIR=/app/data/attachments

# Audit M-13: attachments must live inside the /app/data volume. The default
# relative path (../data/attachments) resolved to /data/attachments outside
# the volume, losing uploads when the container was recreated.
RUN mkdir -p /app/data /app/data/attachments && chmod 755 /app/data /app/data/attachments

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Security (audit L-3): run as the unprivileged node user, not root.
RUN chown -R node:node /app
USER node

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]
