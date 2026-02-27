-- Migration: Fix webhook-through-trade pipeline gaps
-- Adds: retry_count to webhook_events, stop_source to sim_positions/sim_trades,
--        latest_saty_signal/saty_signal_at to symbol_state, exit_reason to sim_trades

-- Webhook retry support
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- Stop-source audit trail
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS stop_source VARCHAR(50);
ALTER TABLE sim_trades ADD COLUMN IF NOT EXISTS stop_source VARCHAR(50);
ALTER TABLE sim_trades ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(50);

-- SATY_PHASE support in symbol_state
ALTER TABLE symbol_state ADD COLUMN IF NOT EXISTS latest_saty_signal JSONB;
ALTER TABLE symbol_state ADD COLUMN IF NOT EXISTS saty_signal_at TIMESTAMPTZ;

-- Index for retry-eligible webhook events
CREATE INDEX IF NOT EXISTS idx_webhook_events_retry
  ON webhook_events (status, retry_count, processed_at)
  WHERE status = 'REJECTED' AND retry_count < 3;
