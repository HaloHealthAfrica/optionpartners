import { createChildLogger } from '../utils/logger';
import { computeEMASlope } from '../analytics/volatility.service';
import { computeDerivedMetrics } from './derived-metrics';
import { fetchCandlesChunked } from '../historical/historical-candles.service';
import { cacheManager } from '../cache';
import type { Candle } from '../types';
import type { RegimeResult, DerivedMetricsResponse } from '../api/v1-schemas';

const log = createChildLogger('regime-engine');

const EMA_SLOPE_THRESHOLD = 0.02;

type HistTf = '1m' | '5m' | '15m' | '1h' | '1d';

const TF_TO_INTERNAL: Record<HistTf, string> = {
  '1m': '1min', '5m': '5min', '15m': '15min', '1h': '1h', '1d': '1day',
};

/**
 * Deterministic regime detection for the v1 historical API layer.
 * Fetches candles via the chunked historical service, computes metrics,
 * classifies regime, and caches the result.
 */
export async function detectRegime(
  symbol: string,
  tf: HistTf = '1d',
  lookback: number = 252,
): Promise<RegimeResult> {
  const cacheKey = `${symbol}:${tf}:${lookback}`;
  const cached = await cacheManager.get<RegimeResult>('hist_regime', cacheKey);
  if (cached) {
    log.info({ symbol, tf, lookback, cacheSource: cached.source }, 'Regime cache hit');
    return cached.data;
  }

  const end = new Date();
  const start = new Date();
  const calendarDays = Math.ceil(lookback * 1.5);
  start.setDate(start.getDate() - calendarDays);

  const result = await fetchCandlesChunked(
    symbol,
    tf,
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10),
  );

  const candles: Candle[] = result.candles.map((c) => ({
    timestamp: c.t,
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
    volume: c.v ?? 0,
  }));

  const internalTf = TF_TO_INTERNAL[tf];
  const metrics = computeDerivedMetrics(symbol, internalTf, candles);
  const regime = classifyRegime(metrics, candles);

  log.info({
    symbol,
    regime: regime.regime,
    hv20: metrics.hv20.toFixed(4),
    hvPercentile: metrics.hvPercentile252.toFixed(2),
    atr14: metrics.atr14.toFixed(4),
    atr30: metrics.atr30.toFixed(4),
    candleCount: candles.length,
  }, 'Regime computed');

  await cacheManager.set('hist_regime', cacheKey, regime);

  return regime;
}

/**
 * Compute metrics only (no regime classification).
 * Used by the /v1/historical/:symbol/metrics endpoint.
 */
export async function computeMetrics(
  symbol: string,
  tf: HistTf = '1d',
  lookback: number = 252,
): Promise<DerivedMetricsResponse> {
  const cacheKey = `${symbol}:${tf}:${lookback}`;
  const cached = await cacheManager.get<DerivedMetricsResponse>('hist_metrics', cacheKey);
  if (cached) {
    log.info({ symbol, tf, lookback, cacheSource: cached.source }, 'Metrics cache hit');
    return cached.data;
  }

  const end = new Date();
  const start = new Date();
  const calendarDays = Math.ceil(lookback * 1.5);
  start.setDate(start.getDate() - calendarDays);

  const result = await fetchCandlesChunked(
    symbol,
    tf,
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10),
  );

  const candles: Candle[] = result.candles.map((c) => ({
    timestamp: c.t,
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
    volume: c.v ?? 0,
  }));

  const internalTf = TF_TO_INTERNAL[tf];
  const metrics = computeDerivedMetrics(symbol, internalTf, candles);

  log.info({ symbol, tf, lookback, candleCount: candles.length }, 'Metrics computed');

  await cacheManager.set('hist_metrics', cacheKey, metrics);

  return metrics;
}

// ---------------------------------------------------------------------------
// Internal classification (same rules as analytics/regime.service.ts)
// ---------------------------------------------------------------------------

function classifyRegime(
  metrics: DerivedMetricsResponse,
  candles: Candle[],
): RegimeResult {
  const rules: string[] = [];
  let regime: RegimeResult['regime'] = 'NEUTRAL';

  const highVolExpansion =
    metrics.hvPercentile252 >= 0.70 && metrics.atr14 > metrics.atr30;

  const lowVolChop =
    metrics.hvPercentile252 <= 0.35 && metrics.atr14 < metrics.atr30;

  let trending = false;
  if (candles.length >= 50) {
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
    ts: Date.now(),
  };
}
