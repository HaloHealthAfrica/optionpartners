import type { Candle } from '../types';

/**
 * Average True Range over `period` candles.
 * Requires at least `period + 1` candles (need prior close for first TR).
 */
export function computeATR(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 0;

  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const trValues: number[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prevClose = sorted[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose),
    );
    trValues.push(tr);
  }

  if (trValues.length < period) return 0;

  let atr = trValues.slice(0, period).reduce((s, v) => s + v, 0) / period;

  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + trValues[i]) / period;
  }

  return atr;
}

/**
 * Realized (historical) volatility using close-to-close log returns,
 * annualized to 252 trading days.
 */
export function computeRealizedVol(candles: Candle[], window: number): number {
  if (candles.length < window + 1) return 0;

  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const tail = sorted.slice(-(window + 1));

  const logReturns: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    if (tail[i - 1].close <= 0 || tail[i].close <= 0) continue;
    logReturns.push(Math.log(tail[i].close / tail[i - 1].close));
  }

  if (logReturns.length < 2) return 0;

  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const variance =
    logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (logReturns.length - 1);

  return Math.sqrt(variance * 252);
}

/**
 * Percentile rank of `value` within a series using the nearest-rank method.
 *
 * Method: count the number of observations strictly below `value`,
 * divide by total observations. Returns 0..1.
 *
 * This is deterministic: given the same series and value the output is
 * always identical regardless of element ordering, since we only count.
 * Ties are handled consistently — equal values are NOT counted as "below".
 *
 * Reference: "Nearest-rank" percentile as defined by NIST Engineering
 * Statistics Handbook, Section 2.6.1.
 */
export function computePercentile(series: number[], value: number): number {
  if (series.length === 0) return 0;
  let below = 0;
  for (let i = 0; i < series.length; i++) {
    if (series[i] < value) below++;
  }
  return below / series.length;
}

/**
 * EMA slope: difference between current EMA and its value `lookback` periods ago,
 * normalised by the earlier EMA value.  Positive = uptrend, negative = downtrend.
 */
export function computeEMASlope(candles: Candle[], emaPeriod: number, lookback: number): number {
  if (candles.length < emaPeriod + lookback) return 0;

  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const closes = sorted.map((c) => c.close);

  const k = 2 / (emaPeriod + 1);
  const emaValues: number[] = [];
  let ema = closes[0];

  for (let i = 0; i < closes.length; i++) {
    ema = i === 0 ? closes[0] : closes[i] * k + ema * (1 - k);
    emaValues.push(ema);
  }

  const current = emaValues[emaValues.length - 1];
  const prior = emaValues[emaValues.length - 1 - lookback];

  if (!prior || prior === 0) return 0;
  return (current - prior) / prior;
}
