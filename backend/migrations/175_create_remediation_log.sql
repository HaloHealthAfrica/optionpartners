CREATE TABLE IF NOT EXISTS system_remediation_log (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(256) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'applied',
  assessment_date TIMESTAMPTZ,
  applied_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_remediation_log_user
  ON system_remediation_log (user_id, created_at DESC);
