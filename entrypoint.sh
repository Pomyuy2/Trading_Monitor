#!/bin/bash
set -e

echo "[init] Setting up data directory..."
mkdir -p /app/server/data

echo "[init] Deploying Prisma migrations..."
cd /app/server
pnpm prisma migrate deploy
pnpm prisma generate

echo "[init] Starting internal Caddy reverse proxy..."
caddy run --config /app/Caddyfile &
CADDY_PID=$!

echo "[init] Starting Fastify API server on port 4000..."
cd /app/server
pnpm start &
SERVER_PID=$!

echo "[init] Starting Next.js Web on port 3000..."
cd /app/web
pnpm start &
WEB_PID=$!

shutdown() {
  echo "[shutdown] Stopping all services..."
  kill -TERM "$CADDY_PID" "$SERVER_PID" "$WEB_PID" 2>/dev/null || true
  wait
  exit 0
}

trap shutdown SIGINT SIGTERM

echo "[init] All services started. Monitoring processes..."
wait -n "$CADDY_PID" "$SERVER_PID" "$WEB_PID"
EXIT_STATUS=$?
echo "[exit] A service exited with code $EXIT_STATUS. Shutting down container..."
kill -TERM "$CADDY_PID" "$SERVER_PID" "$WEB_PID" 2>/dev/null || true
exit $EXIT_STATUS
