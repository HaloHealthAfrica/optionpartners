# Backtest Lab — Implementation Plan

> Replay historical webhooks through modified engine rules to validate changes before deployment.

This document extends the backtest engine design to explicitly integrate webhook strategies (STRAT, SIGNALS, REVERSAL, ORB, etc.) and their full pipeline flow.

---

## 1. Webhook Strategy Integration

### 1.1 Strategy Flow (Current System)

Strategies flow from webhook payload → decision pipeline as follows:

```
Webhook (raw payload)
    ↓
indicator-detector.detectIndicatorSource()  →  source (STRAT, SIGNALS, REVERSAL, etc.)
    ↓
normalizers[source].normalize()  →  normalized.strategy (e.g. "reversal_strat")
    ↓
mapIndicatorToSignal()  →  signal.strategy
    ↓
decision-router.evaluate()
    ├── SUPPRESSED_STRATEGIES check
    ├── strategyScorecardService.checkStrategyGate(signal.strategy)
    ├── tradeDecisionEngine.evaluate()
    ├── optionsConstructor.construct()  [strategy_trade_recipe lookup]
    └── executor  [stores strategy on order/position]
    ↓
sim_trades.strategy  →  strategy_scorecard  →  future strategy gate decisions
```

### 1.2 Supported Strategies (Indicator Sources)

| Source | Strategy Names | Trade Trigger | Notes |
|--------|----------------|---------------|-------|
| **STRAT** | `STRAT_PLAN`, `STRAT_ADAPTIVE_*`, setup patterns | Yes (when actionable levels) | Strat Plan Engine, Adaptive Strat |
| **SIGNALS** | `payload.pattern`, `payload.setup`, `SIGNALS` | Yes | Pattern-based signals |
| **ORB** | `ORB`, `Stretch`, `BHCH`, `EMA` | Yes | Opening range breakouts |
| **REVERSAL** | `reversal`, `reversal_eme`, `reversal_spe`, `reversal_strat` | Yes | EME, SPE, Strat Setup/Trigger |
| **CRT** | `crt_confluence` | Yes | Candle Range Theory |
| **SQUEEZE_PRO** | `squeeze_pro` | Yes | Squeeze Pro |
| **PIVOT_MB** | `pivot_motherbar` | Yes | Pivot Mother Bar |
| **MTF_BIAS** | `strat.pattern`, `MTF_BIAS` | Context only (exits) | Macro flip exits |
| **TREND** | `TREND_DOTS` | Context only | Trend alignment |
| **SATY_PHASE** | `SATY_PHASE` | Context only | Session phase |

### 1.3 Strategy-Dependent Components

| Component | Strategy Usage |
|-----------|----------------|
| **Strategy Gate** | `strategy_scorecard` — blocks if WR < 40% or PF < 1.0 (last N trades) |
| **Options Constructor** | `strategy_trade_recipe` — delta, DTE, spread width per strategy |
| **Reversal Strat Setup** | `reversal_strat_setups` — setup lifecycle for REVERSAL |
| **Suppression** | `SUPPRESSED_STRATEGIES` env — hard block by strategy name |

---

## 2. Backtest Engine Architecture (Updated)

### 2.1 Core Design

- **Replay source**: Historical webhooks from `webhook_events` (not synthetic candles)
- **Pipeline**: Same `decisionRouter.evaluate()` → `executor` → `tradeFinalizer` as live
- **Strategies**: All strategy logic (normalizers, recipes, gates) runs unchanged
- **Isolation**: Snapshot account → reset → replay → restore (no live state mutation)

### 2.2 Strategy-Specific Backtest Features

| Feature | Description |
|---------|-------------|
| **Strategy filter** | Run backtest for specific strategies (e.g. only `reversal_strat`, `squeeze_pro`) |
| **Indicator source filter** | Run for specific sources (e.g. only REVERSAL, STRAT) |
| **Strategy-level results** | PnL, WR, PF, trade count per strategy in backtest output |
| **Recipe override** | Test alternative `strategy_trade_recipe` configs without DB changes |
| **Gate bypass** | Option to bypass strategy gate for “what-if” (e.g. if gate were disabled) |

