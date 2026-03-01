-- Migration: Add indicator source tracking across webhook-to-trade pipeline
-- Enables direct querying of webhook events and orders by strategy/indicator source
-- without parsing JSONB blobs.

-- webhook_events: detected indicator source (PIVOT_MB, SIGNALS, ORB, STRAT, etc.)
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS indicator_source VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_webhook_events_indicator_source
  ON webhook_events (indicator_source)
  WHERE indicator_source IS NOT NULL;

-- sim_orders: strategy and indicator source for direct querying
ALTER TABLE sim_orders ADD COLUMN IF NOT EXISTS strategy VARCHAR(100);
ALTER TABLE sim_orders ADD COLUMN IF NOT EXISTS indicator_source VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_sim_orders_strategy
  ON sim_orders (strategy)
  WHERE strategy IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sim_orders_indicator_source
  ON sim_orders (indicator_source)
  WHERE indicator_source IS NOT NULL;

-- Backfill indicator_source on webhook_events from raw_payload where possible
UPDATE webhook_events
SET indicator_source = CASE
  WHEN raw_payload->>'source' = 'PIVOT_MB' OR raw_payload->>'signal_type' = 'PIVOT_MOTHERBAR' THEN 'PIVOT_MB'
  WHEN raw_payload->'meta'->>'engine' = 'SATY_PO' THEN 'SATY_PHASE'
  WHEN raw_payload->'journal'->>'engine' IN ('STRAT_V6_FULL', 'STRAT') THEN 'STRAT'
  WHEN raw_payload->>'source' = 'MTF_BIAS_ENGINE_V3' AND raw_payload->>'event_id_raw' IS NOT NULL THEN 'MTF_BIAS'
  WHEN raw_payload->>'indicator' IN ('ORB', 'Stretch', 'BHCH', 'EMA') THEN 'ORB'
  ELSE NULL
END
WHERE indicator_source IS NULL
  AND status IN ('PROCESSED', 'REJECTED');

-- Backfill strategy on sim_orders from intent_payload
UPDATE sim_orders
SET strategy = intent_payload->>'strategy',
    indicator_source = intent_payload->>'indicatorSource'
WHERE strategy IS NULL
  AND intent_payload->>'strategy' IS NOT NULL;
