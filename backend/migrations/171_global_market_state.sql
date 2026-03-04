-- Global market state: shared market data (price, chain) that is NOT user-specific.
-- Eliminates the per-user routing bug where chain data went to one user and was
-- invisible to others.

CREATE TABLE IF NOT EXISTS global_market_state (
  symbol          VARCHAR(20) PRIMARY KEY,

  -- Price data
  last_price      NUMERIC(15,4),
  price_high      NUMERIC(15,4),
  price_low       NUMERIC(15,4),
  price_open      NUMERIC(15,4),
  price_volume    BIGINT,
  price_source    VARCHAR(50),       -- 'twelvedata', 'polygon', 'webhook', 'cache'
  price_updated_at TIMESTAMPTZ,

  -- Options chain data
  chain_ok        BOOLEAN DEFAULT FALSE,
  chain_contracts_count INTEGER DEFAULT 0,
  chain_open_interest BIGINT DEFAULT 0,
  chain_volume    BIGINT DEFAULT 0,
  bid_ask_spread_pct NUMERIC(8,4),
  liquidity_ok    BOOLEAN DEFAULT FALSE,
  iv_percentile   NUMERIC(8,4),
  chain_source    VARCHAR(50),       -- 'unusualwhales', 'marketdata', 'webhook'
  chain_updated_at TIMESTAMPTZ,

  -- Staleness tracking
  price_fetch_failures INTEGER DEFAULT 0,
  chain_fetch_failures INTEGER DEFAULT 0,
  last_price_error  TEXT,
  last_chain_error  TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_global_market_state_updated
  ON global_market_state (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_global_market_state_price_age
  ON global_market_state (price_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_global_market_state_chain_age
  ON global_market_state (chain_updated_at DESC);

-- Seed default symbols so pollers have something to iterate
INSERT INTO global_market_state (symbol) VALUES
  ('SPY'), ('QQQ'), ('IWM'), ('AAPL'), ('MSFT'), ('NVDA'), ('TSLA'), ('AMZN'), ('META'), ('GOOGL')
ON CONFLICT (symbol) DO NOTHING;

-- Track data-service health from the backend's perspective
CREATE TABLE IF NOT EXISTS data_service_health_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_type      VARCHAR(50) NOT NULL,   -- 'PRICE_POLL', 'CHAIN_POLL', 'HEALTH_CHECK'
  symbol          VARCHAR(20),
  success         BOOLEAN NOT NULL,
  provider        VARCHAR(50),
  latency_ms      INTEGER,
  error_message   TEXT,
  response_meta   JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_health_log_recent
  ON data_service_health_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_health_log_type
  ON data_service_health_log (check_type, symbol, created_at DESC);

-- Auto-prune health logs older than 7 days (run via periodic cleanup)
