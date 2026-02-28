import { describe, it, expect } from 'vitest';
import { computeATR, computeRealizedVol, computePercentile, computeEMASlope } from '../volatility.service';
import { buildDerivedMetrics, detectRegime } from '../regime.service';
import { validateCandles } from '../candle-validation';
import type { Candle, DerivedMetrics } from '../../types';

function makeCandle(ts: number, o: number, h: number, l: number, c: number, v = 1000): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: v };
}

// ──────────────────────────────────────────────
// ATR tests
// ──────────────────────────────────────────────

describe('computeATR', () => {
  it('returns 0 when insufficient data', () => {
    const candles = [makeCandle(1, 100, 102, 99, 101)];
    expect(computeATR(candles, 14)).toBe(0);
  });

  it('computes correct ATR for known data', () => {
    // 16 candles → 15 TR values → ATR(14) uses first 14 as seed + 1 smoothed
    const candles: Candle[] = [];
    let close = 100;
    for (let i = 0; i < 16; i++) {
      const high = close + 2;
      const low = close - 1;
      candles.push(makeCandle(i, close, high, low, close + 0.5));
      close = close + 0.5;
    }

    const atr = computeATR(candles, 14);
    expect(atr).toBeGreaterThan(0);
    expect(atr).toBeLessThan(10);
  });

  it('ATR is deterministic regardless of input order', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push(makeCandle(i, 100 + i, 103 + i, 98 + i, 101 + i));
    }
    const atr1 = computeATR(candles, 14);
    const reversed = [...candles].reverse();
    const atr2 = computeATR(reversed, 14);
    expect(atr1).toBeCloseTo(atr2, 10);
  });
});

// ──────────────────────────────────────────────
// Realized volatility tests
// ──────────────────────────────────────────────

describe('computeRealizedVol', () => {
  it('returns 0 when insufficient data', () => {
    const candles = [makeCandle(1, 100, 102, 99, 101)];
    expect(computeRealizedVol(candles, 20)).toBe(0);
  });

  it('uses log returns and annualises to 252 days', () => {
    // Create 22 candles with known close prices
    const closes = [
      100, 101, 99.5, 102, 98, 103, 97, 104, 100, 101,
      99, 102, 98, 103, 97, 104, 100, 101, 99, 102, 98, 103,
    ];
    const candles = closes.map((c, i) => makeCandle(i, c, c + 1, c - 1, c));
    const hv = computeRealizedVol(candles, 20);

    expect(hv).toBeGreaterThan(0);
    // Annualized vol for these swings should be substantial
    expect(hv).toBeGreaterThan(0.1);
    expect(hv).toBeLessThan(2.0);
  });

  it('is deterministic — same input same output', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      const c = 100 + Math.sin(i) * 5;
      candles.push(makeCandle(i, c, c + 1, c - 1, c));
    }
    const hv1 = computeRealizedVol(candles, 20);
    const hv2 = computeRealizedVol(candles, 20);
    expect(hv1).toBe(hv2);
  });

  it('skips candles with zero or negative close', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      candles.push(makeCandle(i, 100, 102, 99, i === 5 ? 0 : 100 + i * 0.1));
    }
    const hv = computeRealizedVol(candles, 20);
    expect(hv).toBeGreaterThanOrEqual(0);
  });
});

// ──────────────────────────────────────────────
// Percentile tests (nearest-rank method)
// ──────────────────────────────────────────────

describe('computePercentile', () => {
  it('returns 0 for empty series', () => {
    expect(computePercentile([], 50)).toBe(0);
  });

  it('returns 0 when value is the minimum', () => {
    expect(computePercentile([1, 2, 3, 4, 5], 1)).toBe(0);
  });

  it('returns 1.0 when value exceeds all observations', () => {
    expect(computePercentile([1, 2, 3, 4, 5], 6)).toBe(1.0);
  });

  it('returns correct rank for mid-range value', () => {
    // 2 values below 3 out of 5 → 0.4
    expect(computePercentile([1, 2, 3, 4, 5], 3)).toBe(0.4);
  });

  it('handles ties — equal values not counted as below', () => {
    // [1, 2, 2, 2, 5] with value=2 → only 1 below → 0.2
    expect(computePercentile([1, 2, 2, 2, 5], 2)).toBe(0.2);
  });

  it('is deterministic regardless of series order', () => {
    const series = [5, 3, 1, 4, 2];
    const sorted = [1, 2, 3, 4, 5];
    expect(computePercentile(series, 3)).toBe(computePercentile(sorted, 3));
  });

  it('boundary: all same values', () => {
    expect(computePercentile([5, 5, 5, 5], 5)).toBe(0);
    expect(computePercentile([5, 5, 5, 5], 6)).toBe(1.0);
  });
});

// ──────────────────────────────────────────────
// EMA slope tests
// ──────────────────────────────────────────────

