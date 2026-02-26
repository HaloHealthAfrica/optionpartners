#!/bin/sh

# Function to inject analytics script at runtime
inject_analytics() {
    if [ -n "$VITE_ANALYTICS_DOMAIN" ] && [ -n "$VITE_ANALYTICS_SITE_ID" ]; then
        # Validate analytics domain - must be HTTPS URL with valid hostname
        if ! echo "$VITE_ANALYTICS_DOMAIN" | grep -qE '^https://[a-zA-Z0-9.-]+$'; then
            echo "[ERROR] Invalid VITE_ANALYTICS_DOMAIN - must be HTTPS URL with valid hostname"
            return 1
        fi
        # Validate analytics site ID - must be alphanumeric (with hyphens/underscores)
        if ! echo "$VITE_ANALYTICS_SITE_ID" | grep -qE '^[a-zA-Z0-9_-]+$'; then
            echo "[ERROR] Invalid VITE_ANALYTICS_SITE_ID - must be alphanumeric"
            return 1
        fi

        echo "Injecting analytics script: $VITE_ANALYTICS_DOMAIN with site ID $VITE_ANALYTICS_SITE_ID"

        # Find all HTML files and inject analytics script
        find /usr/share/nginx/html -name "*.html" -type f | while read file; do
            if ! grep -q "data-site-id=\"$VITE_ANALYTICS_SITE_ID\"" "$file"; then
                sed -i "s|</head>|    <script src=\"$VITE_ANALYTICS_DOMAIN/api/script.js\" data-site-id=\"$VITE_ANALYTICS_SITE_ID\" defer></script>\n  </head>|g" "$file"
                echo "Analytics injected into $file"
            fi
        done
    else
        echo "Analytics not configured - VITE_ANALYTICS_DOMAIN or VITE_ANALYTICS_SITE_ID missing"
    fi
}

# Inject analytics script at startup
inject_analytics

# Wait for database to be ready (timeout after 30 seconds)
DB_HOST_VAL="${DB_HOST:-postgres}"
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

# Set environment variables for mobile support
export RUN_MIGRATIONS="${RUN_MIGRATIONS:-true}"

# Start backend (migrations will run automatically)
echo "[START] Starting TradeTally backend..."
cd /app/backend && node src/server.js &

# Wait for backend to start
sleep 5

# Start nginx
nginx -g "daemon off;"