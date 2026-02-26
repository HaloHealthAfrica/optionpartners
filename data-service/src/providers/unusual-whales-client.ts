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
  GexData,
  GexLevel,
  OptionsFlowSummary,
  OptionsFlowTick,
  IVData,
  Timeframe,
} from '../types';

// --- Unusual Whales API response shapes ---

interface UWOptionsChainResponse {
  data: Array<{
    option_symbol: string;
    underlying_symbol: string;
    option_type: string;
    strike: number;
    expiry: string;
    bid: number;
    ask: number;
    mid_price: number;
    last_price: number;
    volume: number;
    open_interest: number;
    implied_volatility: number;
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  }>;
}

interface UWGexResponse {
  data: {
    total_gex: number;
    call_gex: number;
    put_gex: number;
    net_gex: number;
    flip_price: number | null;
    levels: Array<{
      strike: number;
      gex: number;
      call_gex: number;
      put_gex: number;
    }>;
  };
}

interface UWFlowResponse {
  data: {
    total_premium: number;
    call_premium: number;
    put_premium: number;
    net_premium: number;
    call_volume: number;
    put_volume: number;
    put_call_ratio: number;
    sentiment: string;
    trades: Array<{
      option_symbol: string;
      underlying_symbol: string;
      option_type: string;
      strike: number;
      expiry: string;
      side: string;
      sentiment: string;
      premium: number;
      size: number;
      open_interest: number;
      volume: number;
      implied_volatility: number;
      executed_at: string;
    }>;
  };
}

interface UWIVResponse {
  data: {
    current_iv: number;
    iv_rank: number;
    iv_percentile: number;
    hv_30: number;
    hv_60: number;
    hv_90: number;
  };
}

export class UnusualWhalesClient extends BaseProvider implements MarketDataProvider {
  readonly name: ProviderName = 'unusual_whales';
  readonly capabilities: ProviderCapabilities = {
    candles: false,
    quotes: false,
    optionsChain: true,
    gex: true,
    flow: true,
    iv: true,
    vix: false,
    marketHours: false,
  };

  private authHeaders: Record<string, string>;

  constructor() {
    super({
      name: 'unusual_whales',
      priority: 'primary',
      apiKey: config.unusualWhales.apiKey,
      baseUrl: config.unusualWhales.baseUrl,
      rateLimit: config.unusualWhales.rateLimit,
      rateLimitWindow: 60_000,
      capabilities: {
        candles: false,
        quotes: false,
        optionsChain: true,
        gex: true,
        flow: true,
        iv: true,
        vix: false,
        marketHours: false,
      },
      circuitBreaker: {
        failureThreshold: 5,
        resetTimeoutMs: 60_000,
        halfOpenMaxAttempts: 2,
      },
    });

    this.authHeaders = {
      Authorization: `Bearer ${config.unusualWhales.apiKey}`,
      Accept: 'application/json',
    };
  }

  async getQuote(_symbol: string): Promise<Quote> {
    throw new ProviderError(this.name, 'NOT_SUPPORTED', 'UW does not provide stock quotes');
  }

  async getCandles(_symbol: string, _timeframe: Timeframe, _limit?: number): Promise<Candle[]> {
    throw new ProviderError(this.name, 'NOT_SUPPORTED', 'UW does not provide candles');
  }

