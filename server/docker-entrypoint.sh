#!/bin/sh
set -eu

echo "[entrypoint] DATABASE_URL=${DATABASE_URL:-unset}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] ERROR: DATABASE_URL is not set" >&2
  exit 1
fi

echo "[entrypoint] Applying Prisma migrations..."
if npm run db:migrate; then
  echo "[entrypoint] prisma migrate deploy completed."
else
  echo "[entrypoint] prisma migrate deploy failed; attempting prisma db push..." >&2
  npm run db:push
fi

echo "[entrypoint] Starting attendance server..."
exec node dist/index.js
