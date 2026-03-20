-- Migration 183: Reversal Indicator options recipes — credit spreads per guide.
-- Bullish → sell put spread; Bearish → sell call spread.

INSERT INTO strategy_trade_recipe (user_id, strategy, direction, contract_type, target_dte, target_delta, spread_width)
SELECT v.user_id, v.strategy, v.direction, v.contract_type, v.target_dte, v.target_delta, v.spread_width
FROM (VALUES
  (NULL::uuid, 'reversal_eme', 'long', 'CREDIT_SPREAD', 7, 0.25, 5.00),
  (NULL::uuid, 'reversal_eme', 'short', 'CREDIT_SPREAD', 7, 0.25, 5.00),
  (NULL::uuid, 'reversal_spe', 'long', 'CREDIT_SPREAD', 7, 0.25, 5.00),
  (NULL::uuid, 'reversal_spe', 'short', 'CREDIT_SPREAD', 7, 0.25, 5.00),
  (NULL::uuid, 'reversal_strat', 'long', 'CREDIT_SPREAD', 7, 0.25, 5.00),
  (NULL::uuid, 'reversal_strat', 'short', 'CREDIT_SPREAD', 7, 0.25, 5.00),
  (NULL::uuid, 'reversal', 'long', 'CREDIT_SPREAD', 7, 0.25, 5.00),
  (NULL::uuid, 'reversal', 'short', 'CREDIT_SPREAD', 7, 0.25, 5.00)
) AS v(user_id, strategy, direction, contract_type, target_dte, target_delta, spread_width)
WHERE NOT EXISTS (
  SELECT 1 FROM strategy_trade_recipe r
  WHERE (r.user_id IS NOT DISTINCT FROM v.user_id)
    AND r.strategy = v.strategy
    AND r.direction = v.direction
);
