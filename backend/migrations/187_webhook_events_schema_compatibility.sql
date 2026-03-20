-- Migration 187: Webhook events schema compatibility
-- Adds missing columns for alternate schemas (e.g. marketplaybook) that use
-- payload/created_at/strategy_detected instead of raw_payload/received_at/indicator_source.
-- Idempotent: safe to run on both full and minimal schemas.

-- user_id: required for pipeline (decision router, executor, signal_rejections)
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- received_at: used by getPending, cleanup, latency stats
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'webhook_events' AND column_name = 'received_at'
  ) THEN
    ALTER TABLE webhook_events ADD COLUMN received_at TIMESTAMP WITH TIME ZONE;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'webhook_events' AND column_name = 'created_at'
    ) THEN
      UPDATE webhook_events SET received_at = created_at;
    ELSE
      UPDATE webhook_events SET received_at = NOW();
    END IF;
    ALTER TABLE webhook_events ALTER COLUMN received_at SET NOT NULL;
    ALTER TABLE webhook_events ALTER COLUMN received_at SET DEFAULT NOW();
  END IF;
END $$;

-- raw_payload: used by processor, normalizers
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'webhook_events' AND column_name = 'raw_payload'
  ) THEN
    ALTER TABLE webhook_events ADD COLUMN raw_payload JSONB;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'webhook_events' AND column_name = 'payload'
    ) THEN
      UPDATE webhook_events SET raw_payload = COALESCE(payload, '{}'::jsonb);
    ELSE
      UPDATE webhook_events SET raw_payload = '{}'::jsonb;
    END IF;
    ALTER TABLE webhook_events ALTER COLUMN raw_payload SET NOT NULL;
    ALTER TABLE webhook_events ALTER COLUMN raw_payload SET DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- dedupe_key: used for duplicate detection in ingest
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'webhook_events' AND column_name = 'dedupe_key'
  ) THEN
    ALTER TABLE webhook_events ADD COLUMN dedupe_key VARCHAR(255);
    UPDATE webhook_events SET dedupe_key = 'legacy_' || id::text WHERE dedupe_key IS NULL;
    ALTER TABLE webhook_events ALTER COLUMN dedupe_key SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_dedupe_key ON webhook_events (dedupe_key);
  END IF;
END $$;

-- signature_valid: used by ingest
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS signature_valid BOOLEAN DEFAULT TRUE;

-- indicator_source: used by setIndicatorSource (strategy_detected exists in marketplaybook)
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS indicator_source VARCHAR(50);

-- Indexes for pipeline queries
CREATE INDEX IF NOT EXISTS idx_webhook_events_user_id ON webhook_events (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events (status);
