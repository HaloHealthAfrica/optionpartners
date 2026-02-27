'use strict';

const { normalizePayload } = require('../webhooks/normalizers');
const { normalizeDirection } = require('../webhooks/indicator-detector');

/**
 * Internal signal contract -- normalized from any webhook source.
 *
 * @typedef {Object} SimSignal
 * @property {string} symbol       - Ticker (e.g. "SPY")
 * @property {'BUY'|'SELL'|'CLOSE'} action
 * @property {'CALL'|'PUT'|'CREDIT_SPREAD'|'STOCK'} contractType
 * @property {number} [strike]
 * @property {number} [strikeShort] - Short strike for spreads
 * @property {number} [strikeLong]  - Long strike for spreads
 * @property {string} [expiration]  - ISO date string
 * @property {number} [quantity]    - Contract count (default 1)
 * @property {string} strategy      - Strategy name (e.g. "ORB", "Failed2", "GammaDealer")
 * @property {number} [limitPrice]
 * @property {number} [stopLoss]
 * @property {number} [takeProfit]
 * @property {number} [bidPrice]
 * @property {number} [askPrice]
 * @property {number} [midPrice]
 * @property {number} [delta]
 * @property {string} [indicatorSource] - Which indicator produced this signal
 * @property {'long'|'short'|null} [direction] - Normalized direction from indicator
 * @property {number|null} [score]     - Indicator quality score
 * @property {number|null} [confidence] - Indicator confidence (0-100)
 * @property {Object} [meta]       - Arbitrary metadata from webhook
 */

/**
 * Map raw webhook payload into internal signal contract.
 * Deterministic: same input always produces same output.
 *
 * This is the legacy mapper for generic TradingView alert payloads that
 * include an explicit `action` field. For indicator-specific payloads
 * use {@link mapIndicatorToSignal} instead.
 */
function mapToSignal(payload) {
  const action = (payload.action || payload.order_action || '').toUpperCase();
  const symbol = (payload.ticker || payload.symbol || '').toUpperCase();
  const contractType = resolveContractType(payload);

  return {
    symbol,
    action: action === 'CLOSE' ? 'CLOSE' : action,
    contractType,
    strike: parseFloat(payload.strike) || null,
    strikeShort: parseFloat(payload.strike_short) || null,
    strikeLong: parseFloat(payload.strike_long) || null,
    expiration: payload.expiration || payload.expiry || null,
    quantity: parseInt(payload.quantity || payload.contracts, 10) || 1,
    strategy: payload.strategy || payload.alert_name || 'UNKNOWN',
    limitPrice: parseFloat(payload.limit_price) || null,
    stopLoss: parseFloat(payload.stop_loss) || null,
    takeProfit: parseFloat(payload.take_profit) || null,
    bidPrice: parseFloat(payload.bid) || null,
    askPrice: parseFloat(payload.ask) || null,
    midPrice: parseFloat(payload.mid) || null,
    delta: parseFloat(payload.delta) || null,
    indicatorSource: null,
    direction: normalizeDirection(payload.direction),
    score: null,
    confidence: null,
    meta: {
      source: 'tradingview',
      originalPayload: payload,
      mappedAt: new Date().toISOString(),
    },
  };
}

/**
 * Map a raw webhook payload through the indicator-aware pipeline.
 * Detects the source indicator, runs the source-specific normalizer,
 * and returns a SimSignal enriched with indicator context.
 *
 * @param {Object} payload - Raw webhook payload
 * @returns {{ signal: SimSignal, source: string, validation: { valid: boolean, errors: string[] }, normalized: Object }}
 */
function mapIndicatorToSignal(payload) {
  const { source, normalized, validation } = normalizePayload(payload);

  if (!validation.valid) {
    return { signal: null, source, validation, normalized };
  }

  const contractType = resolveContractType(payload);

  const signal = {
    symbol: normalized.symbol,
    action: normalized.action || '',
    contractType,
    strike: parseFloat(payload.strike) || null,
    strikeShort: parseFloat(payload.strike_short) || null,
    strikeLong: parseFloat(payload.strike_long) || null,
    expiration: payload.expiration || payload.expiry || null,
    quantity: parseInt(payload.quantity || payload.contracts, 10) || 1,
    strategy: normalized.strategy,
    limitPrice: normalized.entry,
    stopLoss: normalized.stop,
    takeProfit: normalized.targets[0] || null,
    bidPrice: parseFloat(payload.bid) || null,
    askPrice: parseFloat(payload.ask) || null,
    midPrice: parseFloat(payload.mid) || null,
    delta: parseFloat(payload.delta) || null,
    indicatorSource: source,
    direction: normalized.direction,
    score: normalized.score,
    confidence: normalized.confidence,
    meta: {
      source: 'tradingview',
      indicatorSource: source,
      timeframe: normalized.timeframe,
      timestamp: normalized.timestamp,
      targets: normalized.targets,
      indicatorMeta: normalized.indicatorMeta,
      originalPayload: payload,
      mappedAt: new Date().toISOString(),
    },
  };

  return { signal, source, validation, normalized };
}

function resolveContractType(payload) {
  const type = (payload.contract_type || payload.instrument_type || payload.type || '').toUpperCase();
  if (type === 'CALL' || type === 'C') return 'CALL';
  if (type === 'PUT' || type === 'P') return 'PUT';
  if (type === 'CREDIT_SPREAD' || type === 'SPREAD') return 'CREDIT_SPREAD';
  if (type === 'STOCK' || type === 'EQUITY') return 'STOCK';

  if (payload.strike && payload.expiration) {
    if (payload.strike_short && payload.strike_long) return 'CREDIT_SPREAD';
    return payload.option_type?.toUpperCase() === 'PUT' ? 'PUT' : 'CALL';
  }

  // No explicit type and no strike/expiration — needs options construction.
  // Returns null instead of silently defaulting to STOCK.
  return null;
}

/**
 * Validate a mapped signal for completeness.
 *
 * contractType === null means the signal needs options construction;
 * skip options-field validation in that case (constructor will fill them in).
 */
function validateSignal(signal) {
  const errors = [];

  if (!signal.symbol) errors.push('Missing symbol');
  if (!['BUY', 'SELL', 'CLOSE'].includes(signal.action)) errors.push(`Invalid action: ${signal.action}`);

  // null contractType is valid — it means "pending construction"
  if (signal.contractType !== null && !['CALL', 'PUT', 'CREDIT_SPREAD', 'STOCK'].includes(signal.contractType)) {
    errors.push(`Invalid contract type: ${signal.contractType}`);
  }

  // Only enforce options fields when contractType is already resolved
  if (signal.contractType && signal.contractType !== 'STOCK') {
    if (!signal.expiration) errors.push('Options/spreads require expiration date');
    if (signal.contractType === 'CREDIT_SPREAD') {
      if (!signal.strikeShort || !signal.strikeLong) {
        errors.push('Credit spreads require strikeShort and strikeLong');
      }
    } else if (!signal.strike) {
      errors.push('Options require strike price');
    }
  }

  if (signal.quantity < 1) errors.push('Quantity must be >= 1');

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  mapToSignal,
  mapIndicatorToSignal,
  validateSignal,
  resolveContractType,
};
