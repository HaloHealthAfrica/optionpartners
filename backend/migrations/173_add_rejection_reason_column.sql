-- Add rejection_reason sub-category to signal_rejections for TRADE_ENGINE diagnostic breakdown
ALTER TABLE signal_rejections
  ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_signal_rejections_rejection_reason
  ON signal_rejections (gate, rejection_reason)
  WHERE rejection_reason IS NOT NULL;
