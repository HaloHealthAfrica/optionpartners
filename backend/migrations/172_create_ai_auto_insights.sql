-- Auto-generated AI insights triggered by trade count thresholds
CREATE TABLE IF NOT EXISTS ai_auto_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  analysis TEXT NOT NULL,
  metrics JSONB,
  trade_count INTEGER NOT NULL,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_auto_insights_user_unread
  ON ai_auto_insights (user_id, is_read)
  WHERE is_read = false;

CREATE INDEX IF NOT EXISTS idx_ai_auto_insights_user_created
  ON ai_auto_insights (user_id, created_at DESC);

-- Add auto_insight_interval to sim_intelligence_config if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sim_intelligence_config'
    AND column_name = 'auto_insight_interval'
  ) THEN
    ALTER TABLE sim_intelligence_config
      ADD COLUMN auto_insight_interval INTEGER DEFAULT 25;
  END IF;
END $$;
