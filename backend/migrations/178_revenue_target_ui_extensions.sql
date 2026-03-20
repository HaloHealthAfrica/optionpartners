-- Revenue Target UI extensions: decision log, override, configurable sizer, close-leg exemption

-- Extend config with new settings
ALTER TABLE revenue_target_config
  ADD COLUMN IF NOT EXISTS exempt_close_legs BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS scale_back_1_pct NUMERIC(5,2) NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS scale_back_2_pct NUMERIC(5,2) NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS aggressive_max NUMERIC(5,2) NOT NULL DEFAULT 1.25,
  ADD COLUMN IF NOT EXISTS aggressive_cap NUMERIC(5,2) NOT NULL DEFAULT 1.5;

-- Override gate until (session override - allows trades past limit until this timestamp)
ALTER TABLE revenue_target_config
  ADD COLUMN IF NOT EXISTS override_gate_until TIMESTAMPTZ;

-- Track override usage in daily history
ALTER TABLE revenue_target_daily
  ADD COLUMN IF NOT EXISTS override_used BOOLEAN NOT NULL DEFAULT FALSE;

-- Decision log for audit trail (gate/sizer decisions per trade)
CREATE TABLE IF NOT EXISTS revenue_target_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol VARCHAR(20),
  action VARCHAR(20),
  instrument_desc TEXT,
  decision VARCHAR(20) NOT NULL CHECK (decision IN ('ALLOWED', 'BLOCKED')),
  reason TEXT,
  size_multiplier NUMERIC(6,2),
  trade_id UUID,
  webhook_event_id UUID REFERENCES webhook_events(id)
);

CREATE INDEX IF NOT EXISTS idx_revenue_target_decisions_user_time
  ON revenue_target_decisions (user_id, created_at DESC);
