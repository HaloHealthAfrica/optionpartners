-- Create strat_alerts table for structured STRAT signal tracking
CREATE TABLE IF NOT EXISTS strat_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  webhook_event_id UUID REFERENCES webhook_events(id) ON DELETE SET NULL,
  symbol VARCHAR(20) NOT NULL,
  direction VARCHAR(10), -- 'long' or 'short'
  score NUMERIC(6,2),
  entry NUMERIC(12,4),
  target NUMERIC(12,4),
  stop NUMERIC(12,4),
  setup VARCHAR(100),
  reversal_level NUMERIC(12,4),
  options_suggestion TEXT,
  condition_text TEXT,
  components JSONB DEFAULT '[]',
  timeframe VARCHAR(10),
  trend VARCHAR(20),
  engine VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strat_alerts_user_created
  ON strat_alerts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strat_alerts_symbol
  ON strat_alerts (symbol, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_strat_alerts_webhook_event
  ON strat_alerts (webhook_event_id) WHERE webhook_event_id IS NOT NULL;
