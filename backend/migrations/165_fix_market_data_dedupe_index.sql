-- Fix market_data_events dedupe index: ON CONFLICT requires non-partial unique index
DROP INDEX IF EXISTS idx_market_data_events_dedupe;
CREATE UNIQUE INDEX IF NOT EXISTS idx_market_data_events_dedupe ON market_data_events (dedupe_key);
