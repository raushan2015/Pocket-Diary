# Frontend Dockerfile for standalone microservice deployment
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV FRONTEND_PORT=5000 \
    BACKEND_URL=http://backend:3000

COPY . .

EXPOSE 5000

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD curl -f http://127.0.0.1:5000/health || exit 1

CMD ["node", "server.js"]
