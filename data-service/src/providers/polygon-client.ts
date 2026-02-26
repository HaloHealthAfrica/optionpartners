import { BaseProvider, ProviderError } from './base-provider';
import { config } from '../config';
import type {
  MarketDataProvider,
  ProviderName,
  ProviderCapabilities,
  Candle,
  Quote,
  Timeframe,
} from '../types';

interface PolygonAggregateResponse {
  results: Array<{
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    t: number;
  }>;
  resultsCount: number;
  status: string;
}

interface PolygonSnapshotResponse {
  ticker: {
    ticker: string;
    day: { o: number; h: number; l: number; c: number; v: number };
    lastTrade: { p: number; t: number };
    prevDay: { c: number };
    todaysChange: number;
    todaysChangePerc: number;
    updated: number;
  };
  status: string;
}

const TIMEFRAME_MAP: Record<Timeframe, { multiplier: number; timespan: string }> = {
  '1min': { multiplier: 1, timespan: 'minute' },
  '5min': { multiplier: 5, timespan: 'minute' },
  '15min': { multiplier: 15, timespan: 'minute' },
  '30min': { multiplier: 30, timespan: 'minute' },
  '1h': { multiplier: 1, timespan: 'hour' },
  '4h': { multiplier: 4, timespan: 'hour' },
  '1day': { multiplier: 1, timespan: 'day' },
  '1week': { multiplier: 1, timespan: 'week' },
};

export class PolygonClient extends BaseProvider implements MarketDataProvider {
  readonly name: ProviderName = 'polygon';
  readonly capabilities: ProviderCapabilities = {
    candles: true,
    quotes: true,
    optionsChain: false,
    gex: false,
    flow: false,
    iv: false,
    vix: false,
    marketHours: false,
  };

  constructor() {
    super({
      name: 'polygon',
      priority: 'tertiary',
      apiKey: config.polygon.apiKey,
      baseUrl: config.polygon.baseUrl,
      rateLimit: config.polygon.rateLimit,
      rateLimitWindow: 60_000,
      capabilities: {
        candles: true,
        quotes: true,
        optionsChain: false,
        gex: false,
        flow: false,
        iv: false,
        vix: false,
        marketHours: false,
      },
      circuitBreaker: {
        failureThreshold: 3,
        resetTimeoutMs: 120_000,
        halfOpenMaxAttempts: 1,
      },
    });
  }

  async getQuote(symbol: string): Promise<Quote> {
    const data = await this.request<PolygonSnapshotResponse>(
      'GET',
      `/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`,
      { apiKey: config.polygon.apiKey },
    );

    if (!data?.ticker) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty snapshot for ${symbol}`);
    }

    const t = data.ticker;
    return {
      symbol: t.ticker,
      price: t.lastTrade.p,
      open: t.day.o,
      high: t.day.h,
      low: t.day.l,
      previousClose: t.prevDay.c,
      change: t.todaysChange,
      changePercent: t.todaysChangePerc,
      volume: t.day.v,
      timestamp: t.updated,
    };
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit = 100): Promise<Candle[]> {
    const { multiplier, timespan } = TIMEFRAME_MAP[timeframe];

    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - this.calcLookbackDays(timeframe, limit));

    const fromStr = from.toISOString().split('T')[0];
    const toStr = to.toISOString().split('T')[0];

    const data = await this.request<PolygonAggregateResponse>(
      'GET',
      `/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${fromStr}/${toStr}`,
      {
        adjusted: true,
        sort: 'asc',
        limit,
        apiKey: config.polygon.apiKey,
      },
    );

    if (!data?.results || !Array.isArray(data.results)) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Invalid candle response for ${symbol}`);
    }

    return data.results.map((r) => ({
      timestamp: r.t,
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request('GET', '/v2/snapshot/locale/us/markets/stocks/tickers/SPY', {
        apiKey: config.polygon.apiKey,
      });
      return true;
    } catch {
      return false;
    }
  }

  private calcLookbackDays(timeframe: Timeframe, limit: number): number {
    const barsPerDay: Record<Timeframe, number> = {
      '1min': 390,
      '5min': 78,
      '15min': 26,
      '30min': 13,
      '1h': 7,
      '4h': 2,
      '1day': 1,
      '1week': 0.2,
    };
    return Math.ceil(limit / barsPerDay[timeframe]) + 2;
  }
}
