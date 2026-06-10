#!/usr/bin/env bash
# E2e harness orchestrator (catalog-sql-search 4.3): disposable Postgres in
# docker, migrations + e2e seed, api + vite dev servers, playwright spec,
# teardown. Requires docker + the playwright chromium browser.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_NAME="e2e-pg-$$"
PG_PORT="${E2E_PG_PORT:-55460}"
API_PORT="${E2E_API_PORT:-4000}"
WEB_PORT="${E2E_WEB_PORT:-5173}"
export DATABASE_URL="postgresql://postgres:test@localhost:${PG_PORT}/outreach"
export REDIS_URL="${E2E_REDIS_URL:-redis://localhost:6379/15}"
export JWT_SECRET="e2e-jwt-secret-0123456789"
export ENCRYPTION_KEY="e2e-encryption-key"
export API_PORT WEB_PORT
export E2E_API_URL="http://localhost:${API_PORT}"
export E2E_WEB_URL="http://localhost:${WEB_PORT}"
export LOG_LEVEL=warn

API_PID=""
WEB_PID=""
cleanup() {
  # Kill the whole process GROUPS — npx/tsx/vite spawn children that would
  # otherwise survive the subshell and hold ports/pipes open.
  [ -n "$API_PID" ] && kill -- "-$API_PID" 2>/dev/null || true
  [ -n "$WEB_PID" ] && kill -- "-$WEB_PID" 2>/dev/null || true
  docker stop "$PG_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[e2e] starting postgres (${PG_NAME} on :${PG_PORT})…"
docker run -d --rm --name "$PG_NAME" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=outreach \
  -p "127.0.0.1:${PG_PORT}:5432" postgres:16-alpine >/dev/null
for i in $(seq 1 30); do
  docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

echo "[e2e] migrate + seed…"
(cd packages/db && npx prisma migrate deploy --schema=./prisma/schema.prisma >/dev/null)
(cd packages/db && npx tsx ../../e2e/seed-e2e.ts)

echo "[e2e] starting api on :${API_PORT}…"
setsid bash -c 'cd apps/api && exec npx tsx src/index.ts' &
API_PID=$!

echo "[e2e] starting web on :${WEB_PORT}…"
setsid bash -c "cd apps/web && exec npx vite --port $WEB_PORT --strictPort" &
WEB_PID=$!

for i in $(seq 1 60); do
  curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1 && api_up=1 || api_up=0
  curl -fsS "http://localhost:${WEB_PORT}" >/dev/null 2>&1 && web_up=1 || web_up=0
  [ "$api_up" = 1 ] && [ "$web_up" = 1 ] && break
  sleep 1
done
[ "${api_up:-0}" = 1 ] || { echo "[e2e] api failed to start"; exit 1; }
[ "${web_up:-0}" = 1 ] || { echo "[e2e] web failed to start"; exit 1; }

echo "[e2e] running playwright…"
npx playwright test --config e2e/playwright.config.ts "$@"
