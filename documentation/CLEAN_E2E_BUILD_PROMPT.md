# Prompt: Clean End-to-End Build — Single Strategy on Fresh Dev Server

**Context:** I'm setting up a second dev server for a minimal, working end-to-end build. I want one strategy, its webhooks end-to-end, data enrichment, and data access working. No other strategies or features.

---

## 1. TradeTally Architecture — Where to Build (From Scratch)

Assume you are building this clean build from scratch within the TradeTally monorepo. The following describes **where** each component lives and **why** that placement.

### 1.1 Monorepo Layout

```
TradePartners/
├── backend/           # Node.js, Express, PostgreSQL (port 3000)
├── frontend/          # Vue 3, Pinia, Vite (port 5173)
├── data-service/      # TypeScript, Express (port 4000)
├── docker/            # nginx, start scripts
└── documentation/
```

### 1.2 Backend — Webhook & Sim Engine

| Location | Purpose | Why Here |
|----------|---------|----------|
| `backend/src/modules/webhooks/` | Webhook ingestion, validation, normalizers, rate limiting | **Modular feature** — webhooks are a distinct subsystem. Keeps controller, service, validator, normalizers, and routes together. Other modules (sim, portfolio) consume webhook output. |
| `backend/src/modules/webhooks/normalizers/<strategy>.normalizer.js` | Per-strategy payload validation and normalization | **Strategy-specific logic** — each indicator (REVERSAL, CRT, SQUEEZE_PRO) has its own payload shape. Normalizers produce a canonical `NormalizedIndicatorSignal` for the decision pipeline. |
| `backend/src/modules/webhooks/indicator-detector.js` | Detect source (STRAT, REVERSAL, CRT, etc.) from raw payload | **Single entry point** — detection runs before validation; routing to the correct normalizer. Keeps fingerprint logic centralized. |
| `backend/src/modules/sim/` | Webhook processor, decision-router, executor, exit-monitor, trade-finalizer | **Simulation engine** — all trade lifecycle logic lives here. Webhooks are the input; sim_orders, sim_positions, sim_trades are the output. Separated from journal/analytics (trades table). |
| `backend/src/modules/sim/options-constructor.service.js` | Build option legs from `strategy_trade_recipe` + chain data | **Strategy → execution bridge** — recipes define structure (CALL/PUT/CREDIT_SPREAD, DTE, delta); constructor fetches chain from data-service and picks strikes. |
| `backend/src/services/dataServiceProxy.js` | HTTP client to data-service (quotes, chain, VIX, regime) | **Shared service** — sim engine, symbol-state, global-market-state all need market data. Proxy centralizes URL, auth, timeout. |
| `backend/src/services/connectivityGate.js` | Health probe, fail-fast when data-service unreachable | **Cross-cutting concern** — data-service outages should not block webhook ingestion; trade decisions should fail closed. Gate is used by dataServiceProxy. |
| `backend/src/routes/` | `api.routes.js`, `health.routes.js`, etc. | **API surface** — Express mounts routes. Webhook routes live in `modules/webhooks/webhook.routes.js` and are mounted at `/api/webhooks`. |
| `backend/src/server.js` | App bootstrap, middleware, route mounting | **Orchestration** — raw body capture for webhooks, rate limiting, CORS. Webhook routes mounted at `/api/webhooks`; sim routes at `/api/sim`. |

**Route mounting (server.js):**
```javascript
app.use('/api/webhooks', webhookRoutes);   // POST /tradingview, POST /crt-signal, etc.
app.use('/api/sim', simRoutes);            // GET /positions, POST /process, etc.
app.use('/api/market-data', marketDataRoutes);  // Proxies to data-service
```

### 1.3 Data-Service — Market Data & Enrichment

