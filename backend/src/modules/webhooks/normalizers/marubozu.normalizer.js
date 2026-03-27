'use strict';

function confidenceToEngineScore(conf) {
  const c = Math.min(1, Math.max(0, Number(conf)));
  if (!Number.isFinite(c)) return 40;
  if (c < 0.7) return 40;
  return Math.round(40 + ((c - 0.7) / 0.3) * 55);
}

function validate(payload) {
  const errors = [];
  const ev = String(payload.event || '').toUpperCase();
  if (ev !== 'MARUBOZU_ENTRY') {
    errors.push(`Invalid event for Marubozu entry: ${payload.event}`);
  }
  const symbol = (payload.symbol || '').toUpperCase();
  if (!symbol) errors.push('Missing symbol');
  if (!payload.signal_id) errors.push('Missing signal_id');

  const dir = String(payload.direction || '').toUpperCase();
  if (dir !== 'CALL' && dir !== 'PUT') errors.push('direction must be CALL or PUT');

  const et = payload.entry?.type;
  if (String(et || '').toUpperCase() !== 'BREAKOUT') {
    errors.push('entry.type must be BREAKOUT');
  }
  const ep = payload.entry?.price;
  if (ep == null || !Number.isFinite(Number(ep))) errors.push('Missing entry.price');

  const stop = payload.risk?.stop;
  if (stop == null || !Number.isFinite(Number(stop))) errors.push('Missing risk.stop');
  const target = payload.risk?.target;
  if (target == null || !Number.isFinite(Number(target))) errors.push('Missing risk.target');

  const strike = payload.strike;
  const exp = payload.expiration;
  if (strike == null || !Number.isFinite(Number(strike)) || Number(strike) <= 0) {
    errors.push('Missing or invalid strike (ingest must pick from chain)');
  }
  if (!exp || typeof exp !== 'string') errors.push('Missing expiration');

  return { valid: errors.length === 0, errors };
}

function normalize(payload) {
  const symbol = (payload.symbol || '').toUpperCase();
  const dir = String(payload.direction || '').toUpperCase();
  const underlyingDir = dir === 'CALL' ? 'long' : 'short';
  const optType = dir === 'PUT' ? 'put' : 'call';
  const stop = Number(payload.risk.stop);
  const targets = [payload.risk?.target].filter((x) => x != null && Number.isFinite(Number(x))).map(Number);
  const entryPx = Number(payload.entry?.price);
  const score = confidenceToEngineScore(payload.confidence);
  const tier = String(payload.tier || '').toUpperCase() === 'A' ? 'A' : 'B';
  const rawDte = parseInt(payload.dte_suggestion, 10);
  const dte = Number.isFinite(rawDte) ? Math.max(1, Math.min(60, rawDte)) : 21;

  return {
    symbol,
    direction: underlyingDir,
    action: 'BUY',
    timeframe: payload.timeframe || null,
    timestamp: payload.timestamp != null ? String(payload.timestamp) : null,
    entry: Number.isFinite(entryPx) ? entryPx : null,
    stop,
    targets,
    score,
    confidence: score,
    strategy: payload.strategy || (tier === 'A' ? 'marubozu_a' : 'marubozu_b'),
    indicatorMeta: {
      event: 'MARUBOZU_ENTRY',
      signal_id: payload.signal_id,
      rank: payload.rank,
      tier,
      batch_strategy: payload.batch_strategy,
      option_type: optType,
      strike: Number(payload.strike),
      dte_suggestion: dte,
      entry_type: 'BREAKOUT',
      bias: payload.context?.bias,
      marubozu: payload.context?.marubozu,
      rr: payload.risk?.rr,
    },
  };
}

module.exports = { validate, normalize };
