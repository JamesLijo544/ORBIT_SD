#!/bin/sh
set -e

mkdir -p /app/data/exports

if [ -n "$S3_BUCKET" ] && [ -n "$AWS_ACCESS_KEY_ID" ]; then
  echo "[Litestream] AWS S3 configuration detected."
  echo "[Litestream] Checking for existing replica in S3 bucket '${S3_BUCKET}'..."
  litestream restore -if-replica-exists -config /app/litestream.yml /app/data/orchestrator.sqlite || true

  echo "[Litestream] Starting application with continuous S3 replication..."
  exec litestream replicate -config /app/litestream.yml -exec "node dist/server.js"
else
  echo "[Litestream] AWS credentials not supplied. Running with local SQLite storage."
  exec node dist/server.js
fi
