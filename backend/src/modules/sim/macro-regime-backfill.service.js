'use strict';

const dataServiceProxy = require('../../services/dataServiceProxy');
const symbolStateService = require('./symbol-state.service');
const logger = require('../../utils/logger');

const STATE_TTL_MS = parseInt(process.env.SIM_STATE_TTL_MS || '1800000', 10);
const STALE_THRESHOLD_MS = STATE_TTL_MS * 4; // Same as trade-decision-engine: 2h default
const ENABLED = process.env.SIM_MACRO_BACKFILL_ENABLED !== 'false';

/**
 * Maps data-service regime tradingBias to symbol-state macro_bias format.
 * Data-service uses VIX, term structure, yield curve, FOMC to compute tradingBias.
 */
function regimeToMtfPayload(regime) {
  const tradingBias = (regime?.tradingBias || 'neutral').toLowerCase();
  const regimeType = (regime?.regime || 'normal').toLowerCase();

  let bias, weightedScore;
  if (tradingBias === 'risk-on') {
    bias = 'BULLISH';
    weightedScore = 60;
  } else if (tradingBias === 'risk-off') {
    bias = 'BEARISH';
    weightedScore = 40;
  } else {
    bias = 'NEUTRAL';
    weightedScore = 50;
  }

  // Map VIX regime to MTF regime type
  let regimeTypeMtf = 'TREND';
  if (regimeType === 'elevated' || regimeType === 'crisis') {
    regimeTypeMtf = 'CHOP';
  }

  return {
    ticker: null,
    mtf: {
      consensus: { bias, weighted_score: weightedScore },
      regime: { type: regimeTypeMtf },
    },
    macro: { state: {} },
    space: {},
    bar: {},
    risk_context: {},
    _source: 'data_service_backup',
    _vixLevel: regime?.vixLevel,
    _vixTrend: regime?.vixTrend,
    _termStructure: regime?.termStructure,
  };
}

/**
 * Refresh macro bias from data-service when MTF_BIAS webhooks haven't arrived.
 * Used as backup/validation when macro_updated_at is stale.
 *
 * @param {string} userId
 * @param {string} symbol
 * @returns {Promise<{ refreshed: boolean, reason?: string }>}
 */
async function refreshIfStale(userId, symbol) {
  if (!ENABLED) return { refreshed: false, reason: 'disabled' };

  const state = await symbolStateService.getState(userId, symbol);
  const macroUpdatedAt = state?.macro_updated_at;

  if (!macroUpdatedAt) {
    // No macro ever — always try to seed
    return refreshFromDataService(userId, symbol);
  }

  const macroAgeMs = Date.now() - new Date(macroUpdatedAt).getTime();
  if (macroAgeMs <= STALE_THRESHOLD_MS) {
    return { refreshed: false, reason: 'macro_fresh' };
  }

  return refreshFromDataService(userId, symbol);
}

/**
 * Fetch regime from data-service and update symbol_state.
 * If regime fails (e.g. CBOE circuit breaker), fall back to macro-only with NEUTRAL
 * to at least refresh macro_updated_at and unblock staleness.
 *
 * @param {string} userId
 * @param {string} symbol
 * @returns {Promise<{ refreshed: boolean, reason?: string }>}
 */
async function refreshFromDataService(userId, symbol) {
  try {
    const response = await dataServiceProxy.getRegime();
    const regime = response?.data ?? response;
    if (regime?.tradingBias) {
      const payload = regimeToMtfPayload(regime);
      payload.ticker = symbol;
      await symbolStateService.update('DATA_SERVICE_MACRO', payload, userId, symbol);
      logger.info(
        `[MACRO_BACKFILL] ${symbol}: refreshed from data-service — bias=${regime.tradingBias} regime=${regime.regime} vix=${regime.vixLevel ?? 'N/A'}`,
        'macro-regime-backfill'
      );
      return { refreshed: true, bias: regime.tradingBias };
    }

    // Regime failed (e.g. CBOE circuit breaker) — try macro-only as fallback
    const macroRes = await dataServiceProxy.getMacro();
    const macro = macroRes?.data ?? macroRes;
    if (macro != null) {
      const payload = regimeToMtfPayload({ tradingBias: 'neutral', regime: 'normal' });
      payload.ticker = symbol;
      payload._source = 'data_service_macro_fallback';
      await symbolStateService.update('DATA_SERVICE_MACRO', payload, userId, symbol);
      logger.info(
        `[MACRO_BACKFILL] ${symbol}: regime unavailable, refreshed with NEUTRAL from macro (FRED) — unblocks staleness`,
        'macro-regime-backfill'
      );
      return { refreshed: true, bias: 'neutral' };
    }

    logger.warn(
      `[MACRO_BACKFILL] ${symbol}: regime missing tradingBias and macro unavailable — skipping`,
      'macro-regime-backfill'
    );
    return { refreshed: false, reason: 'no_trading_bias' };
  } catch (err) {
    logger.warn(
      `[MACRO_BACKFILL] ${symbol}: data-service unavailable — ${err.message}`,
      'macro-regime-backfill'
    );
    return { refreshed: false, reason: 'data_service_error', error: err.message };
  }
}

module.exports = {
  refreshIfStale,
  refreshFromDataService,
  regimeToMtfPayload,
};
