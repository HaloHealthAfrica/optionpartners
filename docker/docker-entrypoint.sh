#!/bin/bash

# Docker entrypoint script for TradeTally backend
# This script ensures proper database initialization and migration

set -e

echo "[START] Starting TradeTally backend container..."

# Wait for database to be ready (timeout after 30 seconds)
DB_HOST_VAL="${DB_HOST:-localhost}"
DB_PORT_VAL="${DB_PORT:-5432}"
echo "[WAIT] Waiting for database at ${DB_HOST_VAL}:${DB_PORT_VAL}..."
DB_RETRIES=0
DB_MAX_RETRIES=15
DB_READY=false
while [ $DB_RETRIES -lt $DB_MAX_RETRIES ]; do
  if nc -z "$DB_HOST_VAL" "$DB_PORT_VAL" 2>/dev/null; then
    DB_READY=true
    break
  fi
  DB_RETRIES=$((DB_RETRIES + 1))
  echo "   Database not ready, attempt ${DB_RETRIES}/${DB_MAX_RETRIES}..."
  sleep 2
done

if [ "$DB_READY" = true ]; then
  echo "[OK] Database connection established"
else
  echo "[WARN] Database not reachable after ${DB_MAX_RETRIES} attempts — starting without DB"
fi

# Run database migrations
echo "[MIGRATE] Running database migrations..."
if [ "${RUN_MIGRATIONS:-true}" != "false" ]; then
  node src/utils/migrate.js
else
  echo "   Skipping migrations (RUN_MIGRATIONS=false)"
fi

# Set default environment variables
export NODE_ENV="${NODE_ENV:-production}"

echo "[CONFIG] Configuration:"
echo "   Environment: ${NODE_ENV}"
echo "   Database: ${DB_HOST:-localhost}:${DB_PORT:-5432}/${DB_NAME:-tradetally}"

# Start the application
echo "[START] Starting TradeTally application..."
exec "$@"