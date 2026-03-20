-- Migration: Add webhook source identification and rate limiting support
-- Enables per-source tagging (IP, API key, user agent) and rate limiting

-- Add source identification columns to webhook_events
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS client_ip INET;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;

-- Add rate limiting tracking table
CREATE TABLE IF NOT EXISTS webhook_rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key VARCHAR(255) NOT NULL, -- e.g., 'ip:192.168.1.1', 'api_key:uuid', 'user:uuid'
  source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('ip', 'api_key', 'user')),
  window_start TIMESTAMP WITH TIME ZONE NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_request_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(source_key, window_start)
);

-- Index for efficient rate limit lookups
CREATE INDEX IF NOT EXISTS idx_webhook_rate_limits_source_key_window
  ON webhook_rate_limits (source_key, window_start DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_rate_limits_source_type
  ON webhook_rate_limits (source_type);

-- Add webhook source metrics table for analytics
CREATE TABLE IF NOT EXISTS webhook_source_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type VARCHAR(20) NOT NULL, -- 'ip', 'api_key', 'user'
  source_identifier VARCHAR(255) NOT NULL, -- IP, API key ID, or user ID
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  total_requests INTEGER NOT NULL DEFAULT 0,
  valid_requests INTEGER NOT NULL DEFAULT 0,
  rejected_requests INTEGER NOT NULL DEFAULT 0,
  rate_limited_requests INTEGER NOT NULL DEFAULT 0,
  last_request_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  first_request_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(source_type, source_identifier, user_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_source_metrics_user_source
  ON webhook_source_metrics (user_id, source_type, source_identifier);

CREATE INDEX IF NOT EXISTS idx_webhook_source_metrics_last_request
  ON webhook_source_metrics (last_request_at DESC);