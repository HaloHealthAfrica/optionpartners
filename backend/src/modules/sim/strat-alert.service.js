'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');
const { normalizeDirection, STRAT_PLAN_EVENTS } = require('../webhooks/indicator-detector');

const PLAN_EVENT_SET = STRAT_PLAN_EVENTS;

const EVENT_TO_STATUS = {
  PLAN_CREATED:      'PLANNED',
  IN_FORCE:          'IN_FORCE',
  TRIGGERED:         'TRIGGERED',
  INVALIDATED:       'INVALIDATED',
  EXPIRED:           'EXPIRED',
  REVERSAL_IN_FORCE: 'REVERSAL',
};

function _isV2(payload) {
  const metaSystem = payload.meta?.system || '';
  if (metaSystem.includes('Strat Plan Engine')) return true;
  const event = (payload.event || '').toUpperCase();
  return PLAN_EVENT_SET.has(event) && payload.setup && typeof payload.setup === 'object';
}

/**
 * Attempt to create or update a strat_alerts record from a webhook payload.
 *
 * V1 (legacy): flat entry/target/stop — creates alert when levels > 0.
 * V2 (plan engine): always creates/updates via plan_id lifecycle.
 *
 * @param {Object} payload - Raw webhook payload
 * @param {string} userId
 * @param {string} webhookEventId
 * @returns {Promise<Object|null>} The strat_alert row, or null if not applicable
 */
async function maybeCreateStratAlertFromWebhook(payload, userId, webhookEventId) {
  if (!payload || typeof payload !== 'object') return null;

  if (_isV2(payload)) {
    return _handleV2(payload, userId, webhookEventId);
  }

  return _handleV1(payload, userId, webhookEventId);
}

