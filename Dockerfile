# Stage 1: Build
FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies required for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig*.json ./
COPY frontend/ ./frontend/
COPY src/ ./src/

RUN npm ci

# Build both backend (dist) and frontend (frontend-dist)
RUN npm run build:app

# Prune devDependencies for lean production
RUN npm prune --omit=dev

# Stage 2: Production Runtime
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/orchestrator.sqlite

# Install CA certificates to enable secure communication with AWS S3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Litestream for live SQLite replication to AWS S3
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tar.gz
RUN tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz && rm /tmp/litestream.tar.gz

RUN mkdir -p /app/data/exports

COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/frontend-dist ./frontend-dist

COPY data/ ./data/
COPY litestream.yml /app/litestream.yml
COPY run.sh /app/run.sh
RUN chmod +x /app/run.sh

EXPOSE 3000

VOLUME ["/app/data"]

CMD ["/app/run.sh"]
