-- Relax max_trades_per_day constraint from 1-20 to 1-50 (matches config validation and UI)
ALTER TABLE revenue_target_config
  DROP CONSTRAINT IF EXISTS revenue_target_config_max_trades_per_day_check;

ALTER TABLE revenue_target_config
  ADD CONSTRAINT revenue_target_config_max_trades_per_day_check
  CHECK (max_trades_per_day >= 1 AND max_trades_per_day <= 50);
