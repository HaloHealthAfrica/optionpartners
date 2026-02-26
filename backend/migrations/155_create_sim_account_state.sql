-- Simulated account state
CREATE TABLE IF NOT EXISTS sim_account_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cash_balance NUMERIC(15,2) NOT NULL DEFAULT 100000.00,
    buying_power NUMERIC(15,2) NOT NULL DEFAULT 100000.00,
    margin_used NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    equity NUMERIC(15,2) NOT NULL DEFAULT 100000.00,
    unrealized_pnl NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    realized_pnl NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    peak_equity NUMERIC(15,2) NOT NULL DEFAULT 100000.00,
    max_drawdown NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    daily_pnl NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    daily_pnl_reset_at DATE NOT NULL DEFAULT CURRENT_DATE,
    kill_switch_active BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sim_account_state_user ON sim_account_state (user_id);

-- Simulated positions
CREATE TABLE IF NOT EXISTS sim_positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(20) NOT NULL,
    underlying_symbol VARCHAR(20),
    contract_type VARCHAR(20) NOT NULL CHECK (contract_type IN ('STOCK', 'CALL', 'PUT', 'CREDIT_SPREAD')),
    strike NUMERIC(10,2),
    strike_short NUMERIC(10,2),
    strike_long NUMERIC(10,2),
    expiration DATE,
    quantity INTEGER NOT NULL,
    avg_price NUMERIC(10,4) NOT NULL,
    current_price NUMERIC(10,4),
    delta_at_entry NUMERIC(6,4),
    unrealized_pnl NUMERIC(15,2) DEFAULT 0.00,
    strategy VARCHAR(100),
    webhook_event_id UUID REFERENCES webhook_events(id),
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'EXPIRED')),
    opened_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    closed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sim_positions_user_status ON sim_positions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_sim_positions_symbol ON sim_positions (symbol);
CREATE INDEX IF NOT EXISTS idx_sim_positions_expiration ON sim_positions (expiration);

-- Simulated orders
CREATE TABLE IF NOT EXISTS sim_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    webhook_event_id UUID REFERENCES webhook_events(id),
    position_id UUID REFERENCES sim_positions(id),
    intent_payload JSONB NOT NULL,
    side VARCHAR(10) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type VARCHAR(20) NOT NULL DEFAULT 'MARKET' CHECK (order_type IN ('MARKET', 'LIMIT')),
    symbol VARCHAR(20) NOT NULL,
    contract_type VARCHAR(20) NOT NULL,
    quantity INTEGER NOT NULL,
    limit_price NUMERIC(10,4),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'FILLED', 'REJECTED', 'CANCELLED')),
    rejection_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sim_orders_user ON sim_orders (user_id);
CREATE INDEX IF NOT EXISTS idx_sim_orders_status ON sim_orders (status);

-- Simulated fills
CREATE TABLE IF NOT EXISTS sim_fills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES sim_orders(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fill_price NUMERIC(10,4) NOT NULL,
    quantity INTEGER NOT NULL,
    slippage_applied NUMERIC(8,4) DEFAULT 0,
    commission NUMERIC(10,2) DEFAULT 0.65,
    contract_multiplier INTEGER NOT NULL DEFAULT 100,
    notional_value NUMERIC(15,2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sim_fills_order ON sim_fills (order_id);
CREATE INDEX IF NOT EXISTS idx_sim_fills_user ON sim_fills (user_id);
