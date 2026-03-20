import { BaseProvider, ProviderError } from './base-provider';
import { config } from '../config';
import type {
  MarketDataProvider,
  ProviderName,
  ProviderCapabilities,
  Candle,
  Quote,
  OptionsChain,
  OptionsContract,
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

interface PolygonOptionsResult {
  break_even_price?: number;
  day?: { close: number; high: number; low: number; open: number; volume: number; vwap: number };
  details?: {
    contract_type: 'call' | 'put';
    exercise_style: string;
    expiration_date: string;
    shares_per_contract: number;
    strike_price: number;
    ticker: string;
  };
  greeks?: { delta: number; gamma: number; theta: number; vega: number };
  implied_volatility?: number;
  last_quote?: { ask: number; ask_size: number; bid: number; bid_size: number; midpoint: number };
  open_interest?: number;
  underlying_asset?: { price: number; ticker: string };
}

interface PolygonOptionsChainResponse {
  results: PolygonOptionsResult[];
  status: string;
  next_url?: string;
}

const POLYGON_OPTIONS_ENABLED = process.env.POLYGON_OPTIONS_ENABLED !== 'false';

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
    optionsChain: POLYGON_OPTIONS_ENABLED,
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
        optionsChain: POLYGON_OPTIONS_ENABLED,
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

  async getOptionsChain(symbol: string, expiration?: string): Promise<OptionsChain> {
    const params: Record<string, unknown> = {
      apiKey: config.polygon.apiKey,
      limit: 250,
    };
    if (expiration) {
      params.expiration_date = expiration;
    }

    // Paginate to collect all contracts (max 250 per page)
    let allResults: PolygonOptionsResult[] = [];
    let url: string | null = `/v3/snapshot/options/${symbol}`;

    while (url && allResults.length < 1000) {
      const isNextPage = url.startsWith('http');
      let data: PolygonOptionsChainResponse;

      if (isNextPage) {
        // next_url is absolute; strip baseUrl prefix and add apiKey
        const nextPath = url.replace(config.polygon.baseUrl, '');
        data = await this.request<PolygonOptionsChainResponse>('GET', nextPath, {
          apiKey: config.polygon.apiKey,
        });
      } else {
        data = await this.request<PolygonOptionsChainResponse>('GET', url, params);
      }

      if (data?.results?.length) {
        allResults = allResults.concat(data.results);
      }

      url = data?.next_url || null;
    }

    if (allResults.length === 0) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty options chain for ${symbol}`);
    }

    const expirationSet = new Set<string>();
    let underlyingPrice = 0;

    // Extract underlying price from the first result that has it
    for (const r of allResults) {
      if (r.underlying_asset?.price) {
        underlyingPrice = r.underlying_asset.price;
        break;
      }
    }

    // Fallback: if underlying price still unknown, fetch from quote
    if (underlyingPrice === 0) {
      try {
        const quote = await this.getQuote(symbol);
        underlyingPrice = quote.price;
        this.log.info({ symbol, underlyingPrice }, 'Underlying price fallback from quote');
      } catch (error) {
        this.log.warn({ symbol, error: error instanceof Error ? error.message : String(error) }, 'Failed to get underlying price from quote fallback');
      }
    }

    const contracts: OptionsContract[] = [];
    for (const r of allResults) {
      if (!r.details) continue;
      const d = r.details;
      expirationSet.add(d.expiration_date);

      const bid = r.last_quote?.bid || 0;
      const ask = r.last_quote?.ask || 0;
      const mid = r.last_quote?.midpoint || (bid && ask ? (bid + ask) / 2 : r.day?.close || 0);

      contracts.push({
        symbol: d.ticker,
        underlyingSymbol: symbol,
        type: d.contract_type,
        strike: d.strike_price,
        expiration: d.expiration_date,
        bid,
        ask,
        mid,
        last: r.day?.close || 0,
        volume: r.day?.volume || 0,
        openInterest: r.open_interest || 0,
        impliedVolatility: r.implied_volatility || 0,
        delta: r.greeks?.delta || 0,
        gamma: r.greeks?.gamma || 0,
        theta: r.greeks?.theta || 0,
        vega: r.greeks?.vega || 0,
      });
    }

    this.log.info(
      { symbol, contracts: contracts.length, expirations: expirationSet.size, underlyingPrice },
      'Polygon options chain fetched with real Greeks',
    );

    return {
      symbol,
      expirations: [...expirationSet].sort(),
      contracts,
      timestamp: Date.now(),
    };
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
