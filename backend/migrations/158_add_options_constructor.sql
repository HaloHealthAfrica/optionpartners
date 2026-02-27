-- Migration 158: Options Constructor Layer
-- Adds feature flag to sim_intelligence_config
-- Creates strategy_trade_recipe table for deterministic options construction

-- ============================================================
-- Add enable_options_constructor flag to existing config table
-- ============================================================
ALTER TABLE sim_intelligence_config
  ADD COLUMN IF NOT EXISTS enable_options_constructor BOOLEAN DEFAULT TRUE;

-- ============================================================
-- Strategy Trade Recipe: per-strategy construction rules
-- Supports global defaults (user_id IS NULL) and per-user overrides
-- ============================================================
CREATE TABLE IF NOT EXISTS strategy_trade_recipe (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),

  -- Structure type to construct
  contract_type TEXT NOT NULL CHECK (contract_type IN ('CALL', 'PUT', 'CREDIT_SPREAD')),

  -- Expiration targeting
  target_dte INT NOT NULL DEFAULT 7,
  min_dte INT NOT NULL DEFAULT 1,
  max_dte INT NOT NULL DEFAULT 45,

  -- Strike targeting (absolute delta values, e.g. 0.30 = 30-delta)
  target_delta NUMERIC(6,4) NOT NULL DEFAULT 0.30,
  min_delta NUMERIC(6,4) NOT NULL DEFAULT 0.10,
  max_delta NUMERIC(6,4) NOT NULL DEFAULT 0.50,

  -- Spread construction (only for CREDIT_SPREAD)
  spread_width NUMERIC(10,2),
  spread_width_type TEXT DEFAULT 'dollars' CHECK (spread_width_type IN ('dollars', 'strikes')),

  -- Liquidity thresholds
  min_open_interest INT NOT NULL DEFAULT 100,
  min_volume INT NOT NULL DEFAULT 10,
  max_bid_ask_spread_pct NUMERIC(6,4) NOT NULL DEFAULT 0.10,

  -- Metadata
  is_active BOOLEAN DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, strategy, direction)
);

CREATE INDEX IF NOT EXISTS idx_strategy_trade_recipe_lookup
  ON strategy_trade_recipe(strategy, direction) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_strategy_trade_recipe_user
  ON strategy_trade_recipe(user_id) WHERE user_id IS NOT NULL;

-- ============================================================
-- Seed global default recipes (user_id IS NULL = global default)
-- ============================================================
INSERT INTO strategy_trade_recipe (user_id, strategy, direction, contract_type, target_dte, target_delta, spread_width)
VALUES
  -- Bullish strategies → CALL
  (NULL, 'ORB', 'long', 'CALL', 7, 0.40, NULL),
  (NULL, 'ORB', 'short', 'PUT', 7, 0.40, NULL),
  (NULL, 'TREND', 'long', 'CALL', 14, 0.35, NULL),
  (NULL, 'TREND', 'short', 'PUT', 14, 0.35, NULL),
  (NULL, 'SIGNALS', 'long', 'CALL', 7, 0.40, NULL),
  (NULL, 'SIGNALS', 'short', 'PUT', 7, 0.40, NULL),
  -- Credit spread strategies
  (NULL, 'STRAT', 'long', 'CREDIT_SPREAD', 21, 0.25, 5.00),
  (NULL, 'STRAT', 'short', 'CREDIT_SPREAD', 21, 0.25, 5.00),
  (NULL, 'SATY_PHASE', 'long', 'CALL', 14, 0.30, NULL),
  (NULL, 'SATY_PHASE', 'short', 'PUT', 14, 0.30, NULL)
ON CONFLICT DO NOTHING;
