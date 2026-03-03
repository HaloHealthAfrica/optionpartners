'use strict';

const { detectIndicatorSource } = require('../indicator-detector');
const satyPhase = require('./saty-phase.normalizer');
const strat = require('./strat.normalizer');
const trend = require('./trend.normalizer');
const orb = require('./orb.normalizer');
const signals = require('./signals.normalizer');
const mtfBias = require('./mtf-bias.normalizer');
const pivotMb = require('./pivot-mb.normalizer');
const squeezePro = require('./squeeze-pro.normalizer');
const generic = require('./generic.normalizer');

/**
 * @typedef {Object} NormalizedIndicatorSignal
 * @property {string} source           - Indicator source ID (SATY_PHASE, STRAT, MTF_BIAS, TREND, ORB, SIGNALS, SQUEEZE_PRO, UNKNOWN)
 * @property {string} symbol           - Ticker symbol (uppercased)
 * @property {'long'|'short'|null} direction - Normalized direction
 * @property {'BUY'|'SELL'|'CLOSE'|null} action - Mapped from direction
 * @property {string|null} timeframe   - Chart timeframe
 * @property {number|null} timestamp   - Unix timestamp
 * @property {number|null} entry       - Entry price
 * @property {number|null} stop        - Stop loss level
 * @property {number[]} targets        - Target price levels
 * @property {number|null} score       - Quality/alignment score
 * @property {number|null} confidence  - Confidence (0-100)
 * @property {string} strategy         - Strategy/setup name
 * @property {Object} indicatorMeta    - Source-specific metadata
 */

const NORMALIZERS = {
  SATY_PHASE: satyPhase,
  STRAT: strat,
  MTF_BIAS: mtfBias,
  TREND: trend,
  ORB: orb,
  SIGNALS: signals,
  PIVOT_MB: pivotMb,
  SQUEEZE_PRO: squeezePro,
  UNKNOWN: generic,
};

/**
 * Detect the indicator source and normalize the payload into a standard signal shape.
 *
 * @param {Object} payload - Raw webhook payload
 * @param {string} [sourceOverride] - Force a specific source (skips detection)
 * @returns {{ source: string, normalized: NormalizedIndicatorSignal, validation: { valid: boolean, errors: string[] } }}
 */
function normalizePayload(payload, sourceOverride) {
  const source = sourceOverride || detectIndicatorSource(payload);
  const handler = NORMALIZERS[source] || NORMALIZERS.UNKNOWN;

  const validation = handler.validate(payload);
  if (!validation.valid) {
    return { source, normalized: null, validation };
  }

  const normalized = handler.normalize(payload);
  return { source, normalized, validation };
}

module.exports = {
  normalizePayload,
  NORMALIZERS,
};