| Location | Purpose | Why Here |
|----------|---------|----------|
| `data-service/src/` | Standalone TypeScript service | **Separate process** — rate limits, API keys, and provider failures are isolated. Backend stays stateless; data-service handles provider fallbacks, circuit breakers, caching. |
| `data-service/src/providers/` | TwelveData, Polygon, Unusual Whales, CBOE, FRED clients | **Provider abstraction** — each provider has its own client. Data-orchestrator selects provider (primary/fallback). New providers = new client + registration. |
| `data-service/src/services/data-orchestrator.ts` | Route requests to providers, aggregate results | **Single entry point** — backend calls `/api/quote/SPY`, orchestrator picks provider, returns canonical shape. |
| `data-service/src/cache/` | Redis + memory fallback | **Reduce provider calls** — quotes, chains, VIX are cached. Data-service owns TTL and invalidation. |
| `data-service/src/api/routes.ts` | `/api/quote/:symbol`, `/api/options-chain/:symbol`, `/api/regime`, `/api/vix` | **REST API** — backend proxies via `dataServiceProxy`; frontend can call directly if CORS allows. |
| `data-service/src/workers/` | Pollers for chain, price, VIX, macro | **Background refresh** — workers keep cache warm during RTH. Backend gets fresh data without blocking. |

**Why a separate data-service?**
- **Rate limits** — TwelveData, Polygon, Unusual Whales have per-key limits. One service can pool and throttle.
- **Circuit breakers** — Provider failures don't crash the main app. Data-service fails gracefully; backend connectivity gate fails closed on trade decisions.
- **Scaling** — Data-service can scale independently (e.g., Fly.io `optionpartners-data`).

### 1.4 Backend — Trade Enrichment (Journal)

| Location | Purpose | Why Here |
|----------|---------|----------|
| `backend/src/services/enrichmentCacheService.js` | Cache strategy classification, MAE/MFE, sector for symbols | **Reuse across trades** — same symbol+date often has same enrichment. Cache avoids repeated API calls. |
| `backend/src/services/newsEnrichmentService.js` | Fetch news for symbol+date | **Post-trade enrichment** — runs after trade closes. Optional for minimal build. |
| `backend/src/utils/jobQueue.js` | Background jobs for classification, news | **Async processing** — enrichment can be slow; jobs run in worker. Not required for sim-only flow. |

**Minimal build:** Enrichment is for the `trades` table (journal). Sim trades use `sim_trades`; enrichment applies when syncing to journal or when viewing. For a clean single-strategy build, enrichment can be deferred.

### 1.5 Frontend — Simulation UI

| Location | Purpose | Why Here |
|----------|---------|----------|
| `frontend/src/views/simulation/` | WebhookInboxView, SimTradesView, SimEquityCurveView, etc. | **Feature area** — all sim-related views live under `simulation/`. Router uses `/sim/*` paths. |
| `frontend/src/views/simulation/WebhookInboxView.vue` | List webhooks, show payload, status, retry | **Webhook visibility** — essential for debugging. Shows RECEIVED/PROCESSED/REJECTED, indicator_source, error_message. |
| `frontend/src/views/simulation/SimTradesView.vue` | List sim_trades, PnL, strategy | **Trade visibility** — confirms entries and exits. |
| `frontend/src/stores/simulation.js` | Pinia store for sim state, API calls | **Client state** — fetches positions, orders, trades, account. Used by sim views. |
| `frontend/src/router/index.js` | Routes under `/sim/webhooks`, `/sim/trades`, etc. | **Navigation** — sim section is under `/sim`; auth required. |
| `frontend/src/services/api.js` | Axios base URL, auth headers | **HTTP client** — calls `/api/sim/*`, `/api/webhooks/*`. |

### 1.6 Database — Migrations

| Location | Purpose | Why Here |
|----------|---------|----------|
| `backend/migrations/` | Sequential SQL migrations (001_*.sql, 002_*.sql, …) | **Schema versioning** — migrations run on startup (`migrate.js`). Sim tables: `webhook_events`, `sim_account_state`, `sim_orders`, `sim_positions`, `sim_trades`, `symbol_state`, `strategy_trade_recipe`. |
| `backend/migrations/158_add_options_constructor.sql` | `strategy_trade_recipe` table | **Recipe storage** — per-strategy options construction rules. REVERSAL and CRT recipes seeded in 183, 158. |
| `backend/migrations/183_reversal_options_recipes.sql` | Seed reversal_eme, reversal_spe, reversal_strat recipes | **Strategy enablement** — without recipes, options-constructor has no structure to build. |

### 1.7 Build Order (From Scratch)

If building this flow from scratch, recommended order:

