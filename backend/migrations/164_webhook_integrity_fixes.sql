-- Migration: Webhook integrity fixes
-- Adds: UNIQUE constraint on dedupe_key, dedupe_key column to market_data_events

-- Atomic deduplication: prevent race-condition duplicates
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_dedupe_key_unique UNIQUE (dedupe_key);

-- Market data deduplication support
ALTER TABLE market_data_events ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(120);
CREATE UNIQUE INDEX IF NOT EXISTS idx_market_data_events_dedupe
  ON market_data_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- Index for FOR UPDATE SKIP LOCKED efficiency on pending events
CREATE INDEX IF NOT EXISTS idx_webhook_events_pending
  ON webhook_events (received_at ASC)
  WHERE status = 'RECEIVED';
