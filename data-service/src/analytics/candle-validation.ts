import type { Candle } from '../types';

const MIN_CANDLE_COVERAGE = 0.85;

export interface CandleValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateCandles(candles: Candle[], expectedCount: number): CandleValidationResult {
  const errors: string[] = [];

  const coverage = candles.length / expectedCount;
  if (coverage < MIN_CANDLE_COVERAGE) {
    errors.push(`Coverage ${(coverage * 100).toFixed(1)}% below ${MIN_CANDLE_COVERAGE * 100}% threshold (${candles.length}/${expectedCount})`);
  }

  const timestamps = candles.map((c) => c.timestamp);
  const uniqueTs = new Set(timestamps);
  if (uniqueTs.size !== timestamps.length) {
    errors.push(`${timestamps.length - uniqueTs.size} duplicate timestamp(s) found`);
  }

  for (let i = 1; i < candles.length; i++) {
    if (candles[i].timestamp < candles[i - 1].timestamp) {
      errors.push('Candles not sorted ascending by timestamp');
      break;
    }
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (isNaN(c.open) || isNaN(c.high) || isNaN(c.low) || isNaN(c.close)) {
      errors.push(`NaN value in candle at index ${i} (ts=${c.timestamp})`);
      break;
    }
    if (c.high < c.low) {
      errors.push(`high < low in candle at index ${i} (ts=${c.timestamp}, high=${c.high}, low=${c.low})`);
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}