1. **PostgreSQL + migrations** — Create `webhook_events`, `sim_account_state`, `sim_orders`, `sim_positions`, `sim_trades`, `symbol_state`, `strategy_trade_recipe`. Run migrations.
2. **Data-service** — Minimal: TwelveData for quotes, one provider for chains. Expose `/api/quote/:symbol`, `/api/options-chain/:symbol`, `/api/health`.
3. **Backend dataServiceProxy + connectivityGate** — Proxy to data-service; gate fails closed when unreachable.
4. **Webhook module** — `indicator-detector`, one normalizer (REVERSAL or CRT), `webhook.service`, `webhook.controller`, `webhook.routes`. Mount at `/api/webhooks/tradingview`.
5. **Sim module (minimal)** — `decision-router`, `options-constructor`, `executor`, `trade-finalizer`, `webhook-processor`. Seed `strategy_trade_recipe` for chosen strategy.
6. **Exit monitor** — Optional for REVERSAL/CRT (stop/TP); required for position closes.
7. **Frontend** — WebhookInboxView, SimTradesView, simulation store, router routes.

---

### 1.8 Architecture to Avoid Current Failures

**Problem:** Production deployments often fail with `FAIL_CLOSED: Trend data severely stale`, circuit breaker OPEN, webhook 500s, and validation rejections. The following architecture reduces these risks.

#### 1.8.1 Data Staleness & Circuit Breaker

| Issue | Recommendation | Why |
|-------|-----------------|-----|
| **Data service circuit breaker OPEN** | Verify data-service health before RTH. Add startup check: `POST /api/sim/data-service/circuit-breaker/reset` (or wait for auto-recovery probe). | When CB is OPEN, all data-service calls fail fast. Chain/price/trend never refresh → staleness blocks every trade. |
| **Trend/macro severely stale** | **Pre-market warmup** — Call `POST /api/sim/warmup/:symbol` for each symbol you plan to trade **before** first webhook (e.g., 9:25 ET). | `symbol_state` must have fresh `macro_updated_at`, `local_updated_at`, `chain_updated_at`, `price_updated_at`. Warmup seeds all four from data-service. |
| **Chain data unavailable** | Set `CHAIN_FETCH_RETRY_COUNT=3` (default). Ensure data-service has at least one working chain provider (Unusual Whales or Polygon). | Decision-router retries chain fetch before rejecting. If all providers fail, `chain_data_unavailable` blocks. |
| **Early session grace** | Set `SIM_CHAIN_EARLY_SESSION_GRACE=1.5` (9:30–9:45 ET). Data feeds lag at open. | Extends TTL for chain/price during first 15 min so legitimate early signals aren't blocked. |

**Staleness TTLs (env):**
- `SIM_STATE_TTL_MS=1800000` (30 min) — macro/trend/chain max age before penalty
- `SIM_CHAIN_TTL_MS` — defaults to `SIM_STATE_TTL_MS`; extend if provider refresh is slower
- **Severely stale** = 4× TTL (2 hours default) → hard block

#### 1.8.2 Feature Isolation for Minimal Build

**Disable optional features** until the core flow works:

| Feature | Disable / Set | Reason |
|---------|---------------|--------|
| **Revenue target** | `revenue_target_config.enabled = false` | Gate can block trades; fallback mode adds complexity. |
| **Strategy scorecard cooldowns** | Clear cooldowns or disable strategy gate | Cooldowns can block after a losing streak. |
| **Adaptive guards** | Minimal or disabled | Conviction calibration, regime-edge can add rejection paths. |
| **SUPPRESSED_STRATEGIES** | Set to exclude all except your chosen strategy | Prevents other strategies from consuming resources or causing confusion. |
| **SIM_REQUIRE_CHAIN_DATA** | `false` for initial webhook/processor tests only | Allows testing flow when data-service is down. **Never** leave in production. |

#### 1.8.3 Startup Validation Checklist

Before RTH, run a validation sequence:

1. **Data-service reachable:** `curl -s $DATA_SERVICE_URL/api/health` → 200
2. **Backend connectivity gate:** `GET /api/health` → data-service healthy
3. **Circuit breaker:** If OPEN, `POST /api/sim/data-service/circuit-breaker/reset` (authenticated)
4. **Warmup symbols:** `POST /api/sim/warmup/SPY` (and QQQ, etc.) for each symbol
5. **Webhook ping:** `POST /api/webhooks/tradingview` with `{ "test": true }` → 202
6. **Strategy payload:** Send one valid payload for chosen strategy → 202, RECEIVED
7. **Processor run:** Wait 5s or `POST /api/sim/process` → event moves to PROCESSED

