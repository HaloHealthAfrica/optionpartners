-- Seed the remediation log with all fixes applied from prior health assessments.
-- Uses the first user found (single-tenant system).
INSERT INTO system_remediation_log (user_id, title, description, category, status, assessment_date, applied_date)
SELECT
  u.id,
  v.title,
  v.description,
  v.category,
  'applied',
  '2026-03-06'::timestamptz,
  '2026-03-06'::timestamptz
FROM users u
CROSS JOIN (VALUES
  (
    'VIX data pipeline fix — separated VIX spot from Current IV',
    'live-context.service.js was mislabeling current_iv as VIX. Fixed to fetch actual VIX spot index via data-service proxy with fallback to vix_snapshots.spot column. VIX and Current IV are now displayed separately in the AI prompt.',
    'data_integrity'
  ),
  (
    'GEX conviction thresholds corrected from raw to normalized units',
    'trade-decision-engine.js and live-context.service.js had GEX thresholds set at 500,000,000 (raw) instead of 0.5 (normalized). Fixed so gex_negative and gex_positive conviction components now fire correctly.',
    'guard_tuning'
  ),
  (
    'Fallback IV Rank regime classification when volatility_snapshots stale',
    'decision-router.js now derives a fallbackRegime from iv_rank when the primary regime fetch returns null/UNKNOWN. Mapping: iv_rank>70→HIGH_VOL_EXPANSION, iv_rank<20→LOW_VOL_CHOP, else→NEUTRAL. Dramatically reduces UNKNOWN regime rate.',
    'regime_classification'
  ),
  (
    'regime_at_entry stored directly on sim_trades',
    'Added regime_at_entry and regime_source columns to sim_trades (migration 174). trade-finalizer.js now looks up and stores the regime at entry time. regime-edge.service.js prioritizes this column over the volatility_snapshots join.',
    'regime_classification'
  ),
  (
    'TRADE_ENGINE rejection sub-category logging',
    'trade-decision-engine.js now classifies BLOCK rejections with _classifyRejectionReason. decision-router.js passes rejectionSubCategory for all non-TRADE_ENGINE gates. Added rejection_reason column to sim_rejections (migration 173).',
    'observability'
  ),
  (
    'MAE/MFE calculation corrected — denominator changed to capital base',
    'trade-finalizer.js now computes max_adverse_excursion and max_favorable_excursion as fractions of capitalBase instead of raw dollar amounts. Values are stored on sim_trades. Exit quality metrics now report sane percentages.',
    'data_integrity'
  ),
  (
    'SIGNALS strategy suppressed via SUPPRESSED_STRATEGIES env var',
    'decision-router.js checks process.env.SUPPRESSED_STRATEGIES (default: SIGNALS) before STRATEGY_GATE. Blocked signals are logged with rejectionSubCategory=strategy_suppressed. Prevents negative-expectancy strategy from executing live.',
    'strategy_management'
  ),
  (
    'STRAT_Failed2 rich per-trade logging at finalization',
    'trade-finalizer.js now logs detailed entry/exit/PnL/regime info for PRIORITY_STRATEGIES (STRAT_Failed2, STRAT_Failed1) at finalization time for observability.',
    'observability'
  ),
  (
    'Switched system health assessment AI to Claude Sonnet 4.6',
    'ai-insights.service.js now forces provider=claude, model=claude-sonnet-4-6 for all system health assessments regardless of user AI settings. Higher max_tokens (16384) and system prompt added to Claude non-streaming path.',
    'ai_model'
  ),
  (
    'Remediation log system introduced',
    'Created system_remediation_log table and service. All prior fixes are recorded. The AI prompt now includes the remediation log so it can distinguish new issues from already-fixed ones and verify fix effectiveness.',
    'observability'
  )
) AS v(title, description, category)
LIMIT 10;