### 2.3 Webhook Replay Source

```sql
-- Query webhooks by date range and optional strategy/indicator filter
SELECT * FROM webhook_events
WHERE user_id = $1
  AND received_at >= $2 AND received_at <= $3
  AND (indicator_source = ANY($4) OR $4 IS NULL)
  AND (
    $5 IS NULL
    OR raw_payload->>'strategy' = ANY($5)
    OR raw_payload->>'pattern' = ANY($5)
    OR raw_payload->>'setup'->>'pattern' = ANY($5)
  )
ORDER BY received_at ASC
LIMIT $6;
```

- `indicator_source`: STRAT, SIGNALS, REVERSAL, ORB, CRT, SQUEEZE_PRO, PIVOT_MB
- Strategy filter: optional list of strategy names from normalizers

---

## 3. Implementation Phases

### Phase 1: Core Webhook Replay

1. **`webhook.service.getByDateRange(userId, startDate, endDate, options)`**
   - Options: `indicatorSources`, `strategies`, `limit`
   - Returns webhooks ordered by `received_at`

2. **`WebhookBacktestService`**
   - Load webhooks via `getByDateRange`
   - For each webhook: parse `raw_payload` → `decisionRouter.evaluate(payload, eventId, userId)`
   - Use existing `webhook-processor.processEvent()` logic but without notifications
   - Snapshot/restore account state (reuse replay.service pattern)
   - Persist run to `backtest_runs` or extended `sim_runs` with `run_type = 'webhook_backtest'`

3. **Historical fill prices**
   - Pre-fetch candles via `dataServiceProxy.getHistoricalCandles(symbol, '5m', start, end)`
   - For each webhook at `received_at`, find nearest candle → inject `bidPrice`, `askPrice`, `midPrice` into intent before executor
   - Executor prefers intent prices over live/cache

### Phase 2: Strategy Integration

4. **Strategy filter in backtest API**
   - `POST /api/sim/backtest` body:
     ```json
     {
       "startDate": "2025-01-01",
       "endDate": "2025-01-31",
       "indicatorSources": ["REVERSAL", "STRAT", "SIGNALS"],
       "strategies": ["reversal_strat", "squeeze_pro"],
       "config": {
         "bypassStrategyGate": false,
         "recipeOverrides": {}
       }
     }
     ```

5. **Strategy-level results**
   - Aggregate backtest output by `strategy`:
     - `total_trades`, `winning_trades`, `losing_trades`, `total_pnl`, `win_rate`, `profit_factor`
   - Return `by_strategy` array in response

6. **Recipe overrides (optional)**
   - Pass `recipeOverrides: { "reversal_strat": { "target_delta": 0.30 } }` to test config changes
   - Options constructor uses overrides when building intent (backtest-only path)

### Phase 3: Engine Rule Overrides

7. **Config overrides**
   - `minConviction`, `revenueTargetEnabled`, `SUPPRESSED_STRATEGIES` override
   - Pass `backtestOverrides` into `decisionRouter.evaluate()` and guards
   - Enables “what-if” validation before deployment

8. **Strategy gate bypass**
   - `bypassStrategyGate: true` → skip `strategyScorecardService.checkStrategyGate` in backtest
   - Useful to see raw performance without gate filtering

### Phase 4: Frontend (Backtest Lab UI)

9. **Backtest Lab tab** (replace placeholder in `AdaptiveIntelligenceView.vue`)
   - Date range picker
   - Multi-select: indicator sources (STRAT, SIGNALS, REVERSAL, ORB, CRT, SQUEEZE_PRO, PIVOT_MB)
   - Multi-select: strategies (populated from `strategy_trade_recipe` + recent `sim_trades.strategy`)
   - Checkbox: Bypass strategy gate
   - Optional: conviction threshold, revenue target toggle
   - Start backtest → poll run status → show results

