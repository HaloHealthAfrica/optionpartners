-- Data Provider Validation: scheduled runs, job results, freshness, alerts
-- Tracks validation of Tradier, Tastytrade, Internal Proxy data pulls

-- Scheduled run slots (6AM, 8AM, 9AM, then hourly 9AM-4:30PM ET)
CREATE TABLE IF NOT EXISTS data_validation_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_at TIMESTAMPTZ NOT NULL,
  ran_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'passed', 'partial', 'failed')),
  total_records INTEGER,
  avg_latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_validation_run_scheduled
  ON data_validation_run (scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_validation_run_status
  ON data_validation_run (status);
CREATE INDEX IF NOT EXISTS idx_data_validation_run_ran_at
  ON data_validation_run (ran_at DESC) WHERE ran_at IS NOT NULL;

-- Per-job results within a run (Quotes, Options Chains, Account State, Regime/Vol)
CREATE TABLE IF NOT EXISTS data_validation_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES data_validation_run(id) ON DELETE CASCADE,
  job_type VARCHAR(40) NOT NULL
    CHECK (job_type IN ('quotes_greeks', 'options_chains', 'account_state', 'regime_vol')),
  provider VARCHAR(40) NOT NULL
    CHECK (provider IN ('tradier', 'tastytrade', 'internal_proxy')),
  success BOOLEAN NOT NULL,
  records_pulled INTEGER,
  latency_ms INTEGER,
  error_type VARCHAR(40)
    CHECK (error_type IS NULL OR error_type IN ('provider_down', 'empty_response', 'parse_error', 'timeout', 'unknown')),
  raw_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  symbols TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_validation_job_run
  ON data_validation_job (run_id);
CREATE INDEX IF NOT EXISTS idx_data_validation_job_type
  ON data_validation_job (job_type);
CREATE INDEX IF NOT EXISTS idx_data_validation_job_provider
  ON data_validation_job (provider);

-- Last successful pull per data type (for freshness strip)
CREATE TABLE IF NOT EXISTS data_validation_freshness (
  id SERIAL PRIMARY KEY,
  data_type VARCHAR(40) NOT NULL UNIQUE
    CHECK (data_type IN ('quotes_greeks', 'options_chains', 'account_state', 'regime_vol')),
  last_success_at TIMESTAMPTZ NOT NULL,
  provider VARCHAR(40) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Alerts (dismissable, severity: error vs warning)
CREATE TABLE IF NOT EXISTS data_validation_alert (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('error', 'warning')),
  message TEXT NOT NULL,
  data_type VARCHAR(40),
  run_id UUID REFERENCES data_validation_run(id) ON DELETE SET NULL,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_validation_alert_active
  ON data_validation_alert (dismissed_at) WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_data_validation_alert_triggered
  ON data_validation_alert (triggered_at DESC);

COMMENT ON TABLE data_validation_run IS 'Scheduled data provider validation runs (6AM, 8AM, 9AM, hourly 9AM-4:30PM ET)';
COMMENT ON TABLE data_validation_job IS 'Per-provider job results within each run';
COMMENT ON TABLE data_validation_freshness IS 'Last successful pull timestamp per data type for freshness strip';
COMMENT ON TABLE data_validation_alert IS 'Dismissable alerts for failed pulls or stale data';
