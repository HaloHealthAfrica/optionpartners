-- ============================================================================
-- SQL INSPECTION PACK — TradePartners / TradeTally
-- Run against production Postgres. DO NOT run repair queries without review.
-- ============================================================================

-- ─── 1. Market data events by user_id, type, symbol (last 30 days) ──────────
SELECT
  user_id,
  indicator_source AS type,
  raw_payload->>'symbol' AS symbol,
  COUNT(*) AS event_count,
  MIN(received_at) AS earliest,
  MAX(received_at) AS latest,
  COUNT(*) FILTER (WHERE status = 'PROCESSED') AS processed,
  COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected,
  COUNT(*) FILTER (WHERE status = 'DEAD_LETTER') AS dead_letter
FROM webhook_events
WHERE received_at >= NOW() - INTERVAL '30 days'
  AND indicator_source IN ('PRICE_TICK', 'CHAIN_SNAPSHOT', 'OPTIONS_FLOW', 'MARKET_CONTEXT')
GROUP BY user_id, indicator_source, raw_payload->>'symbol'
ORDER BY user_id, indicator_source, event_count DESC;


-- ─── 2. Symbol state freshness by user_id and symbol ────────────────────────
SELECT
  user_id,
  symbol,
  macro_bias,
  regime,
  last_price,
  EXTRACT(EPOCH FROM (NOW() - price_updated_at)) / 60 AS price_age_min,
  chain_ok,
  EXTRACT(EPOCH FROM (NOW() - chain_updated_at)) / 60 AS chain_age_min,
  EXTRACT(EPOCH FROM (NOW() - macro_updated_at)) / 60 AS macro_age_min,
  EXTRACT(EPOCH FROM (NOW() - local_updated_at)) / 60 AS local_age_min,
  updated_at
FROM symbol_state
ORDER BY user_id, symbol;


-- ─── 3. Global market state health check ────────────────────────────────────
SELECT
  symbol,
  last_price,
  price_source,
  EXTRACT(EPOCH FROM (NOW() - price_updated_at)) / 60 AS price_age_min,
  chain_ok,
  chain_contracts_count,
  chain_source,
  EXTRACT(EPOCH FROM (NOW() - chain_updated_at)) / 60 AS chain_age_min,
  price_fetch_failures,
  chain_fetch_failures,
  last_price_error,
  last_chain_error
FROM global_market_state
ORDER BY symbol;


-- ─── 4. Trades with duration < 60s and extreme PnL ─────────────────────────
SELECT
  id,
  user_id,
  symbol,
  contract_type,
  strategy,
  entry_price,
  exit_price,
  pnl,
  pnl_percent,
  entry_time,
  exit_time,
  EXTRACT(EPOCH FROM (exit_time - entry_time)) AS duration_sec,
  exit_reason
FROM sim_trades
WHERE EXTRACT(EPOCH FROM (exit_time - entry_time)) < 60
   OR ABS(pnl_percent) > 50
ORDER BY entry_time DESC;


-- ─── 5. Strategy cooldown sliding window analysis ───────────────────────────
SELECT
  sc.user_id,
  sc.strategy,
  sc.consecutive_losses,
  sc.cooldown_until,
  sc.reason,
  sc.created_at,
  CASE WHEN sc.cooldown_until > NOW() THEN 'ACTIVE' ELSE 'EXPIRED' END AS status,
  (SELECT COUNT(*) FROM sim_trades t
   WHERE t.user_id = sc.user_id AND t.strategy = sc.strategy
     AND t.pnl < 0 AND t.exit_time > sc.created_at - INTERVAL '24 hours'
  ) AS recent_losses_24h
FROM strategy_cooldowns sc
ORDER BY sc.created_at DESC
LIMIT 50;


-- ─── 6. Strategy scorecard current state ────────────────────────────────────
SELECT
  user_id,
  strategy,
  total_trades,
  winning_trades,
  losing_trades,
  ROUND(win_rate * 100, 1) AS win_rate_pct,
  ROUND(profit_factor, 2) AS profit_factor,
  ROUND(total_pnl, 2) AS total_pnl,
  ROUND(avg_pnl, 2) AS avg_pnl,
  ROUND(max_drawdown, 2) AS max_drawdown,
  ROUND(avg_winner, 2) AS avg_winner,
  ROUND(avg_loser, 2) AS avg_loser,
  updated_at
