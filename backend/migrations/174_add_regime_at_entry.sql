ALTER TABLE sim_trades
  ADD COLUMN IF NOT EXISTS regime_at_entry VARCHAR(64),
  ADD COLUMN IF NOT EXISTS regime_source VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_sim_trades_regime_at_entry
  ON sim_trades (regime_at_entry)
  WHERE regime_at_entry IS NOT NULL;
