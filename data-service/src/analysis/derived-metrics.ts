import {
  computeATR,
  computeRealizedVol,
  computePercentile,
} from '../analytics/volatility.service';
import type { Candle } from '../types';
import type { DerivedMetricsResponse } from '../api/v1-schemas';

/**
 * Compute derived volatility metrics from candle data.
 * Delegates to the proven functions in analytics/volatility.service.ts.
 */
export function computeDerivedMetrics(
  symbol: string,
  timeframe: string,
  candles: Candle[],
): DerivedMetricsResponse {
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);

  const atr14 = computeATR(sorted, 14);
  const atr30 = computeATR(sorted, 30);
  const hv20 = computeRealizedVol(sorted, 20);
  const hv60 = computeRealizedVol(sorted, 60);

  // Rolling HV20 series for percentile computation
  const hvSeries: number[] = [];
  for (let i = 21; i <= sorted.length; i++) {
    hvSeries.push(computeRealizedVol(sorted.slice(0, i), 20));
  }
  const hvPercentile252 = computePercentile(hvSeries, hv20);

  const startTs = sorted[0]?.timestamp ?? 0;
  const endTs = sorted[sorted.length - 1]?.timestamp ?? 0;

  return {
    symbol,
    timeframe,
    start: new Date(startTs).toISOString().slice(0, 10),
    end: new Date(endTs).toISOString().slice(0, 10),
    atr14,
    atr30,
    hv20,
    hv60,
    hvPercentile252,
    ts: Date.now(),
    source: 'DERIVED',
  };
}
