-- Revenue Target: allow single-leg CALL and PUT for CRT and swing options strategies

-- Update default to include CALL and PUT (users can restrict via config)
UPDATE revenue_target_config
SET allowed_trade_types = ARRAY['CREDIT_SPREAD', 'DEBIT_SPREAD', 'LEAP', 'CALL', 'PUT']
WHERE allowed_trade_types = ARRAY['CREDIT_SPREAD', 'DEBIT_SPREAD', 'LEAP']
   OR allowed_trade_types IS NULL;

-- Change default for new configs
ALTER TABLE revenue_target_config
  ALTER COLUMN allowed_trade_types SET DEFAULT ARRAY['CREDIT_SPREAD', 'DEBIT_SPREAD', 'LEAP', 'CALL', 'PUT'];

COMMENT ON COLUMN revenue_target_config.allowed_trade_types IS 'Trade types that pass the revenue target gate: CREDIT_SPREAD, DEBIT_SPREAD, LEAP (CALL/PUT DTE>=365), CALL, PUT (single-leg options e.g. CRT)';
