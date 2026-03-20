-- Revenue Target: restrict to credit spreads, debit spreads, LEAPs only

-- Allowed trade types: CREDIT_SPREAD, DEBIT_SPREAD, LEAP (LEAP = CALL/PUT with DTE >= 365)
ALTER TABLE revenue_target_config
  ADD COLUMN IF NOT EXISTS allowed_trade_types TEXT[] NOT NULL DEFAULT ARRAY['CREDIT_SPREAD', 'DEBIT_SPREAD', 'LEAP'];

-- Add trade_type to decision log for visibility
ALTER TABLE revenue_target_decisions
  ADD COLUMN IF NOT EXISTS trade_type VARCHAR(30);

COMMENT ON COLUMN revenue_target_config.allowed_trade_types IS 'Only these trade types pass the revenue target gate: CREDIT_SPREAD, DEBIT_SPREAD, LEAP (CALL/PUT with DTE>=365)';
