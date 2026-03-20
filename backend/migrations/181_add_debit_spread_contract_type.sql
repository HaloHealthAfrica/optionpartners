-- Add DEBIT_SPREAD to sim_positions contract_type constraint (for revenue target trade type filtering)
ALTER TABLE sim_positions DROP CONSTRAINT IF EXISTS sim_positions_contract_type_check;
ALTER TABLE sim_positions ADD CONSTRAINT sim_positions_contract_type_check
  CHECK (contract_type IN ('STOCK', 'CALL', 'PUT', 'CREDIT_SPREAD', 'DEBIT_SPREAD'));
