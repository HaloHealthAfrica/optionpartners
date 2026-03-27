'use strict';

const ALLOWED_ENTRY = new Set(['ELITE_SETUP', 'SIGNAL_BULL', 'SIGNAL_BEAR']);

function pickAdvisoryStrike(payload) {
  const strikes = payload.strikes || {};
  const dir = String(payload.direction || '').toUpperCase();
  if (dir === 'LONG') {
    const v = strikes.calls?.itm1 ?? strikes.calls?.itm2 ?? strikes.atm ?? strikes.calls?.atm;
    return v != null ? Number(v) : null;
  }
  if (dir === 'SHORT') {
    const v = strikes.puts?.itm1 ?? strikes.puts?.itm2 ?? strikes.atm ?? strikes.puts?.atm;
    return v != null ? Number(v) : null;
  }
  return null;
}

function pickStop(payload) {
  const dir = String(payload.direction || '').toUpperCase();
  const risk = payload.risk || {};
  const ema = risk.ema_stop != null ? Number(risk.ema_stop) : null;
  const mb = risk.mb_stop != null ? Number(risk.mb_stop) : null;
  if (dir === 'LONG') {
    if (ema != null && mb != null) return Math.max(ema, mb);
    return ema ?? mb ?? null;
  }
  if (dir === 'SHORT') {
    if (ema != null && mb != null) return Math.min(ema, mb);
    return ema ?? mb ?? null;
  }
  return ema ?? mb ?? null;
}

/** Maps grade + payload conviction to engine score (min 40 to pass CRT-style gate in engine). */
function engineConvictionScore(payload) {
  const g = String(payload.grade || '').toUpperCase();
  const c = parseInt(payload.conviction, 10);
  const conv = Number.isFinite(c) ? c : 0;
  if (g === 'ELITE') return 95;
  if (g === 'A') return Math.min(95, 68 + conv * 4);
  if (g === 'B') return Math.min(85, 52 + conv * 4);
  return 50;
}

function validate(payload) {
  const errors = [];
  const symbol = (payload.symbol || '').toUpperCase();
  if (!symbol) errors.push('Missing symbol');

  const ev = String(payload.event || '').toUpperCase();

  if (ev === 'EXIT_SIGNAL') {
    if (String(payload.direction || '').toUpperCase() !== 'FLAT') {
      errors.push('EXIT_SIGNAL requires direction FLAT');
    }
    return { valid: errors.length === 0, errors };
  }

  if (ev === 'TFC_ALIGN') {
    errors.push('TFC_ALIGN is not a trade entry (handled as context in decision router)');
    return { valid: false, errors };
  }

  if (!ALLOWED_ENTRY.has(ev)) {
    errors.push(`Unsupported GolfMedic event for trading: ${payload.event}`);
  }

  const dir = String(payload.direction || '').toUpperCase();
  if (dir !== 'LONG' && dir !== 'SHORT') {
    errors.push('Entry requires direction LONG or SHORT');
  }

  const grade = String(payload.grade || '').toUpperCase();
  if (!['ELITE', 'A', 'B'].includes(grade)) {
    errors.push(`Invalid grade for entry: ${payload.grade}`);
  }

  const priceClose = payload.price?.close;
  if (priceClose == null || !Number.isFinite(Number(priceClose))) {
    errors.push('Missing price.close');
  }

  if (!payload.strikes || typeof payload.strikes !== 'object') {
    errors.push('Missing strikes advisory block');
  } else {
    const k = pickAdvisoryStrike(payload);
    if (k == null || !Number.isFinite(k) || k <= 0) {
      errors.push('Could not derive advisory strike (calls/puts itm1 or atm)');
    }
  }

  const stop = pickStop(payload);
  if (stop == null || !Number.isFinite(stop)) {
    errors.push('Missing risk.ema_stop or risk.mb_stop for stop level');
  }

  return { valid: errors.length === 0, errors };
}

function normalize(payload) {
  const symbol = (payload.symbol || '').toUpperCase();
  const ev = String(payload.event || '').toUpperCase();

  if (ev === 'EXIT_SIGNAL') {
    return {
      source: 'GOLF_MEDIC',
      symbol,
      direction: null,
      action: 'CLOSE',
      timeframe: payload.timeframe || null,
      timestamp: payload.timestamp || null,
      entry: payload.price?.close != null ? Number(payload.price.close) : null,
      stop: null,
      targets: [],
      score: 0,
      confidence: 0,
      strategy: 'golfmedic_exit',
      indicatorMeta: {
        event: ev,
        grade: payload.grade,
        combo: payload.strat?.combo,
        nearest_pivot: payload.nearest_pivot,
      },
    };
  }

  const dir = String(payload.direction || '').toUpperCase() === 'LONG' ? 'long' : 'short';
  const action = dir === 'long' ? 'BUY' : 'SELL';
  const strike = pickAdvisoryStrike(payload);
  const stop = pickStop(payload);
  const targets = [payload.targets?.t1, payload.targets?.t2]
    .filter((x) => x != null && Number.isFinite(Number(x)))
    .map(Number);

  const rawDte = parseInt(payload.strikes?.dte, 10);
  const dte = Number.isFinite(rawDte) ? Math.max(0, Math.min(60, rawDte)) : 7;
  const grade = String(payload.grade || '').toUpperCase();
  const engineScore = engineConvictionScore(payload);
  const optType = dir === 'long' ? 'call' : 'put';

  return {
    source: 'GOLF_MEDIC',
    symbol,
    direction: dir,
    action,
    timeframe: payload.timeframe || null,
    timestamp: payload.timestamp || null,
    entry: payload.price?.close != null ? Number(payload.price.close) : null,
    stop: stop != null ? Number(stop) : null,
    targets,
    score: engineScore,
    confidence: engineScore,
    strategy: grade === 'ELITE' ? 'golfmedic_elite' : 'golfmedic',
    indicatorMeta: {
      event: ev,
      grade,
      conviction: payload.conviction,
      option_type: optType,
      strike: strike != null ? Number(strike) : null,
      dte_suggestion: dte,
      combo: payload.strat?.combo,
      nearest_pivot: payload.nearest_pivot,
    },
  };
}

module.exports = { validate, normalize };