**Script:** `backend/scripts/e2e-all-systems.js` or `e2e-pipeline-diagnostic.js` can be adapted for this.

#### 1.8.4 Graceful Degradation

| Scenario | Behavior | Config |
|----------|----------|--------|
| **Data-service down** | Connectivity gate → UNHEALTHY. Trade decisions fail closed (no data = no trade). Webhook ingestion still works (RECEIVED). | `connectivityGate` probes every 30s; auto-recovery when data-service returns. |
| **Provider rate limit** | Data-service circuit breaker per provider. Backend sees 503; fails closed. | Data-service `rate-limiter`, `circuit-breaker`; backend `connectivityGate`. |
| **Webhook validation fails** | Event stored as REJECTED with `error_message`. No crash. | `webhook.service.ingest` validates before insert; controller catches errors. |
| **Options constructor no recipe** | Order REJECTED with reason. No crash. | `strategy_trade_recipe` must have row for (strategy, direction). |

#### 1.8.5 Error Handling & Observability

| Recommendation | Where | Why |
|----------------|-------|-----|
| **Log full error stack** | `webhook.controller.js` catch block | 500 errors (e.g., SIGNALS ingestion) often hide root cause. Log `error.stack` for debugging. |
| **Rejection reason taxonomy** | `signal_rejections.rejection_reason` | `data_staleness`, `chain_data_unavailable`, `precondition_fail`, etc. Enables breakdown analysis. |
| **Webhook status visibility** | WebhookInboxView | Shows RECEIVED/PROCESSED/REJECTED, `indicator_source`, `error_message`. Essential for debugging. |
| **Health endpoint** | `GET /api/sim/health/state` | Returns symbol_state freshness, connectivity gate status, circuit breaker state. |

#### 1.8.6 Payload Validation Robustness

| Issue | Fix | Prevention |
|-------|-----|------------|
| **Missing action or side** | Normalizer must always set `action` (BUY/SELL/CLOSE) from `direction` or payload. | ORB: `action` or `side` required. Add fallback in normalizer. |
| **Missing squeeze.compression_score** | SQUEEZE_PRO normalizer requires `squeeze.compression_score` or `compression_score`. | Validate in normalizer; return clear error. |
| **EXIT without position** | Decision-router returns "No open position found for X". | Expected when EXIT fires before ENTRY or for wrong symbol. Log; don't crash. |

#### 1.8.7 Single-Strategy Deployment Summary

For a clean build, deploy with:

1. **One strategy** (REVERSAL or CRT) — `SUPPRESSED_STRATEGIES` excludes all others
2. **Revenue target disabled** — `revenue_target_config.enabled = false`
3. **Pre-market warmup** — Script or cron calls `/api/sim/warmup/:symbol` for SPY, QQQ, etc. at 9:25 ET
4. **Data-service verified** — Health check + circuit breaker reset before RTH
5. **Startup validation** — Run checklist above before first live webhook

---

## 2. Strategy Choice

Pick **one** strategy and stick to it:

- **REVERSAL** (recommended): Restricted symbols (SPY, QQQ, IWM, IWN). Variants: `reversal_eme`, `reversal_spe`, `reversal_strat`. Has `strategy_trade_recipe` rows (credit spreads, 7 DTE, 25 delta). Clear payload format and validation.
- **CRT (Candle Range Theory)**: Any symbol. Structured payload with `signal_id`, `direction`, `option_type`, `entry`, `stop_loss`, `strike`. Has `strategy_trade_recipe` for `crt_confluence`.

---

## 3. Webhook Details

### 3.1 Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/webhooks/tradingview` | POST | Primary TradingView webhook (all strategies) |
| `/api/webhooks/crt-signal` | POST | CRT alias — same handler, supports `"SPY CRT BULL: {...}"` message format |

### 3.2 Authentication & Identity

- **User identity required** for trade-trigger webhooks. Provide one of:
  - `Authorization: Bearer <JWT>` (logged-in user)
  - `x-api-key: <API_KEY>` (from `api_keys` table, must match a user)
