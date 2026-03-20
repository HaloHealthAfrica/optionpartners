-- Migration 182: Reversal Indicator strat setups — store STRAT_SETUP for STRAT_TRIGGER matching.
-- STRAT_SETUP is stored; STRAT_TRIGGER matches setup_id before executing trade.

CREATE TABLE IF NOT EXISTS reversal_strat_setups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setup_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  pattern TEXT,
  timeframe TEXT,
  trigger_level NUMERIC(14,4),
  setup_low NUMERIC(14,4),
  expects_trigger BOOLEAN DEFAULT TRUE,
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reversal_strat_setups_lookup
  ON reversal_strat_setups (setup_id, user_id);
CREATE INDEX IF NOT EXISTS idx_reversal_strat_setups_expires
  ON reversal_strat_setups (expires_at) WHERE expires_at IS NOT NULL;
