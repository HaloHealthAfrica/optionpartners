-- Strat Plan Engine v2: lifecycle tracking and enriched pattern data
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS plan_id VARCHAR(100);
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS event_type VARCHAR(30) DEFAULT 'PLAN_CREATED';
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS pattern VARCHAR(100);
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS pattern_kind VARCHAR(30);
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS bias VARCHAR(20);
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS continuity BOOLEAN;
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS htf VARCHAR(10);
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS ltf VARCHAR(10);
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS ctf VARCHAR(10);
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS htf_candle VARCHAR(10);
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS htf_candle_prev VARCHAR(10);
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS ctf_candle VARCHAR(10);
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS target2 NUMERIC(12,4);
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS atr NUMERIC(12,4);
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS open_condition JSONB;
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS expiry_ltf_bars INTEGER;
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS market_data JSONB;
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'PLANNED';
ALTER TABLE strat_alerts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Lifecycle tracking: find/update plans by plan_id
CREATE INDEX IF NOT EXISTS idx_strat_alerts_plan_id
  ON strat_alerts (plan_id) WHERE plan_id IS NOT NULL;

-- Filter by status (active plans, triggered, etc.)
CREATE INDEX IF NOT EXISTS idx_strat_alerts_status
  ON strat_alerts (user_id, status, created_at DESC);
