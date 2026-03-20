import { createChildLogger } from '../utils/logger';
import type {
  MarketDataProvider,
  ProviderName,
  ProviderCapabilities,
  ProviderPriority,
  Quote,
  Candle,
  GexData,
  Timeframe,
} from '../types';

const log = createChildLogger('computed-gex');

/**
 * Provider that serves pre-computed GEX data derived from options chain fetches.
 * Zero additional API calls — GEX is computed inside the chain-price-poller
 * and cached here in-memory.
 */
export class ComputedGexProvider implements MarketDataProvider {
  readonly name: ProviderName = 'computed';
  readonly priority: ProviderPriority = 'tertiary';
  readonly capabilities: ProviderCapabilities = {
    candles: false,
    quotes: false,
    optionsChain: false,
    gex: true,
    flow: false,
    iv: false,
    vix: false,
    marketHours: false,
  };

  private cache = new Map<string, { data: GexData; storedAt: number }>();
  private static STALE_MS = 10 * 60 * 1000; // 10 min staleness threshold

  store(gexData: GexData): void {
    this.cache.set(gexData.symbol, { data: gexData, storedAt: Date.now() });
    log.debug({ symbol: gexData.symbol, netGex: Math.round(gexData.netGex) }, 'Computed GEX cached');
  }

  async getGEX(symbol: string): Promise<GexData> {
    const entry = this.cache.get(symbol.toUpperCase());
    if (!entry) {
      throw new Error(`No computed GEX available for ${symbol}`);
    }
    if (Date.now() - entry.storedAt > ComputedGexProvider.STALE_MS) {
      throw new Error(`Computed GEX for ${symbol} is stale (${Math.round((Date.now() - entry.storedAt) / 1000)}s old)`);
    }
    return entry.data;
  }

  async getQuote(_symbol: string): Promise<Quote> {
    throw new Error('ComputedGexProvider does not provide quotes');
  }

  async getCandles(_symbol: string, _tf: Timeframe, _limit?: number): Promise<Candle[]> {
    throw new Error('ComputedGexProvider does not provide candles');
  }

  async healthCheck(): Promise<boolean> {
    return this.cache.size > 0;
  }
}

export const computedGexProvider = new ComputedGexProvider();