describe('computeEMASlope', () => {
  it('returns 0 with insufficient data', () => {
    const candles = [makeCandle(1, 100, 102, 99, 101)];
    expect(computeEMASlope(candles, 20, 10)).toBe(0);
  });

  it('positive slope for uptrending data', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const c = 100 + i * 2;
      candles.push(makeCandle(i, c, c + 1, c - 1, c));
    }
    expect(computeEMASlope(candles, 20, 10)).toBeGreaterThan(0);
  });

  it('negative slope for downtrending data', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const c = 200 - i * 2;
      candles.push(makeCandle(i, c, c + 1, c - 1, c));
    }
    expect(computeEMASlope(candles, 20, 10)).toBeLessThan(0);
  });
});

// ──────────────────────────────────────────────
// Regime classification tests
// ──────────────────────────────────────────────

describe('detectRegime', () => {
  const baseMetrics: DerivedMetrics = {
    symbol: 'SPY',
    timeframe: '1day',
    atr14: 5,
    atr30: 5,
    hv20: 0.20,
    hv60: 0.18,
    hvPercentile252: 0.50,
    computedAt: Date.now(),
  };

  it('classifies HIGH_VOL_EXPANSION when hvPercentile >= 0.70 and atr14 > atr30', () => {
    const metrics = { ...baseMetrics, hvPercentile252: 0.75, atr14: 6, atr30: 4 };
    const snap = detectRegime(metrics);
    expect(snap.regime).toBe('HIGH_VOL_EXPANSION');
    expect(snap.rulesTriggered.length).toBeGreaterThan(0);
  });

  it('classifies LOW_VOL_CHOP when hvPercentile <= 0.35 and atr14 < atr30', () => {
    const metrics = { ...baseMetrics, hvPercentile252: 0.30, atr14: 3, atr30: 5 };
    const snap = detectRegime(metrics);
    expect(snap.regime).toBe('LOW_VOL_CHOP');
  });

  it('classifies NEUTRAL when no thresholds exceeded', () => {
    const snap = detectRegime(baseMetrics);
    expect(snap.regime).toBe('NEUTRAL');
  });

  it('classifies TRENDING when EMA slope exceeds threshold', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const c = 100 + i * 3;
      candles.push(makeCandle(i, c, c + 1, c - 1, c));
    }
    const snap = detectRegime(baseMetrics, candles);
    expect(snap.regime).toBe('TRENDING');
  });

  it('HIGH_VOL_EXPANSION takes priority over TRENDING', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const c = 100 + i * 3;
      candles.push(makeCandle(i, c, c + 1, c - 1, c));
    }
    const metrics = { ...baseMetrics, hvPercentile252: 0.80, atr14: 7, atr30: 4 };
    const snap = detectRegime(metrics, candles);
    expect(snap.regime).toBe('HIGH_VOL_EXPANSION');
  });

  it('includes analyticsVersion and lookback in snapshot', () => {
    const snap = detectRegime(baseMetrics);
    expect(snap.analyticsVersion).toBe('v1');
    expect(snap.timeframe).toBe('1day');
    expect(snap.lookback).toBe(252);
  });

  it('boundary: hvPercentile exactly 0.70 triggers HIGH_VOL if atr14 > atr30', () => {
    const metrics = { ...baseMetrics, hvPercentile252: 0.70, atr14: 6, atr30: 5 };
    const snap = detectRegime(metrics);
    expect(snap.regime).toBe('HIGH_VOL_EXPANSION');
  });

  it('boundary: hvPercentile exactly 0.35 triggers LOW_VOL_CHOP if atr14 < atr30', () => {
    const metrics = { ...baseMetrics, hvPercentile252: 0.35, atr14: 3, atr30: 5 };
    const snap = detectRegime(metrics);
    expect(snap.regime).toBe('LOW_VOL_CHOP');
  });
});

// ──────────────────────────────────────────────
// Candle validation tests
// ──────────────────────────────────────────────

describe('validateCandles', () => {

  it('passes for valid candle set', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 252; i++) {
      candles.push(makeCandle(i, 100, 102, 99, 101));
    }
    const result = validateCandles(candles, 252);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails on low coverage', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 100; i++) {
      candles.push(makeCandle(i, 100, 102, 99, 101));
    }
    const result = validateCandles(candles, 252);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Coverage');
  });

  it('fails on duplicate timestamps', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 252; i++) {
      candles.push(makeCandle(i === 5 ? 4 : i, 100, 102, 99, 101));
    }
    const result = validateCandles(candles, 252);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('duplicate'))).toBe(true);
  });

  it('fails when high < low', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 252; i++) {
      candles.push(makeCandle(i, 100, i === 10 ? 98 : 102, i === 10 ? 99 : 99, 101));
    }
    const result = validateCandles(candles, 252);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('high < low'))).toBe(true);
  });

  it('fails on NaN values', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 252; i++) {
      candles.push(makeCandle(i, 100, 102, 99, i === 3 ? NaN : 101));
    }
    const result = validateCandles(candles, 252);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('NaN'))).toBe(true);
  });
});
