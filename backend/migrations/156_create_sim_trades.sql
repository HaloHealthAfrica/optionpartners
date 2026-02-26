-- Finalized simulation trades for analytics
CREATE TABLE IF NOT EXISTS sim_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position_id UUID REFERENCES sim_positions(id),
    symbol VARCHAR(20) NOT NULL,
    underlying_symbol VARCHAR(20),
    contract_type VARCHAR(20) NOT NULL,
    side VARCHAR(10) NOT NULL CHECK (side IN ('long', 'short')),
    strategy VARCHAR(100),
    strike NUMERIC(10,2),
    strike_short NUMERIC(10,2),
    strike_long NUMERIC(10,2),
    expiration DATE,
    entry_price NUMERIC(10,4) NOT NULL,
    exit_price NUMERIC(10,4),
    quantity INTEGER NOT NULL,
    contract_multiplier INTEGER NOT NULL DEFAULT 100,
    entry_time TIMESTAMP WITH TIME ZONE NOT NULL,
    exit_time TIMESTAMP WITH TIME ZONE,
    pnl NUMERIC(15,2),
    pnl_percent NUMERIC(10,4),
    r_multiple NUMERIC(8,4),
    commission_total NUMERIC(10,2) DEFAULT 0,
    max_favorable_excursion NUMERIC(10,4),
    max_adverse_excursion NUMERIC(10,4),
    dte_at_entry INTEGER,
    delta_at_entry NUMERIC(6,4),
    is_sim BOOLEAN NOT NULL DEFAULT TRUE,
    webhook_event_id UUID REFERENCES webhook_events(id),
    tags TEXT[],
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sim_trades_user ON sim_trades (user_id);
CREATE INDEX IF NOT EXISTS idx_sim_trades_symbol ON sim_trades (symbol);
CREATE INDEX IF NOT EXISTS idx_sim_trades_strategy ON sim_trades (strategy);
CREATE INDEX IF NOT EXISTS idx_sim_trades_entry_time ON sim_trades (entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_sim_trades_pnl ON sim_trades (pnl);

-- Simulation run history for replay mode
CREATE TABLE IF NOT EXISTS sim_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(20) NOT NULL,
    strategy VARCHAR(100) NOT NULL,
    timeframe VARCHAR(20) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    config_snapshot JSONB NOT NULL,
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    total_pnl NUMERIC(15,2) DEFAULT 0,
    max_drawdown NUMERIC(15,2) DEFAULT 0,
    win_rate NUMERIC(6,4) DEFAULT 0,
    avg_r_multiple NUMERIC(8,4) DEFAULT 0,
    sharpe_ratio NUMERIC(8,4),
    profit_factor NUMERIC(8,4),
    status VARCHAR(20) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sim_runs_user ON sim_runs (user_id);
CREATE INDEX IF NOT EXISTS idx_sim_runs_status ON sim_runs (status);

-- Equity snapshots for curve visualization
CREATE TABLE IF NOT EXISTS sim_equity_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sim_run_id UUID REFERENCES sim_runs(id) ON DELETE CASCADE,
    equity NUMERIC(15,2) NOT NULL,
    cash_balance NUMERIC(15,2) NOT NULL,
    unrealized_pnl NUMERIC(15,2) DEFAULT 0,
    realized_pnl NUMERIC(15,2) DEFAULT 0,
    open_positions INTEGER DEFAULT 0,
    snapshot_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sim_equity_snapshots_user ON sim_equity_snapshots (user_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_sim_equity_snapshots_run ON sim_equity_snapshots (sim_run_id, snapshot_at);
