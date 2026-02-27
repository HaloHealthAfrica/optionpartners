-- Migration 161: Per-symbol rolling state for deterministic trade decisions.
-- Every webhook type updates this state; trades execute from state evaluation.

CREATE TABLE IF NOT EXISTS symbol_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,

  -- Macro context (from MTF_BIAS)
  macro_bias TEXT DEFAULT 'NEUTRAL' CHECK (macro_bias IN ('BULLISH', 'BEARISH', 'NEUTRAL')),
  macro_strength NUMERIC(6,2) DEFAULT 0,
  regime TEXT CHECK (regime IN ('TREND', 'CHOP', 'EXPANSION', 'CONTRACTION', NULL)),
  volatility_state TEXT,
  room_to_resistance TEXT CHECK (room_to_resistance IN ('HIGH', 'MODERATE', 'LOW', NULL)),
  room_to_support TEXT CHECK (room_to_support IN ('HIGH', 'MODERATE', 'LOW', NULL)),
  previous_macro_bias TEXT,
  macro_updated_at TIMESTAMPTZ,

  -- Local context (from TREND dots)
  local_bias TEXT DEFAULT 'NEUTRAL' CHECK (local_bias IN ('BULLISH', 'BEARISH', 'NEUTRAL')),
  local_strength NUMERIC(6,2) DEFAULT 0,
  alignment_score NUMERIC(6,2) DEFAULT 0,
  conflict_score NUMERIC(6,2) DEFAULT 0,
  local_updated_at TIMESTAMPTZ,

  -- Price data (from PRICE_TICK)
  last_price NUMERIC(14,4),
  price_high NUMERIC(14,4),
  price_low NUMERIC(14,4),
  price_open NUMERIC(14,4),
  price_volume BIGINT,
  atr NUMERIC(14,4),
  price_updated_at TIMESTAMPTZ,

  -- Chain state (from CHAIN_SNAPSHOT)
  liquidity_ok BOOLEAN DEFAULT FALSE,
  chain_ok BOOLEAN DEFAULT FALSE,
  iv_percentile NUMERIC(6,2),
  bid_ask_spread_pct NUMERIC(6,4),
  chain_open_interest INT,
  chain_volume INT,
  chain_updated_at TIMESTAMPTZ,

  -- Latest signal snapshots (JSONB for complex nested data)
  latest_entry_signal JSONB,
  latest_strat_signal JSONB,
  latest_orb_signal JSONB,
  latest_flow_signal JSONB,
  latest_macro_raw JSONB,

  entry_signal_at TIMESTAMPTZ,
  strat_signal_at TIMESTAMPTZ,
  orb_signal_at TIMESTAMPTZ,
  flow_signal_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_symbol_state_user ON symbol_state(user_id);
CREATE INDEX IF NOT EXISTS idx_symbol_state_lookup ON symbol_state(user_id, symbol);
