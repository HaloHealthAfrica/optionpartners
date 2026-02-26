import { DataClient } from '../client';
import type { DataClientConfig, Quote, Candle, GexData, OptionsFlowSummary, MarketRegime, Timeframe } from '../types';

/**
 * Drop-in adapter for the TradePartners backend.
 *
 * Replaces inline calls to Finnhub, Alpha Vantage, Schwab, and Databento
 * with unified DataClient SDK calls. The data service handles provider
 * selection, failover, caching, and rate limiting behind the scenes.
 *
 * Migration:
 *   Before: const { getQuote } = require('../utils/finnhub');
 *   After:  const adapter = new TradePartnersAdapter({ baseUrl, apiKey });
 *           const quote = await adapter.getStockPrice('AAPL');
 */
export class TradePartnersAdapter {
  private client: DataClient;

  constructor(config: DataClientConfig) {
    this.client = new DataClient(config);
  }

  // --- Replaces: finnhub.getQuote() ---
  async getStockPrice(symbol: string): Promise<number> {
    const quote = await this.client.getQuote(symbol);
    return quote.price;
  }

  // --- Replaces: finnhub.getQuote() / schwabMarketData.getQuote() ---
  async getQuote(symbol: string): Promise<{
    c: number;
    d: number;
    dp: number;
    h: number;
    l: number;
    o: number;
    pc: number;
    t: number;
    volume: number;
    source: string;
  }> {
    const q = await this.client.getQuote(symbol);
    return {
      c: q.price,
      d: q.change,
      dp: q.changePercent,
      h: q.high,
      l: q.low,
      o: q.open,
      pc: q.previousClose,
      t: Math.floor(q.timestamp / 1000),
      volume: q.volume,
      source: 'data-service',
    };
  }

  // --- Replaces: finnhub.getBatchQuotes() ---
  async getBatchQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const results: Record<string, Quote> = {};
    const settled = await Promise.allSettled(
      symbols.map((s) => this.client.getQuote(s)),
    );
    for (let i = 0; i < symbols.length; i++) {
      const result = settled[i];
      if (result.status === 'fulfilled') {
        results[symbols[i]] = result.value;
      }
    }
    return results;
  }

  // --- Replaces: finnhub.getStockCandles() / schwabMarketData.getCandles() ---
  async getTradeChartData(
    symbol: string,
    timeframe: Timeframe = '5min',
    limit = 100,
  ): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
    const candles = await this.client.getCandles(symbol, timeframe, limit);
    return candles.map((c: Candle) => ({
      time: Math.floor(c.timestamp / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  // --- Replaces: databento.getFuturesCandles() ---
  async getFuturesCandles(
    symbol: string,
    timeframe: Timeframe = '5min',
    limit = 100,
  ): Promise<Candle[]> {
    return this.client.getCandles(symbol, timeframe, limit);
  }

  // --- New capabilities not available in the old system ---

  async getGEX(symbol: string): Promise<GexData> {
    return this.client.getGEX(symbol);
  }

  async getFlow(symbol: string): Promise<OptionsFlowSummary> {
    return this.client.getFlow(symbol);
  }

  async getMarketRegime(): Promise<MarketRegime> {
    return this.client.getMarketRegime();
  }

  async isMarketOpen(): Promise<boolean> {
    const hours = await this.client.getMarketHours();
    return hours.isOpen;
  }

  async shouldTrade(): Promise<{ canTrade: boolean; reason?: string }> {
    const [hours, regime] = await Promise.all([
      this.client.getMarketHours(),
      this.client.getMarketRegime(),
    ]);

    if (!hours.isOpen) {
      return { canTrade: false, reason: 'Market closed' };
    }
    if (regime.regime === 'crisis') {
      return { canTrade: false, reason: `VIX crisis mode (${regime.vixLevel})` };
    }
    if (regime.tradingBias === 'risk-off') {
      return { canTrade: true, reason: `Caution: risk-off regime (VIX ${regime.vixLevel})` };
    }
    return { canTrade: true };
  }
}
