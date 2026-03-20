-- Backtest Lab: webhook replay runs with strategy-level results
-- Replay historical webhooks through modified engine rules to validate changes before deployment

CREATE TABLE IF NOT EXISTS backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  indicator_sources TEXT[],
  strategies TEXT[],
  config_snapshot JSONB DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  losing_trades INTEGER DEFAULT 0,
  total_pnl NUMERIC(15,2) DEFAULT 0,
  win_rate NUMERIC(6,4) DEFAULT 0,
  profit_factor NUMERIC(8,4),
  max_drawdown NUMERIC(15,2),
  by_strategy JSONB DEFAULT '[]',
  webhooks_processed INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_user ON backtest_runs (user_id);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_status ON backtest_runs (status);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_created ON backtest_runs (created_at DESC);

-- Allow sim_trades to be tagged with backtest run (excluded from strategy scorecard)
ALTER TABLE sim_trades ADD COLUMN IF NOT EXISTS backtest_run_id UUID REFERENCES backtest_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sim_trades_backtest_run ON sim_trades (backtest_run_id) WHERE backtest_run_id IS NOT NULL;

COMMENT ON TABLE backtest_runs IS 'Webhook replay backtest runs for validating engine changes before deployment';
