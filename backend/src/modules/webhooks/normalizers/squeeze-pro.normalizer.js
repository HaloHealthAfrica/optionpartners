'use strict';

const { normalizeDirection } = require('../indicator-detector');

const REQUIRED_FIELDS = ['ticker', 'direction', 'close'];

function validate(payload) {
  const errors = [];
  const signalType = (payload.signal_type || '').toUpperCase();

  if (!['ENTRY', 'EXIT'].includes(signalType)) {
    errors.push(`Invalid signal_type: ${payload.signal_type} (expected ENTRY or EXIT)`);
  }

  for (const field of REQUIRED_FIELDS) {
    if (payload[field] == null || payload[field] === '') {
      errors.push(`Missing ${field}`);
    }
  }

  if (signalType === 'ENTRY') {
    const squeeze = payload.squeeze || {};
    if (squeeze.compression_score == null) {
      errors.push('Missing squeeze.compression_score');
    }
  }

  return { valid: errors.length === 0, errors };
}

function normalize(payload) {
  const signalType = (payload.signal_type || '').toUpperCase();
  const isExit = signalType === 'EXIT';
  const symbol = (payload.ticker || '').toUpperCase();
  const direction = normalizeDirection(payload.direction);

  const squeeze = payload.squeeze || {};
  const momentum = payload.momentum || {};
  const trend = payload.trend || {};
  const volumeFilter = payload.volume_filter || {};
  const htf = payload.htf || {};
  const levels = payload.levels || {};

  const compressionScore = parseFloat(squeeze.compression_score) || 0;
  const entry = parseFloat(levels.entry || payload.close) || null;

  // Pick the tighter stop between slow_ema and swing_stop
  let stopLoss = null;
  if (!isExit) {
    const slowEma = parseFloat(trend.slow_ema) || null;
    const swingStop = parseFloat(levels.swing_stop) || null;

    if (slowEma && swingStop && entry) {
      stopLoss = Math.abs(entry - slowEma) < Math.abs(entry - swingStop) ? slowEma : swingStop;
    } else {
      stopLoss = slowEma || swingStop || null;
    }
  }

  const targets = [];
  if (!isExit) {
    const t1 = parseFloat(levels.target_1);
    const t2 = parseFloat(levels.target_2);
    if (!isNaN(t1)) targets.push(t1);
    if (!isNaN(t2)) targets.push(t2);
  }

  // Conviction from compression score:
  //   >= 80 → 85-95   (high compression, explosive)
  //   >= 60 → 65-80   (moderate compression)
  //    < 60 → 50-65   (low compression)
  let confidence;
  if (isExit) {
    confidence = 0;
  } else if (compressionScore >= 80) {
    confidence = Math.min(95, 60 + Math.round(compressionScore * 0.4));
  } else if (compressionScore >= 60) {
    confidence = Math.min(80, 50 + Math.round(compressionScore * 0.35));
  } else {
    confidence = Math.min(65, 40 + Math.round(compressionScore * 0.3));
  }

  const volumeRatio = parseFloat(volumeFilter.volume_ratio) || 0;
  if (!isExit && volumeRatio >= 1.5) {
    confidence = Math.min(100, confidence + 5);
  }

  return {
    source: 'SQUEEZE_PRO',
    symbol,
    direction,
    action: isExit ? 'CLOSE' : (direction === 'long' ? 'BUY' : direction === 'short' ? 'SELL' : null),
    timeframe: payload.interval || null,
    timestamp: payload.time ? parseInt(payload.time, 10) : null,
    entry: isExit ? null : entry,
    stop: stopLoss,
    targets,
    score: compressionScore,
    confidence,
    strategy: 'squeeze_pro',
    indicatorMeta: {
      signalType,
      compressionScore,
      barsCompressed: parseInt(squeeze.bars_compressed, 10) || 0,
      squeezeReleased: squeeze.squeeze_released === true,
      momentum: {
        value: parseFloat(momentum.value) || 0,
        direction: momentum.direction || null,
      },
      trend: {
        fastEma: parseFloat(trend.fast_ema) || null,
        slowEma: parseFloat(trend.slow_ema) || null,
        macroEma: parseFloat(trend.macro_ema) || null,
        alignment: trend.alignment || null,
      },
      volume: {
        currentVolume: parseInt(volumeFilter.current_volume || payload.volume, 10) || null,
        avgVolume20: parseInt(volumeFilter.avg_volume_20, 10) || null,
        ratio: volumeRatio || null,
      },
      htf: {
        timeframe: htf.timeframe || null,
        bias: htf.bias || null,
      },
      exitReason: isExit ? (payload.exit_reason || 'INDICATOR_EXIT') : null,
      exchange: payload.exchange || null,
    },
  };
}

module.exports = { validate, normalize };
