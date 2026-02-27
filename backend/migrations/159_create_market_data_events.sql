-- Migration 159: Market data webhook ingestion
-- Stores options flow, price ticks, and chain snapshots from TradingView webhooks.

CREATE TABLE IF NOT EXISTS market_data_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL CHECK (event_type IN ('OPTIONS_FLOW', 'PRICE_TICK', 'CHAIN_SNAPSHOT')),
  symbol TEXT NOT NULL,
  raw_payload JSONB NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mde_symbol_type ON market_data_events(symbol, event_type);
CREATE INDEX IF NOT EXISTS idx_mde_received ON market_data_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mde_user ON market_data_events(user_id);

-- Dedicated options flow table for structured querying
CREATE TABLE IF NOT EXISTS options_flow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  flow_type TEXT NOT NULL CHECK (flow_type IN ('call', 'put', 'CALL', 'PUT')),
  strike NUMERIC(12,2) NOT NULL,
  expiry DATE NOT NULL,
  premium NUMERIC(14,2),
  size INT,
  sentiment TEXT,
  unusual BOOLEAN DEFAULT FALSE,
  raw_payload JSONB,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_options_flow_symbol ON options_flow(symbol);
CREATE INDEX IF NOT EXISTS idx_options_flow_received ON options_flow(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_options_flow_unusual ON options_flow(symbol, unusual) WHERE unusual = TRUE;

-- Latest price cache (upsert per symbol)
CREATE TABLE IF NOT EXISTS price_cache (
  symbol TEXT PRIMARY KEY,
  price NUMERIC(14,4) NOT NULL,
  volume BIGINT,
  high NUMERIC(14,4),
  low NUMERIC(14,4),
  open NUMERIC(14,4),
  timestamp BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
