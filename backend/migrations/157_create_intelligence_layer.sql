-- Migration 157: Intelligence Layer tables
-- Phase 3: Exit monitor config on positions
-- Phase 1: Strategy scorecard
-- Phase 4: Strategy cooldowns + signal rejection log

-- ============================================================
-- Phase 1: Strategy Scorecard
-- ============================================================
CREATE TABLE IF NOT EXISTS strategy_scorecard (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL,
  window_size INT NOT NULL DEFAULT 20,
  total_trades INT NOT NULL DEFAULT 0,
  winning_trades INT NOT NULL DEFAULT 0,
  losing_trades INT NOT NULL DEFAULT 0,
  win_rate NUMERIC(6,4) DEFAULT 0,
  profit_factor NUMERIC(10,4) DEFAULT 0,
  avg_r_multiple NUMERIC(10,4),
  avg_pnl NUMERIC(12,2) DEFAULT 0,
  stddev_pnl NUMERIC(12,2) DEFAULT 0,
  sharpe_ratio NUMERIC(10,4) DEFAULT 0,
  current_streak INT DEFAULT 0,
  streak_type TEXT DEFAULT 'none' CHECK (streak_type IN ('win', 'loss', 'none')),
  gross_wins NUMERIC(14,2) DEFAULT 0,
  gross_losses NUMERIC(14,2) DEFAULT 0,
  status TEXT DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'UNDERPERFORMING')),
  last_recalculated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, strategy)
);

CREATE INDEX IF NOT EXISTS idx_strategy_scorecard_user ON strategy_scorecard(user_id);
CREATE INDEX IF NOT EXISTS idx_strategy_scorecard_strategy ON strategy_scorecard(user_id, strategy);

-- ============================================================
-- Phase 4: Strategy Cooldowns
-- ============================================================
CREATE TABLE IF NOT EXISTS strategy_cooldowns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL,
  reason TEXT NOT NULL,
  cooldown_until TIMESTAMPTZ NOT NULL,
  consecutive_losses INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, strategy)
);

CREATE INDEX IF NOT EXISTS idx_strategy_cooldowns_user ON strategy_cooldowns(user_id);
CREATE INDEX IF NOT EXISTS idx_strategy_cooldowns_active ON strategy_cooldowns(user_id, cooldown_until);

-- ============================================================
-- Signal Rejection Log (for dashboard visibility)
-- ============================================================
CREATE TABLE IF NOT EXISTS signal_rejections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  webhook_event_id UUID REFERENCES webhook_events(id),
  symbol TEXT,
  strategy TEXT,
  action TEXT,
  reason TEXT NOT NULL,
  gate TEXT NOT NULL,
  signal_score NUMERIC(10,4),
  raw_signal JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signal_rejections_user ON signal_rejections(user_id);
CREATE INDEX IF NOT EXISTS idx_signal_rejections_time ON signal_rejections(created_at DESC);

-- ============================================================
-- Phase 3: Add stop_loss / take_profit tracking to positions
-- ============================================================
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS stop_loss NUMERIC(12,4);
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS take_profit NUMERIC(12,4);
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS trailing_stop_pct NUMERIC(6,4);
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS highest_price NUMERIC(12,4);
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS max_hold_hours INT;
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS exit_reason TEXT;

-- ============================================================
-- Intelligence config per user
-- ============================================================
CREATE TABLE IF NOT EXISTS sim_intelligence_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,

  -- Phase 1: Strategy gate thresholds
  min_win_rate NUMERIC(6,4) DEFAULT 0.40,
  min_profit_factor NUMERIC(6,4) DEFAULT 1.0,
  scorecard_window INT DEFAULT 20,

  -- Phase 2: Signal priority
  enable_signal_priority BOOLEAN DEFAULT TRUE,

  -- Phase 3: Exit engine
  enable_exit_monitor BOOLEAN DEFAULT TRUE,
  exit_check_interval_ms INT DEFAULT 15000,
  default_trailing_stop_pct NUMERIC(6,4) DEFAULT 0.05,
  default_max_hold_hours INT DEFAULT 168,
  force_close_at_dte_zero BOOLEAN DEFAULT TRUE,

  -- Phase 4: Adaptive holds
  enable_strategy_cooldown BOOLEAN DEFAULT TRUE,
  cooldown_consecutive_losses INT DEFAULT 3,
  cooldown_duration_minutes INT DEFAULT 60,
  max_correlated_positions INT DEFAULT 3,
  enable_drawdown_throttle BOOLEAN DEFAULT TRUE,
  drawdown_throttle_pct NUMERIC(6,4) DEFAULT 0.50,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
