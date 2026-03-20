#!/usr/bin/env node
'use strict';

/**
 * Run migration 187 (webhook_events schema compatibility) directly.
 * Use when marketplaybook/alternate schema lacks indicator_source, received_at, etc.
 *
 *   fly ssh console -a marketplaybook -C "node /app/backend/scripts/run-migration-187.js"
 *
 * Or locally with DATABASE_URL:
 *   DATABASE_URL="postgres://..." node backend/scripts/run-migration-187.js
 */
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('sslmode') ? { rejectUnauthorized: false } : false,
});

// Inlined migration 187 - idempotent, safe to run multiple times
const MIGRATION_187 = `
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'webhook_events' AND column_name = 'received_at') THEN
    ALTER TABLE webhook_events ADD COLUMN received_at TIMESTAMP WITH TIME ZONE;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'webhook_events' AND column_name = 'created_at') THEN
      UPDATE webhook_events SET received_at = created_at;
    ELSE
      UPDATE webhook_events SET received_at = NOW();
    END IF;
    ALTER TABLE webhook_events ALTER COLUMN received_at SET NOT NULL;
    ALTER TABLE webhook_events ALTER COLUMN received_at SET DEFAULT NOW();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'webhook_events' AND column_name = 'raw_payload') THEN
    ALTER TABLE webhook_events ADD COLUMN raw_payload JSONB;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'webhook_events' AND column_name = 'payload') THEN
      UPDATE webhook_events SET raw_payload = COALESCE(payload, '{}'::jsonb);
    ELSE
      UPDATE webhook_events SET raw_payload = '{}'::jsonb;
    END IF;
    ALTER TABLE webhook_events ALTER COLUMN raw_payload SET NOT NULL;
    ALTER TABLE webhook_events ALTER COLUMN raw_payload SET DEFAULT '{}'::jsonb;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'webhook_events' AND column_name = 'dedupe_key') THEN
    ALTER TABLE webhook_events ADD COLUMN dedupe_key VARCHAR(255);
    UPDATE webhook_events SET dedupe_key = 'legacy_' || id::text WHERE dedupe_key IS NULL;
    ALTER TABLE webhook_events ALTER COLUMN dedupe_key SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_dedupe_key ON webhook_events (dedupe_key);
  END IF;
END $$;

ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS signature_valid BOOLEAN DEFAULT TRUE;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS indicator_source VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_webhook_events_user_id ON webhook_events (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events (status);
`;

async function main() {
  console.log('Running migration 187_webhook_events_schema_compatibility...');
  const client = await pool.connect();
  try {
    await client.query(MIGRATION_187);
    console.log('Migration 187 applied successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
