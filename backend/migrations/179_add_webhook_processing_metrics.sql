-- Migration 179: Add comprehensive webhook processing metrics tables
-- Adds tables for tracking webhook processing performance, latency, queue health, and error rates

-- Table for tracking processing metrics per webhook event and stage
CREATE TABLE IF NOT EXISTS webhook_processing_metrics (
    id SERIAL PRIMARY KEY,
    event_id UUID NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
    stage VARCHAR(50) NOT NULL DEFAULT 'total', -- 'total', 'decision_router', 'executor', 'finalizer'
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    success BOOLEAN,
    error_type VARCHAR(100),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(event_id, stage)
);

-- Table for rolling latency statistics by stage
CREATE TABLE IF NOT EXISTS webhook_latency_stats (
    id SERIAL PRIMARY KEY,
    stage VARCHAR(50) NOT NULL,
    success BOOLEAN NOT NULL,
    total_operations INTEGER NOT NULL DEFAULT 0,
    total_latency_ms BIGINT NOT NULL DEFAULT 0,
    min_latency_ms INTEGER,
    max_latency_ms INTEGER,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(stage, success)
);

-- Table for queue depth monitoring
CREATE TABLE IF NOT EXISTS webhook_queue_metrics (
    id SERIAL PRIMARY KEY,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    queue_depth INTEGER NOT NULL,
    processing_capacity INTEGER -- max webhooks that can be processed per cycle
);

-- Table for error tracking by type and source
CREATE TABLE IF NOT EXISTS webhook_error_metrics (
    id SERIAL PRIMARY KEY,
    error_type VARCHAR(100) NOT NULL,
    source VARCHAR(100), -- 'webhook_processor', 'decision_router', 'executor', etc.
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_id UUID REFERENCES webhook_events(id) ON DELETE CASCADE,
    metadata JSONB DEFAULT '{}',
    occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_webhook_processing_metrics_event_id ON webhook_processing_metrics(event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_processing_metrics_stage ON webhook_processing_metrics(stage);
CREATE INDEX IF NOT EXISTS idx_webhook_processing_metrics_completed ON webhook_processing_metrics(completed_at) WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_latency_stats_stage ON webhook_latency_stats(stage);

CREATE INDEX IF NOT EXISTS idx_webhook_queue_metrics_recorded_at ON webhook_queue_metrics(recorded_at);

CREATE INDEX IF NOT EXISTS idx_webhook_error_metrics_type ON webhook_error_metrics(error_type);
CREATE INDEX IF NOT EXISTS idx_webhook_error_metrics_source ON webhook_error_metrics(source);
CREATE INDEX IF NOT EXISTS idx_webhook_error_metrics_occurred_at ON webhook_error_metrics(occurred_at);
CREATE INDEX IF NOT EXISTS idx_webhook_error_metrics_user_id ON webhook_error_metrics(user_id);