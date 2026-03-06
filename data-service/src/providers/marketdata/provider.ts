import { BaseProvider, ProviderError } from '../base-provider';
import { config } from '../../config';
import { MarketDataClient } from './client';
import type {
  MarketDataProvider as IMarketDataProvider,
  ProviderName,
  ProviderCapabilities,
  Candle,
  Quote,
  OptionsChain,
  OptionsContract,
  Timeframe,
} from '../../types';

export class MarketDataAppProvider extends BaseProvider implements IMarketDataProvider {
  readonly name: ProviderName = 'marketdata';
  readonly capabilities: ProviderCapabilities = {
    candles: false,
    quotes: false,
    optionsChain: true,
    gex: false,
    flow: false,
    iv: false,
    vix: false,
    marketHours: false,
  };

  private readonly mdClient: MarketDataClient;

  constructor() {
    super({
      name: 'marketdata',
      priority: 'primary',
      apiKey: config.marketData.apiToken,
      baseUrl: config.marketData.baseUrl || 'https://api.marketdata.app',
      rateLimit: Number(config.marketData.rateLimit) || 100,
      rateLimitWindow: 60_000,
      capabilities: {
        candles: false,
        quotes: false,
        optionsChain: true,
        gex: false,
        flow: false,
        iv: false,
        vix: false,
        marketHours: false,
      },
      circuitBreaker: {
        failureThreshold: 5,
        resetTimeoutMs: 60_000,
        halfOpenMaxAttempts: 2,
      },
    });

    this.mdClient = new MarketDataClient(config.marketData.apiToken);
  }

  async getQuote(_symbol: string): Promise<Quote> {
    throw new ProviderError(this.name, 'NOT_SUPPORTED', 'MarketData.app does not provide stock quotes');
  }

  async getCandles(_symbol: string, _timeframe: Timeframe, _limit?: number): Promise<Candle[]> {
    throw new ProviderError(this.name, 'NOT_SUPPORTED', 'MarketData.app does not provide candles');
  }

  private expirationCache = new Map<string, { data: string[]; fetchedAt: number }>();
  private static EXPIRATION_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

  async getOptionsChain(symbol: string, expiration?: string): Promise<OptionsChain> {
    let expirationDate = expiration;

    if (!expirationDate) {
      const cached = this.expirationCache.get(symbol);
      let expirations: string[];
      if (cached && Date.now() - cached.fetchedAt < MarketDataAppProvider.EXPIRATION_CACHE_TTL) {
        expirations = cached.data;
      } else {
        expirations = await this.mdClient.getExpirations(symbol);
        this.expirationCache.set(symbol, { data: expirations, fetchedAt: Date.now() });
      }
      if (!expirations.length) {
        throw new ProviderError(this.name, 'PARSE_ERROR', `No expiration dates for ${symbol}`);
      }
      const today = new Date().toISOString().split('T')[0];
      const futureExpiries = expirations.filter(d => d >= today).sort();
      expirationDate = futureExpiries[0] || expirations[expirations.length - 1];
    }

    // strikeLimit=40 → 40 strikes above + 40 below ATM = ~80 strikes × 2 sides = ~160 contracts
    // minBid=0.01 → skip worthless far-OTM options
    // This reduces a ~5000-contract SPY chain to ~160 contracts (97% credit savings)
    const rawContracts = await this.mdClient.getOptionChain(symbol, expirationDate, undefined, {
      strikeLimit: 40,
      minBid: 0.01,
    });

    if (!rawContracts.length) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty options chain for ${symbol}`);
    }

    const expirationSet = new Set<string>();
    const contracts: OptionsContract[] = rawContracts.map(c => {
      expirationSet.add(c.expiration);
      return {
        symbol: c.optionSymbol,
        underlyingSymbol: c.underlying,
        type: c.side,
        strike: c.strike,
        expiration: c.expiration,
        bid: c.bid,
        ask: c.ask,
        mid: c.mid,
        last: c.last,
        volume: c.volume,
        openInterest: c.openInterest,
        impliedVolatility: c.iv,
        delta: c.delta,
        gamma: c.gamma,
        theta: c.theta,
        vega: c.vega,
      };
    });

    this.log.info(
      { symbol, contracts: contracts.length, expirations: expirationSet.size },
      'MarketData.app options chain fetched with real-time Greeks',
    );

    return {
      symbol,
      expirations: [...expirationSet].sort(),
      contracts,
      timestamp: Date.now(),
    };
  }

  async healthCheck(): Promise<boolean> {
    return this.mdClient.healthCheck();
  }
}
