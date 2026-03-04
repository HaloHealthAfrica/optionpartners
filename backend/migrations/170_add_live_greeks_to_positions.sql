-- Live Greeks tracking on open positions.
-- Updated each exit-monitor cycle from chain data so downstream
-- (exit logic, analytics, dashboard) can reason about option risk.

ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS live_delta NUMERIC(8,5);
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS live_gamma NUMERIC(8,5);
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS live_theta NUMERIC(8,5);
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS live_vega  NUMERIC(8,5);
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS live_iv    NUMERIC(8,5);
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS greeks_updated_at TIMESTAMP WITH TIME ZONE;