  async getOptionsChain(symbol: string, expiration?: string): Promise<OptionsChain> {
    const params: Record<string, unknown> = {};
    if (expiration) params.expiry = expiration;

    const response = await this.request<UWOptionsChainResponse>(
      'GET',
      `/api/stock/${symbol}/option-contracts`,
      params,
      this.authHeaders,
    );

    if (!response?.data) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty options chain for ${symbol}`);
    }

    const expirations = [...new Set(response.data.map((c) => c.expiry))].sort();

    const contracts: OptionsContract[] = response.data.map((c) => ({
      symbol: c.option_symbol,
      underlyingSymbol: c.underlying_symbol,
      type: c.option_type.toLowerCase() as 'call' | 'put',
      strike: c.strike,
      expiration: c.expiry,
      bid: c.bid,
      ask: c.ask,
      mid: c.mid_price,
      last: c.last_price,
      volume: c.volume,
      openInterest: c.open_interest,
      impliedVolatility: c.implied_volatility,
      delta: c.delta,
      gamma: c.gamma,
      theta: c.theta,
      vega: c.vega,
    }));

    return { symbol, expirations, contracts, timestamp: Date.now() };
  }

  async getGEX(symbol: string): Promise<GexData> {
    const response = await this.request<UWGexResponse>(
      'GET',
      `/api/stock/${symbol}/gamma-exposure`,
      {},
      this.authHeaders,
    );

    if (!response?.data) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty GEX response for ${symbol}`);
    }

    const { data } = response;

    const majorLevels: GexLevel[] = (data.levels || [])
      .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
      .slice(0, 20)
      .map((level) => ({
        strike: level.strike,
        gex: level.gex,
        callGex: level.call_gex,
        putGex: level.put_gex,
        type: this.classifyGexLevel(level, data.flip_price),
      }));

    return {
      symbol,
      totalGex: data.total_gex,
      callGex: data.call_gex,
      putGex: data.put_gex,
      netGex: data.net_gex,
      flipPrice: data.flip_price,
      majorLevels,
      timestamp: Date.now(),
    };
  }

  async getFlow(symbol: string): Promise<OptionsFlowSummary> {
    const response = await this.request<UWFlowResponse>(
      'GET',
      `/api/stock/${symbol}/flow`,
      {},
      this.authHeaders,
    );

    if (!response?.data) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty flow response for ${symbol}`);
    }

    const { data } = response;

    const largestTrades: OptionsFlowTick[] = (data.trades || [])
      .sort((a, b) => b.premium - a.premium)
      .slice(0, 10)
      .map((t) => ({
        symbol: t.underlying_symbol,
        contractSymbol: t.option_symbol,
        type: t.option_type.toLowerCase() as 'call' | 'put',
        strike: t.strike,
        expiration: t.expiry,
        side: this.normalizeSide(t.side),
        sentiment: this.normalizeSentiment(t.sentiment),
        premium: t.premium,
        size: t.size,
        openInterest: t.open_interest,
        volume: t.volume,
        impliedVolatility: t.implied_volatility,
        timestamp: new Date(t.executed_at).getTime(),
      }));

    return {
      symbol,
      totalPremium: data.total_premium,
      callPremium: data.call_premium,
      putPremium: data.put_premium,
      netPremium: data.net_premium,
      callVolume: data.call_volume,
      putVolume: data.put_volume,
      putCallRatio: data.put_call_ratio,
      largestTrades,
      sentiment: this.normalizeSentiment(data.sentiment),
      timestamp: Date.now(),
    };
  }

  async getIV(symbol: string): Promise<IVData> {
    const response = await this.request<UWIVResponse>(
      'GET',
      `/api/stock/${symbol}/volatility`,
      {},
      this.authHeaders,
    );

    if (!response?.data) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty IV response for ${symbol}`);
    }

    const { data } = response;

    return {
      symbol,
      currentIV: data.current_iv,
      ivRank: data.iv_rank,
      ivPercentile: data.iv_percentile,
      historicalIV30: data.hv_30,
      historicalIV60: data.hv_60,
      historicalIV90: data.hv_90,
      timestamp: Date.now(),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request('GET', '/api/stock/SPY/option-contracts', { limit: 1 }, this.authHeaders);
      return true;
    } catch {
      return false;
    }
  }

  private classifyGexLevel(
    level: { strike: number; gex: number; call_gex: number; put_gex: number },
    flipPrice: number | null,
  ): GexLevel['type'] {
    if (flipPrice && Math.abs(level.strike - flipPrice) / flipPrice < 0.002) {
      return 'flip';
    }
    if (level.gex > 0 && level.call_gex > level.put_gex) return 'resistance';
    if (level.gex > 0 && level.put_gex > level.call_gex) return 'support';
    return 'pin';
  }

  private normalizeSide(side: string): 'bid' | 'ask' | 'mid' {
    const s = side.toLowerCase();
    if (s.includes('bid') || s === 'below') return 'bid';
    if (s.includes('ask') || s === 'above') return 'ask';
    return 'mid';
  }

  private normalizeSentiment(sentiment: string): 'bullish' | 'bearish' | 'neutral' {
    const s = sentiment.toLowerCase();
    if (s.includes('bull')) return 'bullish';
    if (s.includes('bear')) return 'bearish';
    return 'neutral';
  }
}