- **Test pings** (`{ "test": true }` or `{ "type": "PING" }`) do not require a user — returns 202 with `TEST_PING`.
- **HMAC signature** (optional): `x-tradingview-signature` or `x-webhook-signature` — verified if `WEBHOOK_SECRET` is set; invalid signatures are logged but not rejected.

### 3.3 Request Format

- **Content-Type:** `application/json`
- **Body:** JSON object (see payload examples below)
- **CRT message format:** TradingView can send `{ "message": "SPY CRT BULL: {...}" }` — controller extracts and parses the JSON after the colon.

### 3.4 Rate Limiting

- Per IP, per API key, per user (when authenticated)
- Test pings bypass rate limits
- 401 if no user identity and payload is not a test ping

### 3.5 Processing Flow

1. **Ingest** → `webhook_events` table, status `RECEIVED` (or `REJECTED` if validation fails)
2. **Processor** polls every `WEBHOOK_PROCESSOR_INTERVAL` (default 5000ms), picks up `RECEIVED` events
3. **Pipeline:** `decision-router` → `options-constructor` → `executor` → `trade-finalizer` (when position closes)
4. **Status:** `RECEIVED` → `PROCESSED` or `REJECTED`

### 3.6 Deduplication

- Each source uses a `dedupe_key` (hash of source + symbol + timestamp + discriminator)
- Duplicates return existing event; no new row inserted
- **CRT:** `signal_id` is primary discriminator — same `signal_id` = duplicate
- **REVERSAL:** `signal_type`/`signal` + `setup_id` + `pattern` + confidence

### 3.7 Timestamp Validation

- Payloads older than source-specific max age are `REJECTED`
- REVERSAL, CRT: 30 minutes
- STRAT: 2 hours; SIGNALS, ORB, SQUEEZE_PRO, PIVOT_MB: 30 minutes

---

## 4. Webhook Payload Examples

### 4.1 Test Ping (no user required)

```json
{ "test": true }
```
or
```json
{ "type": "PING" }
```

### 4.2 REVERSAL — EME (Expected Move Engine)

```json
{
  "symbol": "SPY",
  "timestamp": "20260313143000",
  "price": 585.25,
  "expected_move": 2.15,
  "signal_type": "EM_CALL_ZONE",
  "confidence": 72
}
```
- `EM_CALL_ZONE` → long (reversal_eme)
- `EM_PUT_ZONE` → short (reversal_eme)
- `confidence` must be ≥ 50 (configurable via `REVERSAL_EME_MIN_CONFIDENCE`)

### 4.3 REVERSAL — SPE (Strike Probability Engine)

```json
{
  "symbol": "SPY",
  "timestamp": "20260313143000",
  "price": 585.25,
  "signal": "CALL_SPREAD_FAVORABLE",
  "probability_score": 72.5,
  "atr": 2.15,
  "trend_state": "BULLISH"
}
```
- `CALL_SPREAD_FAVORABLE` → long (reversal_spe)
- `PUT_SPREAD_FAVORABLE` → short (reversal_spe)
- `probability_score` must be ≥ 65 (configurable via `REVERSAL_SPE_MIN_SCORE`)

### 4.4 REVERSAL — STRAT_TRIGGER (requires prior STRAT_SETUP)

**Setup (context-only, no trade):**
```json
{
  "signal": "STRAT_SETUP",
  "setup_id": "REV-20260313-001",
  "symbol": "SPY",
  "pattern": "212_FORMING_BULL",
  "timeframe": "5",
  "trigger_level": 585.50,
  "setup_low": 582.20,
  "expects_trigger": true,
  "timestamp": "20260313143000"
}
```

**Trigger (trade entry):**
```json
{
  "signal": "STRAT_TRIGGER",
  "setup_id": "REV-20260313-001",
  "symbol": "SPY",
  "pattern": "212_BULL",
  "timeframe": "5",
  "confidence_score": 78,
  "timestamp": "20260313143500"
}
```
- `confidence_score` must be ≥ 70 (configurable via `REVERSAL_STRAT_MIN_CONFIDENCE`)
- `setup_id` must match a prior STRAT_SETUP

### 4.5 CRT (Candle Range Theory)

