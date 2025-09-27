#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${DATABASE_URL:=file:${ROOT}/prisma/dev.db}"
: "${JWT_SECRET:=smoke-test-secret-1234567890!}"
: "${ADMIN_EMAIL:=admin@example.com}"
: "${ADMIN_PASSWORD:=ChangeMe123!}"
: "${SMOKE_EMAIL:=smoke-user@example.com}"
: "${SMOKE_DEVICE:=smoke-device}"
PORT="${PORT:-4100}"
BASE_URL="http://127.0.0.1:${PORT}"

export DATABASE_URL JWT_SECRET ADMIN_EMAIL ADMIN_PASSWORD PORT

SERVER_LOG="$(mktemp)"
cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && ps -p "${SERVER_PID}" >/dev/null 2>&1; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  if [[ "${1:-}" != "0" && -s "$SERVER_LOG" ]]; then
    echo "Server output:" >&2
    tail -n 40 "$SERVER_LOG" >&2
  fi
  rm -f "$SERVER_LOG"
}
trap 'cleanup $?' EXIT

echo "Building server..."
npm run build >/dev/null

echo "Starting server on port ${PORT}..."
node dist/index.js >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for attempt in {1..30}; do
  if curl -sS --fail "${BASE_URL}/health" >/dev/null; then
    echo "Server is ready."
    break
  fi
  sleep 1
  if [[ $attempt -eq 30 ]]; then
    echo "Server did not become ready in time." >&2
    exit 1
  fi
done

echo "Starting session for ${SMOKE_EMAIL}..."
SESSION_RES="$(curl -sS --fail -X POST "${BASE_URL}/api/sessions/start" \
  -H 'Content-Type: application/json' \
  --data-binary "$(SMOKE_EMAIL="$SMOKE_EMAIL" SMOKE_DEVICE="$SMOKE_DEVICE" node -e 'process.stdout.write(JSON.stringify({
    email: process.env.SMOKE_EMAIL,
    deviceId: process.env.SMOKE_DEVICE,
    platform: "smoke"
  }))')")"
SESSION_ID="$(printf '%s' "$SESSION_RES" | node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).sessionId")"
USER_ID="$(printf '%s' "$SESSION_RES" | node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).userId")"

echo "Posting heartbeat..."
curl -sS --fail -X POST "${BASE_URL}/api/events/heartbeat" \
  -H 'Content-Type: application/json' \
  --data-binary "$(SESSION_ID="$SESSION_ID" node -e 'process.stdout.write(JSON.stringify({
    sessionId: process.env.SESSION_ID,
    timestamp: new Date().toISOString(),
    activeMinute: true,
    idleFlag: false,
    keysCount: 4,
    mouseCount: 2,
    platform: "smoke"
  }))')" >/dev/null

echo "Authenticating admin..."
ADMIN_LOGIN="$(curl -sS --fail -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  --data-binary "$(node -e 'process.stdout.write(JSON.stringify({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD
  }))')")"
ADMIN_TOKEN="$(printf '%s' "$ADMIN_LOGIN" | node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).token")"

if [[ -z "$ADMIN_TOKEN" ]]; then
  echo "Failed to obtain admin token." >&2
  exit 1
fi

echo "Creating PTO request..."
PTO_PAYLOAD="$(USER_ID="$USER_ID" node -e 'const userId = Number(process.env.USER_ID); const now = Date.now(); process.stdout.write(JSON.stringify({
  userId,
  type: "pto",
  startDate: new Date(now).toISOString(),
  endDate: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
  hours: 2,
  reason: "Smoke test PTO"
}));')"
PTO_RES="$(curl -sS --fail -X POST "${BASE_URL}/api/time-requests" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  --data-binary "$PTO_PAYLOAD")"
REQUEST_ID="$(printf '%s' "$PTO_RES" | node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).request.id")"

echo "Approving PTO request ${REQUEST_ID}..."
curl -sS --fail -X POST "${BASE_URL}/api/time-requests/${REQUEST_ID}/approve" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  --data-binary '{}' >/dev/null

echo "Fetching balances..."
BALANCES="$(curl -sS --fail "${BASE_URL}/api/balances/${USER_ID}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}")"

printf '\nFinal balances for user %s:\n' "$USER_ID"
printf '%s\n' "$BALANCES" | node -e 'const data = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(JSON.stringify(data.balance, null, 2));'
