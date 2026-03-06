# Full System Audit — TradePartners Simulated Options Trading Platform

**Audit Date:** March 2, 2026  
**Auditor:** Automated Deep Code Audit  
**Scope:** End-to-end trade pipeline, data service, adaptive intelligence, replay engine, error handling, database integrity

---

## Table of Contents

1. [Critical Blockers](#1-critical-blockers)
2. [Logic Flaws](#2-logic-flaws)
3. [Missing Functionality](#3-missing-functionality)
4. [Robustness Gaps](#4-robustness-gaps)
5. [Data Integrity](#5-data-integrity)
6. [Observability Gaps](#6-observability-gaps)
7. [Profitability Readiness Checklist](#7-profitability-readiness-checklist)

---

## 1. CRITICAL BLOCKERS

Issues that would cause the system to lose money, corrupt state, or fail silently. Must be fixed before any trading.

---

### C-01: Replay Engine Produces Unreliable Backtest Results

**File:** `backend/src/modules/sim/replay.service.js` lines 194-212  
**Severity:** Critical  
**Description:** The replay engine converts historical candles into synthetic webhook payloads with `contract_type: 'STOCK'` and derives direction from `candle.close > candle.open` (bullish/bearish candle). But the live pipeline trades **options** through the options constructor. The synthetic payloads lack indicator metadata, STRAT/SIGNALS structure, confidence scores, entry/stop/target levels, and timeframe context that the live normalizers produce. The decision router's precondition checks (confidence >= 40, R:R >= 1.5, macro alignment, chain data requirement) will reject virtually all synthetic payloads.

Additionally, the replay runs through the same safety guards that check:
- **Trading hours** — historical candles from weekends/after-hours will be rejected
- **Signal staleness** — synthetic timestamps may fail the maxSignalAgeMs check
- **Chain data freshness** — fail-closed blocks without fresh chain data (which doesn't exist for historical replays)
- **Macro/trend staleness** — no historical macro data is fed into SymbolState

**Impact:** Backtests will show near-zero trade execution, giving no useful signal about strategy profitability. Any backtest results that do pass through are not representative of live behavior.

**Recommended Fix:**
1. Create a replay-specific bypass mode that disables time-of-day, staleness, and chain data guards
2. Build proper synthetic signal payloads that include indicator metadata from the historical dataset
3. Feed historical IV/GEX/macro data into the replay context so conviction scoring is accurate
4. Add a `replay: true` flag to the pipeline that adapts guard behavior without removing risk checks entirely

---

### C-02: Market Intelligence Module Is Dead Code — Not Wired Into Pipeline

**File:** `backend/src/modules/sim/market-intelligence.js` (entire file, 515 lines)  
**Severity:** Critical  
**Description:** The `MarketIntelligence` class implements four important sub-checks: signal confluence, options flow alignment, confidence gate, and price action validation. However, **it is never imported or called by the decision router**. The decision router (`decision-router.js`) goes directly from adaptive guards to the trade-decision-engine. The market intelligence module is completely disconnected from the trade pipeline.

The trade-decision-engine has its own inline conviction model that partially overlaps (flow alignment, confidence) but lacks the signal confluence check and price action validation. This means:
- No confluence requirement — a single indicator signal can trigger a trade
- No price action chasing detection — the system can buy after the price has already run away from entry
- The intelligence score logged in `intelligence_verdicts` comes from the trade-decision-engine's conviction score, not the market intelligence module

**Impact:** The system lacks a key layer of protection against false signals and adverse entries. Signal confluence (requiring multiple indicators to agree) is one of the most important filters for profitability.

**Recommended Fix:**
1. Wire `market-intelligence.js` into the decision router between adaptive guards and the trade-decision-engine
2. Or merge its unique checks (confluence, price action validation) into the trade-decision-engine's conviction model
3. Ensure `intelligence_verdicts` records reflect all checks that were actually run

---

### C-03: No Webhook Authentication — Endpoint Accepts Unauthenticated Signals

**File:** `backend/src/modules/webhooks/webhook.routes.js` line 19  
**Severity:** Critical  
**Description:** The TradingView webhook endpoint uses `optionalAuth`:
```js
router.post('/tradingview', webhookRateLimit, optionalAuth, webhookController.receiveTradingViewWebhook);
```
This means authentication is **optional**. There is no HMAC signature verification for incoming webhooks. Anyone who discovers the endpoint URL can inject arbitrary trading signals that will be processed through the full pipeline and potentially trigger real simulated trades (and eventually real trades when going live).

The rate limit (120/min) provides some protection but is insufficient — an attacker could inject 120 malicious signals per minute.

**Impact:** Complete vulnerability to signal injection attacks. An attacker could drain the simulated account and, when the system goes live, cause real financial losses.

**Recommended Fix:**
1. Implement HMAC signature verification for TradingView webhooks (TradingView supports custom headers)
2. Add per-user API key validation for webhook ingestion
3. Change `optionalAuth` to `authenticate` and require valid credentials for all webhook endpoints
4. Add IP allowlisting as a secondary defense layer

---

### C-04: Exit Monitor Has Race Condition on Position Closure

**File:** `backend/src/modules/sim/exit-monitor.js` lines 517-564  
**Severity:** Critical  
**Description:** The exit monitor's `_triggerExit` method performs an idempotency check:
```js
const check = await db.query('SELECT status FROM sim_positions WHERE id = $1', [position.id]);
if (check.rows[0].status !== 'OPEN') return;
```
But this check is a regular `SELECT` outside any transaction. Between this check and the subsequent `executor.simulateOrder()` call, another process (webhook processor, another exit monitor cycle, or a manual close) could close the same position. The executor uses advisory locks on `(userId, symbol)`, which helps, but the exit monitor could still attempt a double-close if two exits trigger in rapid succession for different reasons (e.g., stop-loss and DTE expiry in the same cycle).

**Impact:** Potential for double-close attempts, which would throw errors ("Position is no longer OPEN"), log Sentry errors, and potentially corrupt P&L accounting if one close completes and the other partially executes.

**Recommended Fix:**
1. Wrap the status check and `simulateOrder` call in a transaction with `SELECT ... FOR UPDATE` on the position
2. Or rely solely on the executor's advisory lock and handle the "already closed" error gracefully in `_triggerExit` without logging it as an error

---

### C-05: No Staleness Check on Market Context Data

**File:** `backend/src/modules/sim/market-context.service.js` lines 22-127  
**Severity:** Critical  
**Description:** All market context queries (`getLatestIV`, `getLatestGEX`, `getLatestFlow`, `getLatestMacro`) use `ORDER BY captured_at DESC LIMIT 1` but **never check how old the returned data is**. If the data service's GEX poller (2-minute interval) stops working, the system will continue trading on hours-old or days-old GEX data without any warning.

The trade-decision-engine uses this data for:
- IV rank → trade type selection (spread vs directional)
- GEX → conviction scoring (+/- 8 points) and stop level placement
- Flow → conviction scoring (+/- 5 points) and flow alignment
- These directly affect whether trades are taken and at what size

**Impact:** Trading on stale market context data leads to incorrect conviction scores, wrong trade types, and misplaced stops. In a volatile market transition, this could cause significant losses.

**Recommended Fix:**
1. Add a `maxAgeMs` parameter to each query method and reject data older than the threshold
2. Return a `stale: boolean` flag alongside the data so consumers can adjust behavior
3. Log warnings when serving stale data and emit metrics for monitoring
4. Set reasonable defaults: IV (30 min), GEX (10 min), Flow (15 min), Macro (4 hours)

---

### C-06: ProcessPending Evaluates All Decisions Before Executing — Stale Account State

**File:** `backend/src/modules/sim/webhook-processor.js` lines 161-242  
**Severity:** Critical  
**Description:** The `processPending()` method runs in two phases:
1. **Phase 1:** Evaluate ALL pending events through the decision router (lines 177-218)
2. **Phase 3:** Execute approved decisions in priority order (lines 237-240)

Between evaluation and execution, account state changes. For example:
- Event A is approved with $10,000 buying power
- Event A executes, consuming $8,000 in buying power  
- Event B was approved assuming $10,000 buying power, but only $2,000 remains
- Event B's execution may fail at the executor (insufficient buying power) or succeed with an over-allocated portfolio

The safety guards checked during Phase 1 (max daily loss, max open positions, buying power) reflect the state at evaluation time, not execution time.

**Impact:** In a batch with multiple approved signals, the system can over-allocate capital, exceed position limits, or breach daily loss limits because guards ran against pre-execution account state.

**Recommended Fix:**
1. Re-validate account state guards immediately before each execution in `_executeApprovedDecision`
2. Or switch to sequential evaluate-then-execute for each event instead of batch evaluate → batch execute
3. The executor's advisory lock mitigates some of this, but the guard checks should be re-run inside the execution transaction

---

## 2. LOGIC FLAWS

Incorrect calculations, wrong assumptions, contradictory rules between modules, unrealistic defaults.

---

### L-01: Credit Spread Stop-Loss Direction Is Ambiguous

**File:** `backend/src/modules/sim/exit-monitor.js` lines 162-176  
**Severity:** High  
**Description:** The stop-loss check for credit spreads treats all credit spreads the same:
```js
if (isCreditSpread) {
  breached = underlyingPrice >= stopLoss;
}
```
But credit spreads can be either bull put spreads (profit when price stays above) or bear call spreads (profit when price stays below). A bull put spread should trigger stop-loss when price drops below the stop; a bear call spread should trigger when price rises above the stop. The current logic only handles one direction.

The code also sets `profitsWhenDown = isPut` but never considers that a PUT credit spread (bull put) profits when price goes UP.

**Impact:** For bear call spreads, stop-losses trigger in the wrong direction (or not at all). For bull put spreads, the stop-loss direction happens to be backwards (triggers when price rises, which is when the trade is profitable).

**Recommended Fix:**
1. Store the spread direction (`BULL_PUT_SPREAD` or `BEAR_CALL_SPREAD`) on the position record (it's already in `meta.spreadType`)
2. Use the spread direction to determine stop-loss breach direction
3. Alternatively, compare the debit value of the spread to a threshold rather than comparing the underlying price

---

### L-02: Squeeze Pro Size Multiplier Can Exceed Reasonable Bounds

**File:** `backend/src/modules/sim/trade-decision-engine.js` lines 1185-1187  
**Severity:** High  
**Description:** The Squeeze Pro strategy boosts the size multiplier by 1.25x for high compression (>= 80):
```js
const finalSize = compressionScore >= 80
  ? Math.min(2.0, sizeMultiplier * 1.25)
  : sizeMultiplier;
```
If conviction >= 90 (sizeMultiplier = 1.5), the boosted size is 1.875. This is then further multiplied in the decision router by:
- HV risk scaling (up to 1.05x)
- Portfolio risk multiplier

The final adjusted quantity (line 413): `Math.max(1, Math.round(baseQty * adjustedSizeMultiplier))` could be 2.0+ contracts on what was originally a 1-contract signal, effectively doubling risk exposure.

**Impact:** Oversized positions on Squeeze Pro trades concentrate risk on a single strategy, violating the principle that no single trade should dominate portfolio risk.

**Recommended Fix:**
1. Cap the final `adjustedSizeMultiplier` at a global maximum (e.g., 1.5x)
2. Add a max quantity guard in the executor that rejects orders exceeding a configurable max contracts per trade
3. Consider the total portfolio notional after sizing, not just the multiplier

---

### L-03: Conviction Model Double-Applies Macro/Trend Penalties

**File:** `backend/src/modules/sim/trade-decision-engine.js` lines 445-468 and 512-699  
**Severity:** Medium  
**Description:** The `_applyMacroRules` method adds rationale entries like "MACRO_PENALTY: room_to_resistance=LOW — CALL conviction -15" but does **not** actually subtract from the conviction score — it only appends to the rationale array. The `_computeConviction` method (lines 614-621) separately applies `-15` for room penalties. This means the macro rules log a penalty message but don't block, while the conviction model independently applies the same penalty.

However, the `_applyMacroRules` method returns `{ blocked: false }` unconditionally (line 467). The CHOP regime log message (line 455) says "breakout trades blocked, prefer spreads" but doesn't actually block anything — CHOP blocking is handled separately in `_determineTradeType` (lines 729-730).

**Impact:** The rationale audit trail is misleading — it suggests macro rules are actively blocking/penalizing when they're only logging informational messages. The actual penalties come from a different module, creating confusion when debugging trade decisions.

**Recommended Fix:**
1. Either make `_applyMacroRules` actually apply the penalties (return the conviction adjustment), or
2. Remove the penalty language from its rationale entries and clarify it's informational only
3. Consolidate penalty logic into a single location to avoid future divergence

---

### L-04: Expected Move Filter Uses Incorrect Options Pricing Model

**File:** `backend/src/modules/sim/expected-move-filter.js` lines 21-57  
**Severity:** Medium  
**Description:** The expected move calculation uses `expectedMove = atr14 × 1.5`, which assumes the expected price movement equals 1.5x the 14-day ATR. This is not calibrated to any specific holding period or confidence interval. For a 1-day hold, ATR-based expected move should use a 1-day ATR (or ATR14 / sqrt(14)). For longer holds, the relationship depends on the square root of time.

The filter also computes `expectedOptionExpansion = |delta| × expectedMove × 100`, which is a first-order (delta-only) approximation. For ATM options (delta ≈ 0.50), this ignores gamma convexity, which can significantly impact option P&L for larger moves.

**Impact:** The filter may reject trades that would be profitable (if ATR-based move estimate is too conservative) or approve trades that won't reach target (if the estimate is too aggressive). The 1.5x multiplier is arbitrary.

**Recommended Fix:**
1. Calibrate the expected move calculation to the actual target DTE (use ATR × sqrt(DTE/14) or similar)
2. Consider adding a gamma term for more accurate option P&L estimation
3. Make the 1.5x multiplier configurable per strategy
4. Backtest the filter's hit rate — what percentage of filtered trades would have been profitable?

---

### L-05: SIGNALS Precondition Blocks All Counter-Macro Trades Regardless of Signal Strength

**File:** `backend/src/modules/sim/trade-decision-engine.js` lines 317-324  
**Severity:** Medium  
**Description:** The SIGNALS precondition check hard-blocks any signal whose direction conflicts with the macro bias:
```js
if (macroDirLong !== signalIsLong) {
  failures.push(`macro_bias=${state.macro_bias} conflicts with signal direction=${signalDir}`);
}
```
This is a hard gate (not a conviction penalty). A high-confidence (90+) counter-trend signal from the SIGNALS indicator is blocked outright, even though mean-reversion trades against macro can be highly profitable in certain regimes (e.g., oversold bounces in a BEARISH macro).

The STRAT preconditions have the same issue (lines 410-417).

**Impact:** The system systematically misses counter-trend trade opportunities that skilled discretionary traders would take, particularly reversal setups at extremes.

**Recommended Fix:**
1. Convert the macro conflict from a hard block to a conviction penalty (e.g., -20 for macro conflict, -30 for strong macro + conflict)
2. Allow override for very high confidence signals (>= 85) with reduced position sizing
3. Consider regime context — counter-trend trades should be allowed in CHOP but blocked in strong TREND

---

### L-06: Synthetic Option Construction Estimates Are Unrealistic

**File:** `backend/src/modules/sim/options-constructor.service.js` lines 209-265  
**Severity:** Medium  
**Description:** When chain data is unavailable, the synthetic construction:
- Estimates premium as `underlyingPrice * 0.025` (2.5% of underlying) — this is only roughly correct for ATM weeklies on moderate-IV stocks. For high-IV stocks (TSLA, NVDA), this significantly underestimates premium. For low-IV stocks (utilities), it overestimates.
- Sets delta to exactly ±0.50 regardless of strike selection
- Rounds to ATM strike (nearest dollar) which may not be an actual tradeable strike (strikes come in $5 increments for many stocks)
- Calculates bid/ask as ±3% of estimated premium, giving a fixed 6% spread — real spreads vary from 1% (liquid SPY) to 20%+ (illiquid names)

**Impact:** Trades executed on synthetic construction have unrealistic fill prices, leading to phantom profits or losses in the simulation. If the sim shows profitability on synthetic fills, it can't be trusted.

**Recommended Fix:**
1. Log a prominent warning when synthetic construction is used so it's visible in analytics
2. Apply a larger simulated spread penalty for synthetic constructions
3. Mark trades built from synthetic construction separately in `sim_trades` for filtering in analytics
4. Ideally, block trading when chain data is unavailable (the fail-closed check already does this when `SIM_REQUIRE_CHAIN_DATA !== 'false'`)

---

## 3. MISSING FUNCTIONALITY

Features referenced but not implemented, TODOs in code, stub functions, incomplete integrations.

---

### M-01: No Partial Profit Taking / Scale-Out Mechanism

**File:** Entire sim pipeline  
**Severity:** High  
**Description:** The system has no mechanism for scaling out of positions. All exits are full closes. Common options trading practices include:
- Taking 50% off at first target, trailing the rest
- Scaling out based on time decay (close at 50% profit on credit spreads)
- Reducing position size as DTE approaches zero

The exit monitor evaluates stop-loss, take-profit, trailing stop, and DTE — but all trigger full position closures.

**Recommended Fix:**
1. Add a `scale_out_rules` field to the strategy recipe and position record
2. Implement partial close logic in the exit monitor (the executor already supports partial exits via quantity comparison)
3. Track partial exits separately in the trade record for accurate analytics

---

### M-02: No Historical Data Population for Replay

**File:** `backend/src/modules/sim/replay.service.js` lines 218-238  
**Severity:** High  
**Description:** The replay service queries `historical_prices` table but there's no mechanism to populate it. The fallback is an empty array with a warning message. This makes the replay feature non-functional until someone manually loads data.

**Recommended Fix:**
1. Build an ingestion script that pulls historical candles from TwelveData/Polygon and stores them in `historical_prices`
2. Add a management endpoint or CLI command to trigger data backfill
3. Add an index on `(symbol, date)` for efficient range queries

---

### M-03: No Greeks Tracking During Position Lifetime

**File:** `backend/src/modules/sim/exit-monitor.js`, `sim_positions` schema  
**Severity:** Medium  
**Description:** The system records `delta_at_entry` but never updates Greeks during the position's lifetime. For options trades, delta, gamma, theta, and vega change continuously. The exit monitor uses the entry delta for portfolio Greeks calculations, which becomes increasingly inaccurate as the position ages and the underlying moves.

**Recommended Fix:**
1. When refreshing option prices (in `_estimateOptionPrice`), also refresh delta from chain data
2. Store current Greeks on the position record
3. Use live Greeks for portfolio-level risk calculations

---

### M-04: Single-Provider Dependency for Critical Data

**File:** `data-service/src/services/data-orchestrator.ts`  
**Severity:** Medium  
**Description:** The data service has failover for quotes/candles (TwelveData → Polygon), but critical market data has zero failover:
- **GEX:** Unusual Whales only — if UW API goes down, all GEX data stops
- **IV:** Unusual Whales only — if UW circuit breaker opens, IV data is stale
- **Options chains:** Unusual Whales only — no fallback (MarketData.app exists but isn't in the orchestrator)
- **VIX:** CBOE only
- **Macro:** FRED only

**Recommended Fix:**
1. Register MarketData.app as a secondary provider in the orchestrator for options chains
2. Add Polygon or another provider as IV fallback
3. Add a "provider health" dashboard that shows which providers are up/down and data freshness per type

---

### M-05: FRED and MarketData.app Providers Lack Circuit Breakers

**File:** `data-service/src/providers/fred-client.ts`, `data-service/src/providers/marketdata/client.ts`  
**Severity:** Medium  
**Description:** The FRED client and MarketData.app client have no circuit breaker or rate limiter configured. If these APIs start returning errors, the data service will continue hammering them indefinitely, potentially getting the API key banned.

**Recommended Fix:**
1. Add circuit breaker configuration (threshold: 3, reset: 120s) to both providers
2. Add rate limiting (FRED: 120/min, MarketData.app: check their docs)

---

## 4. ROBUSTNESS GAPS

Race conditions, unhandled edge cases, missing error handling, no retry logic, stale data risks.

---

### R-01: Notification Errors Silently Swallowed Throughout Pipeline

**File:** `backend/src/modules/sim/webhook-processor.js` lines 80, 92, 105, 114, 259, 272, 281  
**Severity:** High  
**Description:** All notification calls use `.catch(() => {})`:
```js
NotificationService.sendSimSignalNotification(...).catch(() => {});
```
This silently discards all notification delivery failures. If the notification service is misconfigured or down, no alerts, no logs, no metrics — the system appears healthy while users receive zero notifications.

**Impact:** Users won't know trades are being executed or rejected, which is critical for monitoring system behavior during paper trading.

**Recommended Fix:**
1. Replace `.catch(() => {})` with `.catch(err => logger.warn('Notification failed: ' + err.message, 'webhook-processor'))`
2. Add a notification delivery success/failure metric
3. The same pattern exists in `exit-monitor.js` line 556 and `executor.js` line 476

---

### R-02: No Timeout on Data Service Proxy Calls

**File:** `backend/src/services/dataServiceProxy.js` (referenced throughout pipeline)  
**Severity:** High  
**Description:** Multiple pipeline stages call the data service proxy without visible timeout handling:
- `dataServiceProxy.getOptionsChain()` — called in decision-router, exit-monitor, options-constructor
- `dataServiceProxy.getQuote()` — called in decision-router, exit-monitor
- `dataServiceProxy.getHistoricalRegime()` — called in decision-router, exit-monitor

If the data service hangs (e.g., stuck on a provider API call), the entire trade pipeline hangs for that request. The webhook processor's polling loop will also stall.

**Impact:** A single data service hang can freeze all trade processing.

**Recommended Fix:**
1. Add request-level timeouts (e.g., 5s for quotes, 10s for chains) to the data service proxy
2. Wrap calls in `Promise.race` with a timeout
3. Return null/cached data on timeout and continue with degraded state

---

### R-03: Daily PnL Reset Logic Is Duplicated Across 4 Modules

**Files:** `safety-guards.js`, `adaptive-guards.js`, `trade-decision-engine.js`, `executor.js`  
**Severity:** Medium  
**Description:** The "is this a new trading day?" check is copy-pasted across four files:
```js
const isStaleDay = accountState.daily_pnl_reset_at
  && getETDate() > String(accountState.daily_pnl_reset_at).slice(0, 10);
const effectiveDailyPnl = isStaleDay ? 0 : (accountState.daily_pnl || 0);
```
If the date comparison logic needs updating (e.g., handling holidays, half-days), it must be changed in four places. Any inconsistency would cause some guards to block while others allow, creating unpredictable behavior.

**Impact:** Maintenance burden and risk of inconsistent daily PnL calculations across guards.

**Recommended Fix:**
1. Centralize into a utility function: `getEffectiveDailyPnl(accountState)` in a shared module
2. Consider storing the reset timestamp in UTC and comparing consistently

---

### R-04: Replay Deletes ALL Open Positions on Restore

**File:** `backend/src/modules/sim/replay.service.js` lines 166-168  
**Severity:** High  
**Description:** After replay completes, `_restoreAccountState` runs:
```js
await db.query(`DELETE FROM sim_positions WHERE user_id = $1 AND status = 'OPEN'`, [userId]);
```
This deletes ALL open positions for the user, not just positions created during the replay. If a live webhook creates a new position while a replay is running (they share the same account), the live position gets deleted during restore.

**Impact:** Loss of live position tracking. In a real trading scenario, this could mean the system loses track of a real open position.

**Recommended Fix:**
1. Tag replay-created positions with a `sim_run_id` and only delete those on restore
2. Or use a completely separate account state for replay (create a temporary user context)
3. Add a mutex/lock that prevents live trading during replay

---

### R-05: Options Constructor Chain Snapshot Fallback Has No Staleness Check

**File:** `backend/src/modules/sim/options-constructor.service.js` lines 158-179  
**Severity:** Medium  
**Description:** When live chain data is unavailable, the options constructor falls back to the most recent `CHAIN_SNAPSHOT` from `market_data_events`:
```js
const snap = await db.query(
  `SELECT raw_payload FROM market_data_events
   WHERE symbol = $1 AND event_type = 'CHAIN_SNAPSHOT'
   ORDER BY received_at DESC LIMIT 1`,
  [symbol]
);
```
There's no check on how old this snapshot is. It could be from days ago, with completely stale strikes, expirations, and Greeks.

**Recommended Fix:**
1. Add a `received_at > NOW() - INTERVAL '30 minutes'` filter to the query
2. If only stale snapshots exist, fall to synthetic construction (which is already marked accordingly)

---

## 5. DATA INTEGRITY

Database schema issues, missing validations, potential for orphaned records or inconsistent state.

---

### D-01: Orphaned Position Detection Uses Unreliable Join

**File:** `backend/src/modules/sim/exit-monitor.js` lines 573-588  
**Severity:** Medium  
**Description:** The reconciliation logic detects orphaned positions by joining `sim_positions` with `sim_orders` on `webhook_event_id`:
```sql
SELECT p.id FROM sim_positions p
LEFT JOIN sim_orders o ON o.webhook_event_id = p.webhook_event_id AND o.status = 'FILLED'
WHERE p.status = 'OPEN' AND o.id IS NULL
```
But exit-monitor-generated CLOSE orders use the **original position's** `webhook_event_id`, not a new one. Positions opened by the exit monitor's `_triggerExit` (which creates new orders) will correctly have matching orders. However, partial exits create new position records (in `executor._updatePosition`) that may not have a matching BUY order with the same `webhook_event_id`, causing them to appear as orphans.

**Impact:** False-positive orphan detection could trigger unnecessary alarms in reconciliation logs.

**Recommended Fix:**
1. Use `position_id` or `order_id` as the join key instead of `webhook_event_id`
2. Add a `source_order_id` column to `sim_positions` for reliable lineage tracking

---

### D-02: Equity Calculation During Trade Exit May Drift

**File:** `backend/src/modules/sim/executor.js` lines 426-452  
**Severity:** Medium  
**Description:** The equity update during trade exit is computed inline:
```sql
equity = cash_balance + $2 - $3 + unrealized_pnl
```
In PostgreSQL, `cash_balance` in this expression refers to the **pre-update** value. While this is mathematically equivalent to `new_cash + unrealized_pnl`, the `unrealized_pnl` value used is also from the pre-update row. If the just-closed position's unrealized PnL was included in `unrealized_pnl`, the equity will be temporarily incorrect until the exit monitor's `_refreshUnrealizedPnl` runs.

The peak equity and max drawdown updates (lines 455-460) run in a separate UPDATE against the already-updated values, so they should be correct.

**Impact:** Brief equity inconsistency between trade close and the next unrealized PnL refresh cycle (up to 15 seconds). Could cause the kill switch to trigger or not trigger based on slightly stale equity.

**Recommended Fix:**
1. Subtract the closed position's unrealized PnL from the calculation:
   `equity = (cash_balance + exit_proceeds - commission) + (unrealized_pnl - closed_position_unrealized_pnl)`
2. Or trigger `_refreshUnrealizedPnl` immediately after trade close instead of waiting for the next cycle

---

### D-03: Migration Script Path Mismatch

**File:** `backend/scripts/run-migration.js`, `backend/scripts/migrate.js`  
**Severity:** Low  
**Description:** Some migration runner scripts reference `src/migrations` which doesn't exist. The actual migrations directory is `backend/migrations/`. The working migration runner in `src/utils/migrate.js` uses the correct path.

**Impact:** Migration scripts may fail if the wrong one is invoked, though the correct one appears to be in active use.

**Recommended Fix:**
1. Update or remove the broken scripts to prevent confusion

---

## 6. OBSERVABILITY GAPS

Missing logging, metrics, or alerting that would make it impossible to diagnose issues in production.

---

### O-01: Error Handler Does Not Report to Sentry

**File:** `backend/src/middleware/errorHandler.js`  
**Severity:** High  
**Description:** The Express error handler middleware imports Sentry but never calls `Sentry.captureException`. All unhandled Express errors are only logged via `console.error(err.stack)`. Since the sim pipeline modules individually capture to Sentry, this mainly affects errors in non-sim HTTP endpoints, but any unhandled error in the API layer goes unreported.

**Recommended Fix:**
1. Add `Sentry.captureException(err)` before the response is sent
2. Consider using Sentry's Express error handler middleware: `app.use(Sentry.Handlers.errorHandler())`

---

### O-02: No Pipeline Throughput Metrics

**File:** Entire sim pipeline  
**Severity:** High  
**Description:** There are no quantitative metrics (Prometheus, StatsD, DataDog) tracking:
- Signals received per minute, by indicator source
- Rejection rate by guard type (safety, adaptive, strategy gate, conviction, expected move)
- Average pipeline latency (webhook received → order filled)
- Position P&L distribution
- Guard effectiveness (how many rejections were correct vs. missed profitable trades)
- Data service response times and error rates

Without these metrics, it's impossible to answer questions like "why did trading stop?" or "which guard is rejecting the most signals?" without reading logs line by line.

**Recommended Fix:**
1. Add a metrics service (Prometheus counters/histograms via `prom-client`)
2. Track: `signals_received_total{source}`, `signals_rejected_total{guard}`, `orders_filled_total{strategy}`, `pipeline_latency_seconds`, `position_pnl_dollars`
3. Expose `/metrics` endpoint for Prometheus scraping

---

### O-03: No Operator Alert on Kill Switch Activation

**File:** `backend/src/modules/sim/executor.js` lines 470-477  
**Severity:** Medium  
**Description:** When the kill switch auto-activates due to daily loss exceeding the limit, a user notification is sent but there's no server-side alert for the system operator. In production, the operator needs to know immediately that trading has halted.

**Recommended Fix:**
1. Add a Slack/PagerDuty webhook call when the kill switch activates
2. Log at `FATAL` level so log-based alerting picks it up
3. Add a `/health` check that includes kill switch status per user

---

### O-04: Data Service Poller Failures Are Not Surfaced

**File:** `data-service/src/workers/*.ts`  
**Severity:** Medium  
**Description:** If a poller fails (e.g., GEX poller throws an error), it logs the error and continues to the next cycle. But there's no mechanism to detect that a poller has been failing for an extended period. The `market-context.service.js` will serve increasingly stale data without any indication that the poller is broken.

The health endpoint shows worker status but doesn't track consecutive failures or data freshness.

**Recommended Fix:**
1. Add a `last_success_at` timestamp per worker to the health endpoint
2. Alert if any worker hasn't succeeded in > 3x its normal interval
3. Add a `data_freshness_seconds` metric per data type

---

## 7. PROFITABILITY READINESS CHECKLIST

A concrete, ordered checklist of what must be built, fixed, or validated before the system can be trusted to trade profitably.

---

### Phase 1: Critical Fixes (Block Real Trading Until Complete)

- [ ] **C-03: Add webhook authentication** — HMAC verification or mandatory API key for all webhook endpoints
- [ ] **C-02: Wire market intelligence into pipeline** or merge its unique checks (confluence, price action) into the trade-decision-engine
- [ ] **C-05: Add staleness checks to market context queries** — reject data older than configured thresholds
- [ ] **C-04: Fix exit monitor race condition** — wrap status check + close in a transaction
- [ ] **C-06: Re-validate guards before execution** in `processPending` to prevent over-allocation
- [ ] **L-01: Fix credit spread stop-loss direction** — differentiate bull put vs bear call spreads
- [ ] **R-01: Replace silent notification `.catch(() => {})` blocks** with warning-level logging
- [ ] **R-02: Add timeouts to data service proxy calls** — 5s quotes, 10s chains
- [ ] **R-04: Fix replay position deletion** — only delete replay-created positions on restore
- [ ] **O-01: Wire Sentry into the Express error handler**

### Phase 2: Data Quality & Guard Validation

- [ ] Add staleness detection for all data service pollers (alert on 3x interval failure)
- [ ] Verify GEX/IV/flow data accuracy by comparing data service snapshots to manual spot checks on UW/CBOE websites
- [ ] Validate that chain data strikes/expirations match actual market (test with SPY, QQQ, TSLA)
- [ ] Verify commission model: $0.65/contract matches target broker (Schwab, TOS, IBKR)
- [ ] Verify slippage model: compare simulated fills to historical bid-ask spread data for representative trades
- [ ] Validate DTE bucket exposure counting query against actual open positions
- [ ] Add circuit breakers for FRED and MarketData.app providers

### Phase 3: Strategy Validation (Minimum Backtest Requirements)

- [ ] **Fix the replay engine** (C-01) to produce reliable backtests
- [ ] Populate `historical_prices` with at least 2 years of daily data for all traded symbols
- [ ] Run backtests for each strategy (SIGNALS, STRAT, ORB, PIVOT_MB, SQUEEZE_PRO) across:
  - Bull market (2023-2024)
  - Bear market (2022 Q1-Q3)
  - Choppy/range-bound (2023 Q3)
  - High-volatility events (FOMC, earnings)
- [ ] **Minimum thresholds per strategy to proceed:**
  - Win rate > 45% (40% minimum for high R:R strategies like REVSTRAT)
  - Profit factor > 1.3
  - Max drawdown < 15% of account
  - Sharpe ratio > 0.5
  - At least 50 trades in the backtest
- [ ] Document backtest results with equity curve, drawdown curve, and trade distribution

### Phase 4: Position Sizing & Risk Validation

- [ ] Verify `risk-scaler.js` HV percentile scaling against historical volatility data
- [ ] Validate that max position size never exceeds 5% of account equity for any single trade
- [ ] Verify that portfolio Greeks guard correctly limits net delta exposure
- [ ] Test the kill switch activation and deactivation flow end-to-end
- [ ] Validate that the drawdown throttle correctly reduces position sizes as daily loss accumulates
- [ ] Ensure the correlation guard correctly limits sector exposure (test with correlated baskets like NVDA+AMD+INTC)

### Phase 5: Paper Trading (Recommended: 3-6 Months Minimum)

- [ ] Deploy to production with **sim mode only** (TRADING_MODE=SIM is already enforced)
- [ ] Run for at least 90 trading days with live market data
- [ ] Monitor daily:
  - Signals received vs. trades executed (rejection rate by guard)
  - Average conviction score of executed vs. rejected trades
  - Simulated P&L curve and drawdown
  - Data freshness across all providers
  - Error rates in Sentry
  - Kill switch activations
- [ ] Weekly review:
  - Strategy scorecard per strategy
  - Guard effectiveness analysis (was each rejection correct?)
  - Temporal edge analysis (are there time-of-day patterns?)
  - Regime edge analysis (does strategy switch correctly?)
- [ ] **Proceed to live only if:**
  - 90-day simulated Sharpe > 0.5
  - Max drawdown < 10% of account
  - No kill switch activations in last 30 days
  - All data providers have > 99% uptime
  - No critical bugs found in last 30 days

### Phase 6: Initial Live Trading (Start Small)

- [ ] Start with 10% of intended capital
- [ ] Limit to 1-2 positions maximum
- [ ] Run live alongside sim and compare fills (sim vs. real)
- [ ] Monitor slippage: if real slippage > 2x simulated, stop and recalibrate
- [ ] Monitor fill rate: if > 10% of orders fail to fill, investigate
- [ ] Scale up gradually: 25% → 50% → 75% → 100% of capital over 4-8 weeks
- [ ] Key metrics to monitor during initial live:
  - Real fill price vs. simulated fill price (slippage accuracy)
  - Order rejection rate from broker
  - Execution latency (signal → fill)
  - Real vs. simulated P&L divergence
  - Commission accuracy

---

*End of Audit Report*