```json
{
  "signal_id": "crt_20260313_143000_abc123",
  "symbol": "SPY",
  "direction": "LONG",
  "option_type": "call",
  "entry": 585.50,
  "stop_loss": 582.00,
  "take_profit1": 590.00,
  "take_profit2": 592.00,
  "take_profit3": 595.00,
  "strike": 586,
  "dte_suggestion": 7,
  "risk_r": 0.5,
  "atr": 2.8,
  "score": 50,
  "trigger": "2-1-2",
  "sweep": "LOW",
  "timeframe": "5",
  "timestamp": "2026-03-13T14:30:00.000Z"
}
```
- `score` must be ≥ 40 for approval
- `signal_id` must be unique (used for deduplication)

### 4.6 EXIT Webhooks

- **REVERSAL** and **CRT** do not send explicit EXIT webhooks. Positions close via:
  - **Exit monitor** (stop_loss / take_profit) — runs periodically, checks underlying price
  - **MTF_BIAS macro flip** — closes counter-trend positions when macro bias changes
- **SQUEEZE_PRO** supports explicit EXIT: `signal_type: "EXIT"` with `exit_reason` (e.g. `"MOMENTUM_REVERSAL"`)

---

## 5. Scope

Build and verify:

1. **Webhook pipeline** — Ingest → indicator-detector → normalizer → decision-router → options-constructor → executor → trade-finalizer → sim_trades
2. **Data enrichment** — Data-service (quotes, chain, VIX, regime); Backend (enrichment cache, strategy classification, news optional)
3. **Data access** — Backend → data-service (connectivity gate, circuit breaker); Data-service → providers (TwelveData, Polygon, Unusual Whales, CBOE, FRED)

---

## 6. Stack (Minimal)

- PostgreSQL (main DB)
- Data-service (port 4000) — quotes, chains, VIX, regime
- Backend (port 3000) — API, webhooks, sim engine
- Frontend (port 5173 or built) — UI for sim trades, webhooks
- Redis (optional) — data-service cache; can run without for initial testing

---

## 7. Environment

**Backend `.env` (critical):**
```
TRADING_MODE=SIM
ENABLE_WEBHOOK_PROCESSOR=true
WEBHOOK_SECRET=<any-secret-for-hmac>
SUPPRESSED_STRATEGIES=<empty-or-exclude-all-except-chosen-strategy>
DATA_SERVICE_URL=http://localhost:4000
DATA_SERVICE_API_KEY=<matches-data-service-API_KEY>
SIM_REQUIRE_CHAIN_DATA=true
```

**Data-service `.env` (minimum):**
```
PORT=4000
API_KEY=<same-as-backend-DATA_SERVICE_API_KEY>
TWELVE_DATA_API_KEY=<required-for-quotes-candles>
POLYGON_API_KEY=<for-chains-if-available>
UNUSUAL_WHALES_API_KEY=<optional>
REDIS_URL=redis://localhost:6379  # or omit to skip Redis
```

---

## 8. Validation Steps

1. **Health checks** — `GET /api/health` (backend), `GET /api/health` (data-service)
2. **Webhook ping** — `POST /api/webhooks/tradingview` with `{ "test": true }` → 202, `TEST_PING`
3. **Strategy webhook** — Send valid payload for chosen strategy (REVERSAL or CRT) with `x-api-key` or JWT → 202, status `RECEIVED`
4. **Processor run** — Wait for `WEBHOOK_PROCESSOR_INTERVAL` (e.g. 5s) or trigger processing → event moves to `PROCESSED` or `FAILED`
5. **Trade flow** — Entry webhook → sim_orders FILLED → sim_positions OPEN; Exit via monitor or macro flip → position CLOSED → sim_trades row
6. **Data-service** — `GET /api/quote/SPY`, `GET /api/chain/SPY`; circuit breaker not OPEN

---

## 9. Constraints

- Only the chosen strategy enabled; others suppressed or not configured
- Single test user
- `SIM_REQUIRE_CHAIN_DATA=false` only for webhook/processor tests when data-service is unavailable
- Run migrations before testing (including `strategy_trade_recipe` for chosen strategy)

---

## 10. Deliverables

1. Minimal `.env` files for backend and data-service
2. Startup order: Postgres → data-service → backend → frontend
3. Sample webhook payloads for chosen strategy (entry; exit via monitor for REVERSAL/CRT)
4. Verification checklist (curl or script) for the steps above
