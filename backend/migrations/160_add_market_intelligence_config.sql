-- Migration 160: Market Intelligence configuration columns
-- Adds settings for confluence detection, flow alignment, confidence gating,
-- and price action validation to the per-user intelligence config.

ALTER TABLE sim_intelligence_config
  ADD COLUMN IF NOT EXISTS enable_confluence BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS require_confluence BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS confluence_window_minutes INT DEFAULT 30,
  ADD COLUMN IF NOT EXISTS min_confluence_signals INT DEFAULT 2,

  ADD COLUMN IF NOT EXISTS enable_flow_alignment BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS require_flow_alignment BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS flow_lookback_minutes INT DEFAULT 60,
  ADD COLUMN IF NOT EXISTS flow_min_premium NUMERIC(14,2) DEFAULT 50000,

  ADD COLUMN IF NOT EXISTS enable_confidence_gate BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS min_signal_confidence NUMERIC(6,2) DEFAULT 0,

  ADD COLUMN IF NOT EXISTS enable_price_validation BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS require_price_validation BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS price_max_entry_slippage_pct NUMERIC(6,4) DEFAULT 0.02,

  ADD COLUMN IF NOT EXISTS min_intelligence_score NUMERIC(6,2) DEFAULT 0;

-- Track intelligence verdicts for dashboard analytics
CREATE TABLE IF NOT EXISTS intelligence_verdicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  webhook_event_id UUID REFERENCES webhook_events(id),
  symbol TEXT NOT NULL,
  direction TEXT,
  strategy TEXT,
  intelligence_score NUMERIC(6,2) NOT NULL,
  allowed BOOLEAN NOT NULL,
  rejection_reason TEXT,
  confluence_count INT,
  flow_alignment TEXT,
  flow_bullish_ratio INT,
  signal_confidence NUMERIC(6,2),
  price_delta_pct NUMERIC(8,4),
  checks_detail JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intelligence_verdicts_user
  ON intelligence_verdicts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intelligence_verdicts_symbol
  ON intelligence_verdicts(symbol, created_at DESC);