10. **Results display**
    - Overall: total trades, PnL, WR, PF, max drawdown
    - By strategy: table with same metrics per strategy
    - Equity curve (reuse existing component if available)

---

## 4. Data Service Integration

| Data Need | Source | Strategy Relevance |
|-----------|--------|--------------------|
| Historical candles | `getHistoricalCandles(symbol, '5m', start, end)` | Fill prices for all strategies |
| Regime / IV | `getHistoricalRegime`, `getHistoricalIV` | Conviction, guards (STRAT, REVERSAL) |
| Options chain | Live only (no historical) | Options strategies: use synthetic or skip options in backtest |
| Symbol state | Rebuilt from webhooks in order | MTF_BIAS, TREND, STRAT context for each strategy |

---

## 5. Strategy-Specific Considerations

### 5.1 Context Ordering

Context sources (MTF_BIAS, TREND, SATY_PHASE, etc.) must be replayed **before** trade triggers for the same symbol. The existing `SOURCE_PRIORITY` in `webhook-processor.js` already orders by source. Backtest should:

1. Sort webhooks by `received_at` (preserves real ordering)
2. Within same timestamp, apply `SOURCE_PRIORITY` so context updates run before triggers

### 5.2 Reversal Strat Setups

`reversal_strat_setups` tracks setup lifecycle. During backtest:

- Replay STRAT_SETUP webhooks first so `reversal_strat_setups` is populated
- Then replay STRAT_TRIGGER so constructor has setup context
- Use same `reversal-strat-setup.service` — no changes needed if replay is chronological

### 5.3 Options Recipes

- `strategy_trade_recipe` is read by options constructor via `signal.strategy`
- Backtest uses same recipes unless `recipeOverrides` provided
- For strategies without recipes, constructor may fall back to synthetic (same as live)

### 5.4 Strategy Scorecard

- **Live**: Scorecard gates future trades
- **Backtest**: Option A — use live scorecard (realistic). Option B — bypass for “clean slate” evaluation
- Recommend: default to live scorecard; `bypassStrategyGate` for what-if

---

## 6. Database Schema

### 6.1 Backtest Runs (new or extend sim_runs)

```sql
-- Option: extend sim_runs
ALTER TABLE sim_runs ADD COLUMN IF NOT EXISTS run_type VARCHAR(20) DEFAULT 'candle_replay';
-- run_type: 'candle_replay' | 'webhook_backtest'

-- Option: new table
CREATE TABLE backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  indicator_sources TEXT[],
  strategies TEXT[],
  config_snapshot JSONB,
  status VARCHAR(20) NOT NULL,
  total_trades INT DEFAULT 0,
  winning_trades INT DEFAULT 0,
  losing_trades INT DEFAULT 0,
  total_pnl NUMERIC DEFAULT 0,
  win_rate NUMERIC DEFAULT 0,
  profit_factor NUMERIC,
  max_drawdown NUMERIC,
  by_strategy JSONB,  -- [{ strategy, trades, pnl, win_rate, profit_factor }, ...]
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
```

---

## 7. API Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /api/sim/backtest` | POST | Start webhook backtest |
| `GET /api/sim/backtest/:id` | GET | Get backtest run status/results |
| `GET /api/sim/backtest` | GET | List user's backtest runs |
| `GET /api/sim/strategies` | GET | List strategies (for filter dropdown) — from `strategy_trade_recipe` + `sim_trades` |

---

## 8. Success Criteria

- [ ] Replay historical webhooks through full decision pipeline
- [ ] All strategy types (STRAT, SIGNALS, REVERSAL, ORB, CRT, SQUEEZE_PRO, PIVOT_MB) supported
- [ ] Strategy and indicator source filters work
- [ ] Results broken down by strategy
- [ ] Historical fill prices from candles
- [ ] Optional engine overrides (conviction, gate bypass, recipe overrides)
- [ ] Backtest Lab UI in Adaptive Intelligence tab