FROM strategy_scorecard
ORDER BY user_id, strategy;


-- ─── 7. Account state per user ──────────────────────────────────────────────
SELECT
  user_id,
  ROUND(cash_balance, 2) AS cash,
  ROUND(equity, 2) AS equity,
  ROUND(buying_power, 2) AS buying_power,
  ROUND(unrealized_pnl, 2) AS unrealized,
  ROUND(daily_pnl, 2) AS daily_pnl,
  ROUND(peak_equity, 2) AS peak_equity,
  ROUND(max_drawdown, 2) AS max_drawdown,
  total_trades,
  winning_trades,
  losing_trades,
  updated_at
FROM sim_account_state
ORDER BY user_id;


-- ─── 8. Open positions ─────────────────────────────────────────────────────
SELECT
  id,
  user_id,
  symbol,
  underlying_symbol,
  contract_type,
  strategy,
  quantity,
  avg_price,
  current_price,
  stop_loss,
  take_profit,
  opened_at,
  EXTRACT(EPOCH FROM (NOW() - opened_at)) / 3600 AS hours_open,
  exit_reason
FROM sim_positions
WHERE status = 'OPEN'
ORDER BY opened_at;


-- ─── 9. Recent webhook processing errors ────────────────────────────────────
SELECT
  id,
  user_id,
  indicator_source,
  status,
  error_message,
  retry_count,
  raw_payload->>'symbol' AS symbol,
  received_at
FROM webhook_events
WHERE status IN ('REJECTED', 'DEAD_LETTER')
  AND received_at >= NOW() - INTERVAL '7 days'
ORDER BY received_at DESC
LIMIT 50;


-- ─── 10. Cross-user chain data comparison ──────────────────────────────────
-- Shows whether chain data reached all 3 users or just one
SELECT
  symbol,
  user_id,
  chain_ok,
  chain_updated_at,
  EXTRACT(EPOCH FROM (NOW() - chain_updated_at)) / 60 AS chain_age_min,
  chain_open_interest,
  chain_volume
FROM symbol_state
WHERE symbol IN ('SPY', 'QQQ', 'IWM')
ORDER BY symbol, user_id;


-- ============================================================================
-- REPAIR QUERIES (DO NOT RUN WITHOUT EXPLICIT APPROVAL)
-- ============================================================================

-- ─── R1. Mark instant-exit trades as INVALID_PRICING ─────────────────────────
-- UPDATE sim_trades
-- SET exit_reason = COALESCE(exit_reason, '') || ' [INVALID_PRICING]'
-- WHERE EXTRACT(EPOCH FROM (exit_time - entry_time)) < 30
--   AND ABS(pnl_percent) > 50;

-- ─── R2. Exclude INVALID_PRICING trades from scorecard recalculation ─────────
-- These trades should not count toward win rate or profit factor.
-- After marking, re-run scorecard recalculation:
-- SELECT DISTINCT user_id, strategy FROM sim_trades WHERE exit_reason LIKE '%INVALID_PRICING%';
-- Then call strategyScorecardService.recalculate(userId, strategy) for each.

-- ─── R3. Clear all expired strategy cooldowns ───────────────────────────────
-- DELETE FROM strategy_cooldowns WHERE cooldown_until <= NOW();

-- ─── R4. Reset strategy cooldowns after data-service fix ────────────────────
-- DELETE FROM strategy_cooldowns;

-- ─── R5. Backfill global_market_state with current symbol_state data ────────
-- INSERT INTO global_market_state (symbol, last_price, price_updated_at, chain_ok, chain_updated_at)
-- SELECT DISTINCT ON (symbol)
--   symbol, last_price, price_updated_at, chain_ok, chain_updated_at
-- FROM symbol_state
-- WHERE last_price IS NOT NULL
-- ORDER BY symbol, updated_at DESC
-- ON CONFLICT (symbol) DO UPDATE SET
--   last_price = EXCLUDED.last_price,
--   price_updated_at = EXCLUDED.price_updated_at,
--   chain_ok = EXCLUDED.chain_ok,
--   chain_updated_at = EXCLUDED.chain_updated_at,
--   updated_at = NOW();

-- ─── R6. Prune old data_service_health_log entries ──────────────────────────
-- DELETE FROM data_service_health_log WHERE created_at < NOW() - INTERVAL '7 days';
