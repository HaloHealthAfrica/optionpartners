import NodeCache from 'node-cache';
import { createChildLogger } from '../utils/logger';
import type { DataType } from '../types';

const log = createChildLogger('memory-cache');

const TTL_MAP: Record<DataType, number> = {
  quote: 15,
  candles: 30,
  options_chain: 270,
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
};

export class MemoryCache {
  private cache: NodeCache;

  constructor() {
    this.cache = new NodeCache({ checkperiod: 30, useClones: false });
    log.info('Memory cache initialized (fallback mode)');
  }

  get<T>(dataType: DataType, key: string): T | undefined {
    const fullKey = `${dataType}:${key}`;
    return this.cache.get<T>(fullKey);
  }

  set<T>(dataType: DataType, key: string, value: T): void {
    const fullKey = `${dataType}:${key}`;
    const ttl = TTL_MAP[dataType] ?? 30;
    this.cache.set(fullKey, value, ttl);
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
