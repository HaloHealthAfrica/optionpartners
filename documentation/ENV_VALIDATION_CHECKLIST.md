# Environment Variables Validation Checklist

Use this checklist to validate all required and optional environment variables for the TradePartners / optionpartners app.

---

## SIM_DEFAULT_USER_ID — When to Use

**Use `SIM_DEFAULT_USER_ID` when:**

- Webhooks arrive **without authentication** (no JWT, no API key)
- Webhooks have **no `user_id`** in the database (legacy/marketplaybook schema, or replay)
- You want **one designated user** to own all unassigned sim trades and signals

**Value:** A valid UUID of an existing user in the `users` table.

**How to get it:**
```sql
SELECT id FROM users ORDER BY created_at ASC LIMIT 1;
```
Or from the app: Settings → Profile, or via API.

**If not set:**
- **Production:** Unauthenticated webhooks are **rejected**
- **Development:** Falls back to the first registered user (may be unintended in shared DBs)

**Recommendation:** Always set `SIM_DEFAULT_USER_ID` in production if you ingest webhooks without auth or with legacy schemas.

---

## Required (Core)

| Variable | Purpose | Validation |
|----------|---------|------------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:port/dbname?sslmode=require` for Fly |
| `JWT_SECRET` | Signing key for auth tokens | Non-empty, strong random string |
| `NODE_ENV` | Environment mode | `production` for deploy |
| `PORT` | Backend port | `3000` (matches fly.toml) |
| `TRADING_MODE` | Trading mode | Must be `SIM` |

---

## Required (Sim / Webhook Pipeline)

| Variable | Purpose | Validation |
|----------|---------|------------|
| `ENABLE_WEBHOOK_PROCESSOR` | Start webhook polling loop | `true` to process webhooks |
| `SIM_DEFAULT_USER_ID` | User for unassigned webhooks | Valid UUID from `users.id` (see above) |

---

## Data Service (optionpartners-data)

| Variable | Purpose | Validation |
|----------|---------|------------|
| `DATA_SERVICE_URL` | Data-service base URL | `https://optionpartners-data.fly.dev` |
| `DATA_SERVICE_API_KEY` | API key for data-service | Must match data-service `API_KEY` secret |

---

## Webhook & Sim (Optional Tuning)

| Variable | Purpose | Default |
|----------|---------|---------|
| `WEBHOOK_SECRET` | HMAC verification for TradingView | Optional; records validity only |
| `WEBHOOK_PROCESSOR_INTERVAL` | Poll interval (ms) | `5000` |
| `ENABLE_WEBHOOK_METRICS` | Webhook processing metrics | `true` unless `false` |
| `SIM_INITIAL_BALANCE` | Starting sim balance | `100000` |
| `SIM_MAX_DAILY_LOSS` | Daily loss limit | `2000` |
| `SIM_MAX_RISK_PER_TRADE` | Max risk per trade | `500` |
| `SIM_SLIPPAGE_PCT` | Slippage simulation | `0.001` |
| `SIM_COMMISSION` | Per-contract commission | `0.65` |
| `SIM_STATE_TTL_MS` | Chain/state TTL (ms) | `1800000` (30 min) |
| `SIM_REQUIRE_CHAIN_DATA` | Require chain for execution | `true` |
| `SUPPRESSED_STRATEGIES` | Comma list to block | `SIGNALS,squeeze_pro` (or empty) |
| `WEBHOOK_RETENTION_DAYS` | Webhook cleanup retention | `30` |

---

## Frontend / CORS

| Variable | Purpose | Validation |
|----------|---------|------------|
| `FRONTEND_URL` | Primary frontend URL | `https://optionpartners.fly.dev` |
| `CORS_ORIGINS` | Additional CORS origins | Comma-separated if needed |

---

## Email (Optional)

| Variable | Purpose | Validation |
|----------|---------|------------|
| `EMAIL_HOST` | SMTP host | e.g. `smtp.gmail.com` |
| `EMAIL_PORT` | SMTP port | `587` |
| `EMAIL_USER` | SMTP username | |
| `EMAIL_PASS` | SMTP password | |
| `EMAIL_FROM` | From address | `noreply@...` |

---

## Billing (Optional)

| Variable | Purpose | Validation |
|----------|---------|------------|
| `BILLING_ENABLED` | Enable Stripe billing | `false` for self-hosted |
| `STRIPE_SECRET_KEY` | Stripe secret key | Required if billing enabled |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key | |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook secret | |

---

## External APIs (Optional)

| Variable | Purpose | Validation |
|----------|---------|------------|
| `FINNHUB_API_KEY` | Quotes, CUSIP resolution | Free key at finnhub.io |
| `ALPHA_VANTAGE_API_KEY` | Chart data | Free key at alphavantage.co |
| `OPENFIGI_API_KEY` | CUSIP resolution | Free at openfigi.com |
| `ANTHROPIC_API_KEY` | AI insights | For adaptive intelligence |
| `GEMINI_API_KEY` | AI features | Alternative to Anthropic |

---

## Broker Sync (Optional)

| Variable | Purpose | Validation |
|----------|---------|------------|
| `BROKER_ENCRYPTION_KEY` | Encrypt broker tokens | `openssl rand -hex 32` |
| `SCHWAB_CLIENT_ID` | Schwab OAuth | |
| `SCHWAB_CLIENT_SECRET` | Schwab OAuth | |
| `SCHWAB_REDIRECT_URI` | OAuth callback | Must be HTTPS |

---

## Connectivity & Alerts

| Variable | Purpose | Default |
|----------|---------|---------|
| `CONNECTIVITY_GATE_FAILURE_THRESHOLD` | Failures before UNHEALTHY | `3` |
| `CONNECTIVITY_GATE_PROBE_MS` | Probe interval (ms) | `30000` |
| `OPERATOR_ALERT_WEBHOOK_URL` | Kill-switch alerts | Optional |

---

## Fly.io Secrets (Quick Validate)

```bash
fly secrets list -a optionpartners
```

**Expected for webhook pipeline:**
- `DATABASE_URL`
- `JWT_SECRET`
- `ENABLE_WEBHOOK_PROCESSOR` = `true`
- `SIM_DEFAULT_USER_ID` = `<your-user-uuid>`
- `DATA_SERVICE_API_KEY` (matches data-service)

**Optional but recommended:**
- `WEBHOOK_SECRET`
- `FRONTEND_URL`
- `EMAIL_*` (if using email)

---

## Validation Script (Manual)

```bash
# Check user and SIM_DEFAULT_USER_ID
cd backend && node scripts/check-user.js

# Check webhook stats (requires auth)
curl -s "https://optionpartners.fly.dev/api/sim/webhook-stats?days=3" \
  -H "Authorization: Bearer YOUR_JWT"
```
