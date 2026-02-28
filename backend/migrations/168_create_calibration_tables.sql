-- Stores the currently active calibrated conviction weights
CREATE TABLE IF NOT EXISTS calibration_weights (
  id            SERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  component_key VARCHAR(50) NOT NULL,
  static_weight INTEGER NOT NULL,
  calibrated_weight INTEGER NOT NULL,
  weight_drift  INTEGER NOT NULL DEFAULT 0,
  sample_size   INTEGER NOT NULL DEFAULT 0,
  win_rate_lift NUMERIC(8,2) DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  calibrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, component_key)
);

-- Audit trail of every calibration event
CREATE TABLE IF NOT EXISTS calibration_log (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action          VARCHAR(30) NOT NULL,
  trigger_type    VARCHAR(30) NOT NULL,
  trade_count     INTEGER NOT NULL DEFAULT 0,
  weights_before  JSONB,
  weights_after   JSONB,
  summary         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calibration_weights_user ON calibration_weights(user_id);
CREATE INDEX IF NOT EXISTS idx_calibration_log_user ON calibration_log(user_id, created_at DESC);

-- Auto-calibration toggle + threshold config stored in existing sim_intelligence_config
ALTER TABLE sim_intelligence_config
  ADD COLUMN IF NOT EXISTS auto_calibration_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS calibration_trade_threshold INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS trades_since_last_calibration INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_calibration_at TIMESTAMPTZ;
