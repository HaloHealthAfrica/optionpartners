-- Migration: Exit monitor gap fixes
-- Adds: lowest_price to sim_positions for PUT trailing stop tracking,
--        exit_reason to sim_positions for exit audit trail

-- PUT trailing stop support: track lowest price watermark
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS lowest_price NUMERIC;

-- Exit reason on position row (set by exit monitor before finalization)
ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(50);
