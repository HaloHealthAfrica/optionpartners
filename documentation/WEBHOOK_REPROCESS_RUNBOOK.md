# Webhook Reprocess Runbook

Use this runbook to check webhook counts and reprocess pending webhooks (e.g., after market close or when the processor was disabled).

## Prerequisites

- **Migration 187** applied: `webhook_events` must have `user_id`, `received_at`, `raw_payload`, `dedupe_key` (run `node backend/src/utils/migrate.js` or deploy with migrations)
- `ENABLE_WEBHOOK_PROCESSOR=true` in Fly secrets (or call `POST /api/sim/process` manually)
- `SIM_DEFAULT_USER_ID` set in Fly secrets when webhooks have no `user_id` (legacy/marketplaybook schema)
- Auth token (JWT) for API calls
- Admin role for global stats and bulk requeue

---

## 1. Check Webhook Counts (Past 3 Days)

**Your webhooks only:**
```bash
curl -s "https://marketplaybook.fly.dev/api/sim/webhook-stats?days=3" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**All users (admin only):**
```bash
curl -s "https://marketplaybook.fly.dev/api/sim/webhook-stats?days=3&all=true" \
  -H "Authorization: Bearer YOUR_ADMIN_JWT_TOKEN"
```

Response includes:
- `total`, `received`, `processed`, `rejected`, `testPing`
- `earliest`, `latest`
- `recent` — last 10 webhooks with status and symbol

---

## 2. Reprocess Pending Webhooks

**RECEIVED** webhooks (stuck because processor was disabled) are processed by:

```bash
curl -X POST "https://marketplaybook.fly.dev/api/sim/process" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

This runs the full pipeline: decision router → executor → trade finalizer.

---

## 3. Requeue REJECTED Webhooks (Optional)

If webhooks failed with **processing errors** (e.g., data-service timeout) and you want to retry them:

**Admin only — bulk requeue:**
```bash
curl -X POST "https://marketplaybook.fly.dev/api/sim/requeue-rejected?days=3" \
  -H "Authorization: Bearer YOUR_ADMIN_JWT_TOKEN"
```

Then run step 2 (`POST /api/sim/process`) to process them.

**Single webhook retry:**
```bash
curl -X POST "https://marketplaybook.fly.dev/api/webhooks/WEBHOOK_ID/retry" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## 4. Verify System Health

Before reprocessing, ensure:

- **Kill switch** is off: `GET /api/sim/status` → `account.killSwitchActive: false`
- **Data-service** is reachable: `GET /api/sim/health/global` → connectivity gate HEALTHY
- **Processor** is running: `GET /api/sim/status` → `processor.running: true`

---

## Quick End-to-End Test (Market Close)

1. **Stats:** `GET /api/sim/webhook-stats?days=3` — note `received` count
2. **Process:** `POST /api/sim/process` — processes all pending
3. **Stats again:** `GET /api/sim/webhook-stats?days=3` — `received` should drop, `processed` should increase
4. **Trades:** `GET /api/sim/trades` — confirm new sim_trades if signals were approved

---

## Notes

- **PROCESSED** webhooks are not reprocessed — that would create duplicate trades
- **REJECTED** with validation errors (timestamp, duplicate, etc.) cannot be retried
- Only **REJECTED** with `Processing error:` and retry_count < 3 are eligible for requeue