async function _handleV1(payload, userId, webhookEventId) {
  const engine = payload.journal?.engine;
  const components = Array.isArray(payload.components) ? payload.components : [];

  const isStratJournal = engine === 'STRAT_V6_FULL' || engine === 'STRAT';
  const isStratComponent = components.some(c =>
    c === 'STRAT_SETUP' || c === 'HTF_IGNITION' || c === 'BIAS_SHIFT'
  );
  const hasStratLevels = typeof payload.entry === 'number'
    && typeof payload.target === 'number'
    && typeof payload.stop === 'number';

  if (!isStratJournal && !isStratComponent && !hasStratLevels) return null;

  const entry = parseFloat(payload.entry) || 0;
  const target = parseFloat(payload.target) || 0;
  const stop = parseFloat(payload.stop) || 0;

  if (entry <= 0 || target <= 0 || stop <= 0) {
    logger.info(
      `[STRAT_ALERT] Skipped — missing actionable levels (entry=${entry}, target=${target}, stop=${stop})`,
      'strat-alert'
    );
    return null;
  }

  const symbol = (payload.ticker || payload.symbol || '').toUpperCase();
  const dirRaw = payload.signal?.side ?? payload.trend ?? null;
  const direction = normalizeDirection(dirRaw);

  const rawScore = typeof payload.score === 'number'
    ? payload.score
    : (typeof payload.signal?.ai_score === 'number' ? payload.signal.ai_score : 75);
  const score = rawScore <= 10 ? Math.min(100, rawScore * 10) : Math.min(100, rawScore);

  const setup = payload.setup || payload.setupType || payload.setup_type
    || (components.includes('STRAT_SETUP') ? '2-1-2 Rev' : null);

  const reversalLevel = parseFloat(payload.reversal_level ?? payload.reversalLevel) || null;
  const optionsSuggestion = payload.options_suggestion || payload.optionsPlay || null;
  const conditionText = payload.condition_text || payload.condition || null;

  try {
    const result = await db.query(
      `INSERT INTO strat_alerts
         (user_id, webhook_event_id, symbol, direction, score, entry, target, stop,
          setup, reversal_level, options_suggestion, condition_text, components,
          timeframe, trend, engine, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'TRIGGERED')
       ON CONFLICT (webhook_event_id) WHERE webhook_event_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        userId, webhookEventId, symbol, direction, score,
        entry, target, stop, setup, reversalLevel,
        optionsSuggestion, conditionText, JSON.stringify(components),
        payload.timeframe || null, payload.trend || null, engine || null,
      ]
    );

    const alert = result.rows[0];
    logger.info(
      `[STRAT_ALERT] Created: ${symbol} ${direction} entry=${entry} target=${target} stop=${stop} setup=${setup}`,
      'strat-alert'
    );
    return alert;
  } catch (err) {
    logger.error(`[STRAT_ALERT] Insert failed: ${err.message}`, 'strat-alert');
    return null;
  }
}

async function _handleV2(payload, userId, webhookEventId) {
  const event = (payload.event || '').toUpperCase();
  const planId = payload.plan_id || null;
  const symbol = (payload.meta?.symbol || '').toUpperCase();
  const status = EVENT_TO_STATUS[event] || 'PLANNED';

  if (!symbol) {
    logger.info('[STRAT_ALERT] V2 skipped — no meta.symbol', 'strat-alert');
    return null;
  }

  const dirRaw = payload.setup?.direction ?? payload.setup?.bias ?? null;
  const direction = normalizeDirection(dirRaw);

  const entry = parseFloat(payload.plan?.entry) || null;
  const stop = parseFloat(payload.plan?.stop) || null;
  const target1 = parseFloat(payload.plan?.target1) || null;
  const target2 = parseFloat(payload.plan?.target2) || null;
  const atr = parseFloat(payload.plan?.atr) || null;

  const pattern = payload.setup?.pattern || null;
  const patternKind = payload.setup?.pattern_kind || null;
  const bias = payload.setup?.bias || null;
  const continuity = payload.setup?.continuity ?? null;
  const htf = payload.setup?.htf || null;
  const ltf = payload.setup?.ltf || null;
  const ctf = payload.setup?.ctf || null;
  const htfCandle = payload.setup?.htf_candle || null;
  const htfCandlePrev = payload.setup?.htf_candle_prev || null;
  const ctfCandle = payload.setup?.ctf_candle || null;
  const openCondition = payload.plan?.open_condition || null;
  const expiryLtfBars = payload.plan?.expiry_ltf_bars || null;
  const marketData = payload.market || null;

  // Derive confidence score from pattern quality
  const kind = (patternKind || '').toUpperCase();
  let score;
  if (kind === 'CONTINUATION') score = continuity ? 85 : 70;
  else if (kind === 'REVERSAL')  score = continuity ? 75 : 55;
  else if (kind === 'REVSTRAT')  score = continuity ? 65 : 50;
  else                           score = continuity ? 75 : 65;

  // For lifecycle events after PLAN_CREATED, try to update existing alert by plan_id
  if (planId && event !== 'PLAN_CREATED') {
    try {
      const updated = await db.query(
        `UPDATE strat_alerts
         SET status = $1, event_type = $2, webhook_event_id = $3, updated_at = NOW()
         WHERE plan_id = $4 AND user_id = $5
         RETURNING *`,
        [status, event, webhookEventId, planId, userId]
      );

      if (updated.rows.length > 0) {
        logger.info(
          `[STRAT_ALERT] Lifecycle: ${symbol} plan=${planId} ${event} → ${status}`,
          'strat-alert'
        );
        return updated.rows[0];
      }
    } catch (err) {
      logger.error(`[STRAT_ALERT] Lifecycle update failed: ${err.message}`, 'strat-alert');
    }
  }

  // Insert new alert (PLAN_CREATED or no existing plan found)
  try {
    const result = await db.query(
      `INSERT INTO strat_alerts
         (user_id, webhook_event_id, symbol, direction, score,
          entry, target, stop, target2, atr,
          setup, pattern, pattern_kind, bias, continuity,
          htf, ltf, ctf, htf_candle, htf_candle_prev, ctf_candle,
          open_condition, expiry_ltf_bars, market_data,
          plan_id, event_type, status, engine,
          timeframe, trend)
       VALUES ($1, $2, $3, $4, $5,
               $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21,
               $22, $23, $24,
               $25, $26, $27, $28,
               $29, $30)
       ON CONFLICT (webhook_event_id) WHERE webhook_event_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        userId, webhookEventId, symbol, direction, score,
        entry, target1, stop, target2, atr,
        pattern, pattern, patternKind, bias, continuity,
        htf, ltf, ctf, htfCandle, htfCandlePrev, ctfCandle,
        openCondition ? JSON.stringify(openCondition) : null,
        expiryLtfBars,
        marketData ? JSON.stringify(marketData) : null,
        planId, event, status,
        payload.meta?.system || 'Strat Plan Engine v2',
        htf, direction,
      ]
    );

    const alert = result.rows[0];
    logger.info(
      `[STRAT_ALERT] V2 Created: ${symbol} ${direction} pattern=${pattern} ` +
      `kind=${patternKind} continuity=${continuity} event=${event} plan=${planId}`,
      'strat-alert'
    );
    return alert;
  } catch (err) {
    logger.error(`[STRAT_ALERT] V2 insert failed: ${err.message}`, 'strat-alert');
    return null;
  }
}

module.exports = { maybeCreateStratAlertFromWebhook };
