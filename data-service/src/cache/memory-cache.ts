import NodeCache from 'node-cache';
import { createChildLogger } from '../utils/logger';
import { config } from '../config';
import type { DataType } from '../types';

const log = createChildLogger('memory-cache');

// default TTLs (seconds)
const DEFAULT_TTL_MAP: Record<DataType, number> = {
  // reduced TTLs for high‑velocity data
  quote: 10,
  candles: 20,
  options_chain: 180,
  gex: 270,
  flow: 270,
  iv: 540,
  vix: 300,
  macro: 3600,
  underlying: 2,
  expirations: 86400,
  chain: 270,
  quotes: 30,
  greeks: 270,
  hist_candles: 86400,
  hist_metrics: 21600,
  hist_regime: 900,
  circuit: 86400, // Circuit breaker states persist for 24 hours
  ratelimit: 3600, // Rate limiter states persist for 1 hour
};

function resolveTtl(dataType: DataType): number {
  const override = config.cache?.ttl?.[dataType];
  if (override && override > 0) {
    return override;
  }
  return DEFAULT_TTL_MAP[dataType] ?? 30;
}

export class MemoryCache {
  private cache: NodeCache;

  constructor() {
    this.cache = new NodeCache({ checkperiod: 30, useClones: false });
    log.info('Memory cache initialized (fallback mode)');
  }

  get<T>(dataType: DataType, key: string): { data: T; provider?: string } | undefined {
    const fullKey = `${dataType}:${key}`;
    return this.cache.get<{ data: T; provider?: string }>(fullKey);
  }

  set<T>(dataType: DataType, key: string, value: { data: T; provider?: string } | T): void {
    const fullKey = `${dataType}:${key}`;
    const ttl = resolveTtl(dataType);
    const payload = (value && (value as any).data !== undefined)
      ? value
      : { data: value as T };
    this.cache.set(fullKey, payload, ttl);
    log.debug({ key: fullKey, ttl }, 'Cache set');
  }

  invalidate(dataType: DataType, key: string): void {
    this.cache.del(`${dataType}:${key}`);
  }

  flush(): void {
    this.cache.flushAll();
    log.info('Cache flushed');
  }

  getStats() {
    return this.cache.getStats();
  }
}

export const memoryCache = new MemoryCache();
