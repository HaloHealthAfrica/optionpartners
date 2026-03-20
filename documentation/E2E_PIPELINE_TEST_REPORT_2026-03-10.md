# E2E Pipeline Test Report — 3/10/2026

**Target:** https://optionpartners.fly.dev/sim/webhooks  
**Goal:** Identify blockers preventing sim trading; enable trades for 3/10

---

## Executive Summary

| Check | Status |
|-------|--------|
| Backend health | ✅ OK |
| Database | ✅ Connected |
| Webhook ping | ✅ OK |
| **SIGNALS webhook** | ❌ **500 error** (ingestion fails) |
| STRAT / ORB / PIVOT_MB / SQUEEZE_PRO | ✅ Ingested |
| Data service | ❌ **Circuit breaker OPEN** |
| Trade execution | ⚠️ Partial (2 orders filled via synthetic construction) |

**Root cause for 3/9 no trades:** Data service circuit breaker is OPEN, causing chain/price/trend data to be stale. Most trade-trigger signals are blocked by `FAIL_CLOSED: Trend data severely stale`.

---

## 1. SIGNALS Webhook Returns 500

**Symptom:** POST `/api/webhooks/tradingview` with SIGNALS payload returns HTTP 500 instead of 202.

**Impact:** Any TradingView alert using the SIGNALS format (composite AI-scored signal with `signal`, `score`, `trend`, `trend_data`) will fail at ingestion.

**Other formats work:** STRAT V1/V2, ORB, PIVOT_MB, SQUEEZE_PRO all return 202 and are queued.

**Next steps:**
1. Add detailed error logging in `webhook.controller.js` catch block (log `error.stack`) and redeploy.
2. Check Sentry for the captured exception.
3. Reproduce locally with `E2E_BASE_URL=http://localhost:3000` and inspect logs.

---

## 2. Data Service Circuit Breaker OPEN (Critical)

**Symptom:** Logs show:
```
Data service circuit breaker OPEN — failing fast
[GMS] SPY: chain refresh failed after 3 attempts
[GMS] SPY: price refresh failed
[REGIME_UNAVAILABLE] all regime endpoints unavailable
```

**Impact:**
- Chain data stale: ~85 hours (308,115 seconds)
- Price data stale: ~2 hours (7,156 seconds)
- Trend data severely stale: ~6 hours (21,895 seconds)
- **5 signals rejected** by `TRADE_ENGINE/data_staleness` with `FAIL_CLOSED: Trend data severely stale`

**Remediation:**
1. **Verify data-service is running and reachable:**
   ```bash
   fly status -a optionpartners-data
   curl -s https://optionpartners-data.fly.dev/api/health
   ```

2. **Check DATA_SERVICE_URL in backend:**
   - Backend must point to `https://optionpartners-data.fly.dev` (or internal Fly URL).
   - Ensure `DATA_SERVICE_API_KEY` matches data-service `API_KEY` secret.

3. **Reset circuit breaker** (backend now has auto-recovery + manual reset):
   - **Auto-recovery:** Backend runs a periodic health probe every 15s when CB is OPEN. If data-service responds, it resets both backend and data-service CBs.
   - **Manual reset:** `POST /api/sim/data-service/circuit-breaker/reset` (authenticated). Resets backend CB and optionally data-service's provider CBs.
   - **Data-service direct:** `curl -X POST -H "X-API-Key: <key>" https://optionpartners-data.fly.dev/api/admin/circuit-breaker/reset`

4. **Fix underlying provider failures:**
   - Check data-service logs for provider errors (Polygon, TwelveData, Unusual Whales).
   - Verify API keys are valid and not rate-limited.

---

## 3. Pipeline Diagnostic Results (3/10)

| Stage | Finding |
|-------|---------|
| Webhook ingestion | 24 total today; 12 processed, 10 rejected, 2 test pings |
| Trade-trigger webhooks | ORB (2 rej), PIVOT_MB (3 rej), SQUEEZE_PRO (2 proc, 2 rej), STRAT (2 proc, 2 rej) |
| Stuck in RECEIVED | 0 |
| Signal rejections | 5 at TRADE_ENGINE/data_staleness |
| Sim orders | 2 FILLED (AMZN CALL, META PUT) |
| Kill switch | false |
| Open positions | 2 |

**Rejection reasons:**
- `FAIL_CLOSED: Trend data severely stale` (data service down)
- `Missing action or side` (ORB edge case)
- `Missing squeeze.compression_score` (SQUEEZE_PRO validation)
- `No open position found for AMZN null` (EXIT signal without position)

---

## 4. Fixes Applied

- **e2e-pipeline-diagnostic.js:** Fixed STAGE 8 query — `strategy_cooldowns` has no `symbol` column. Updated to select `strategy, cooldown_until, reason, created_at` only.

---

## 5. Checklist for 3/10 Trading

- [ ] **Fix data-service connectivity** — Circuit breaker must close; chain/price/trend must refresh.
- [ ] **Debug SIGNALS 500** — Add error logging, check Sentry, fix ingestion.
- [ ] **Verify TradingView alerts** — Ensure trade-trigger alerts (SIGNALS, STRAT, ORB, PIVOT_MB, SQUEEZE_PRO) are firing and webhook URL is correct.
- [ ] **Warmup symbols** — Call `POST /api/sim/warmup/:symbol` for symbols you plan to trade before market open.
- [ ] **Confirm SIM_DEFAULT_USER_ID** — Set in Fly secrets if using unauthenticated webhooks.

---

## 6. Quick Commands

```bash
# Run E2E all-systems
$env:E2E_BASE_URL="https://optionpartners.fly.dev"; node backend/scripts/e2e-all-systems.js

# Run E2E prod webhooks (comprehensive)
node backend/scripts/e2e-prod-all-webhooks.js

# Run pipeline diagnostic (on Fly with DB access)
fly ssh console -a optionpartners -C "node backend/scripts/e2e-pipeline-diagnostic.js"

# Check Fly logs
fly logs -a optionpartners
fly logs -a optionpartners-data
```
