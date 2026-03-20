-- Revenue Target Module: config and daily progress tracking
-- Supports $X/day target with gate and sizer integration

CREATE TABLE IF NOT EXISTS revenue_target_config (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_target NUMERIC(10,2) NOT NULL DEFAULT 250.00,
  target_mode VARCHAR(20) NOT NULL DEFAULT 'daily' CHECK (target_mode IN ('daily', 'weekly', 'monthly')),
  max_trades_per_day INTEGER NOT NULL DEFAULT 3 CHECK (max_trades_per_day >= 1 AND max_trades_per_day <= 20),
  min_credit_per_trade NUMERIC(10,2) NOT NULL DEFAULT 50.00,
  aggression_mode VARCHAR(20) NOT NULL DEFAULT 'balanced' CHECK (aggression_mode IN ('conservative', 'balanced', 'aggressive')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_target_config_enabled
  ON revenue_target_config (enabled) WHERE enabled = TRUE;

COMMENT ON TABLE revenue_target_config IS 'Per-user revenue target settings for EM Premium Seller / Strike Optimizer strategies';

-- Daily progress snapshot for analytics and dashboard
CREATE TABLE IF NOT EXISTS revenue_target_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_date DATE NOT NULL,
  target NUMERIC(10,2) NOT NULL,
  realized NUMERIC(10,2) NOT NULL DEFAULT 0,
  trades_count INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'on_track', 'behind', 'ahead', 'met')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_revenue_target_daily_user_date
  ON revenue_target_daily (user_id, trade_date DESC);
