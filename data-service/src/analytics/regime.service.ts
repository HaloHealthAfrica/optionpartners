import type { DerivedMetrics, RegimeSnapshot, VolatilityRegime, Candle } from '../types';
import {
  computeATR,
  computeRealizedVol,
  computePercentile,
  computeEMASlope,
} from './volatility.service';

export const ANALYTICS_VERSION = 'v1';
export const DEFAULT_TIMEFRAME = '1day';
export const DEFAULT_LOOKBACK = 252;

const EMA_SLOPE_THRESHOLD = 0.02; // 2 % move over lookback

/**
 * Build DerivedMetrics from raw daily candles.
 * Expects >=252 candles sorted oldest→newest.
 */
export function buildDerivedMetrics(symbol: string, candles: Candle[]): DerivedMetrics {
  const atr14 = computeATR(candles, 14);
  const atr30 = computeATR(candles, 30);
  const hv20 = computeRealizedVol(candles, 20);
  const hv60 = computeRealizedVol(candles, 60);

  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const hvSeries: number[] = [];
  for (let i = 21; i <= sorted.length; i++) {
    hvSeries.push(computeRealizedVol(sorted.slice(0, i), 20));
  }
  const hvPercentile252 = computePercentile(hvSeries, hv20);

  return {
    symbol,
    timeframe: '1day',
    atr14,
    atr30,
    hv20,
    hv60,
    hvPercentile252,
    computedAt: Date.now(),
  };
}

/**
 * Deterministic regime classification based on derived metrics.
 */
export function detectRegime(metrics: DerivedMetrics, candles?: Candle[]): RegimeSnapshot {
  const rules: string[] = [];
  let regime: VolatilityRegime = 'NEUTRAL';

  const highVolExpansion =
    metrics.hvPercentile252 >= 0.70 && metrics.atr14 > metrics.atr30;

  const lowVolChop =
    metrics.hvPercentile252 <= 0.35 && metrics.atr14 < metrics.atr30;

  let trending = false;
  if (candles && candles.length >= 50) {
    const slope = computeEMASlope(candles, 20, 10);
    trending = Math.abs(slope) > EMA_SLOPE_THRESHOLD;
    if (trending) {
      rules.push(`EMA_SLOPE=${slope.toFixed(4)} exceeds ±${EMA_SLOPE_THRESHOLD}`);
    }
  }

  if (highVolExpansion) {
    regime = 'HIGH_VOL_EXPANSION';
    rules.push(`hvPercentile252=${metrics.hvPercentile252.toFixed(2)} >= 0.70`);
    rules.push(`atr14=${metrics.atr14.toFixed(4)} > atr30=${metrics.atr30.toFixed(4)}`);
  } else if (lowVolChop) {
    regime = 'LOW_VOL_CHOP';
    rules.push(`hvPercentile252=${metrics.hvPercentile252.toFixed(2)} <= 0.35`);
    rules.push(`atr14=${metrics.atr14.toFixed(4)} < atr30=${metrics.atr30.toFixed(4)}`);
  } else if (trending) {
    regime = 'TRENDING';
  } else {
    rules.push('No threshold exceeded');
  }

  return {
    symbol: metrics.symbol,
    regime,
    metrics,
    rulesTriggered: rules,
    computedAt: Date.now(),
    analyticsVersion: ANALYTICS_VERSION,
    timeframe: DEFAULT_TIMEFRAME,
    lookback: DEFAULT_LOOKBACK,
  };
}
