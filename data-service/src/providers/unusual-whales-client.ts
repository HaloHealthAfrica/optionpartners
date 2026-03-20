import { BaseProvider, ProviderError } from './base-provider';
import { config } from '../config';
import { calculateGreeks, calculateTimeToExpiration } from '../analytics/greeks';
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
    volume: number | string;
    implied_volatility: number | string;
    open_interest: number | string;
    last_price: number | string;
    nbbo_ask: number | string;
    nbbo_bid: number | string;
    ask_volume: number | string;
    avg_price: number | string;
    bid_volume: number | string;
    floor_volume: number | string;
    high_price: number | string;
    low_price: number | string;
    total_premium: number | string;
    prev_oi: number | string;
  }>;
}

/**
 * Parse OCC option symbol: e.g. "SPY260303C00680000"
 * Format: SYMBOL + YYMMDD + C/P + strike*1000 (8 digits)
 */
function parseOptionSymbol(optionSymbol: string): {
  underlying: string;
  expiry: string;
  type: 'call' | 'put';
  strike: number;
} | null {
  const match = optionSymbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, underlying, dateStr, cp, strikeStr] = match;
  const yy = dateStr.slice(0, 2);
  const mm = dateStr.slice(2, 4);
  const dd = dateStr.slice(4, 6);
  return {
    underlying,
    expiry: `20${yy}-${mm}-${dd}`,
    type: cp === 'C' ? 'call' : 'put',
    strike: parseInt(strikeStr, 10) / 1000,
  };
}

interface UWGreeksResponse {
  data: Array<{
    date: string;
    expiry: string;
    strike: string;
    call_delta: string;
    put_delta: string;
    call_gamma: string;
    put_gamma: string;
    call_volatility: string;
    put_volatility: string;
    call_vega: string;
    put_vega: string;
    call_theta: string;
    put_theta: string;
    call_charm: string;
    call_vanna: string;
    put_charm: string;
    put_vanna: string;
    call_rho: string;
    put_rho: string;
    call_option_symbol: string;
    put_option_symbol: string;
  }>;
}

interface UWNetPremTicksResponse {
  data: Array<{
    date: string;
    call_volume: number;
    put_volume: number;
    call_volume_ask_side: number;
    call_volume_bid_side: number;
    put_volume_ask_side: number;
    put_volume_bid_side: number;
    tape_time: string;
    net_call_volume: number;
    net_call_premium: string;
    net_put_volume: number;
    net_put_premium: string;
    net_delta: string;
  }>;
}

interface UWInterpolatedIVResponse {
  data: Array<{
    date: string;
    days: number;
    percentile: string;
    volatility: string;
    implied_move_perc: string;
  }>;
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

    if (!response?.data || !Array.isArray(response.data)) {
      this.log.warn(
        { symbol, responseType: typeof response?.data, responseKeys: response ? Object.keys(response) : [] },
        'Options chain response is not an array — check UW API format',
      );
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty or invalid options chain for ${symbol}`);
    }

    this.log.info({ symbol, rawCount: response.data.length }, 'Parsing UW option-contracts response');

    // First pass: parse all contracts and infer underlying price from put-call parity
    const rawParsed: Array<{
      raw: (typeof response.data)[0];
      parsed: NonNullable<ReturnType<typeof parseOptionSymbol>>;
      bid: number; ask: number; mid: number; iv: number;
    }> = [];
    const expirationSet = new Set<string>();

    for (const c of response.data) {
      const parsed = parseOptionSymbol(c.option_symbol);
      if (!parsed) continue;
      expirationSet.add(parsed.expiry);
      const bid = Number(c.nbbo_bid) || 0;
      const ask = Number(c.nbbo_ask) || 0;
      const mid = bid && ask ? (bid + ask) / 2 : Number(c.last_price) || 0;
      rawParsed.push({ raw: c, parsed, bid, ask, mid, iv: Number(c.implied_volatility) || 0 });
    }

    // Infer underlying price: find the strike where call and put mid prices
    // are closest (ATM). Group by strike for the nearest expiry.
    let underlyingPrice = 0;
    const sortedExpiries = [...expirationSet].sort();
    const nearestExpiry = sortedExpiries[0];
    if (nearestExpiry) {
      const nearExpContracts = rawParsed.filter(r => r.parsed.expiry === nearestExpiry);
      const strikeMap = new Map<number, { callMid: number; putMid: number }>();
      for (const r of nearExpContracts) {
        const entry = strikeMap.get(r.parsed.strike) || { callMid: 0, putMid: 0 };
        if (r.parsed.type === 'call') entry.callMid = r.mid;
        else entry.putMid = r.mid;
        strikeMap.set(r.parsed.strike, entry);
      }
      // ATM strike: where |callMid - putMid| is minimized (put-call parity)
      let minDiff = Infinity;
      for (const [strike, { callMid, putMid }] of strikeMap) {
        if (callMid > 0 && putMid > 0) {
          const diff = Math.abs(callMid - putMid);
          if (diff < minDiff) {
            minDiff = diff;
            underlyingPrice = strike;
          }
        }
      }
      if (underlyingPrice === 0) {
        // Fallback: use highest-volume strike as ATM proxy
        let maxVol = 0;
        for (const r of nearExpContracts) {
          const vol = Number(r.raw.volume) || 0;
          if (vol > maxVol) { maxVol = vol; underlyingPrice = r.parsed.strike; }
        }
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

    this.log.info({ symbol, inferredUnderlyingPrice: underlyingPrice }, 'Inferred underlying for delta estimation');

    // Second pass: build contracts with estimated Greeks
    const contracts: OptionsContract[] = [];
    const now = Date.now();

    for (const { raw, parsed, bid, ask, mid, iv } of rawParsed) {
      const expiryDate = new Date(parsed.expiry + 'T16:00:00Z');
      const T = calculateTimeToExpiration(expiryDate, now);

      let greeks = { delta: 0, gamma: 0, theta: 0, vega: 0 };
      if (underlyingPrice > 0 && iv > 0 && T > 0) {
        greeks = calculateGreeks(parsed.type, underlyingPrice, parsed.strike, T, iv);
      }

      contracts.push({
        symbol: raw.option_symbol,
        underlyingSymbol: parsed.underlying,
        type: parsed.type,
        strike: parsed.strike,
        expiration: parsed.expiry,
        bid,
        ask,
        mid,
        last: Number(raw.last_price) || 0,
        volume: Number(raw.volume) || 0,
        openInterest: Number(raw.open_interest) || 0,
        impliedVolatility: iv,
        delta: Math.round(greeks.delta * 10000) / 10000,
        gamma: Math.round(greeks.gamma * 10000) / 10000,
        theta: Math.round(greeks.theta * 10000) / 10000,
        vega: Math.round(greeks.vega * 10000) / 10000,
      });
    }

    const expirations = [...expirationSet].sort();
    this.log.info({ symbol, contracts: contracts.length, expirations: expirations.length }, 'Options chain parsed with Greeks');

    return { symbol, expirations, contracts, timestamp: Date.now() };
  }

  async getGEX(symbol: string): Promise<GexData> {
    const response = await this.request<UWGreeksResponse>(
      'GET',
      `/api/stock/${symbol}/greeks`,
      {},
      this.authHeaders,
    );

    if (!response?.data?.length) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty GEX response for ${symbol}`);
    }

    const strikeMap = new Map<number, { callGamma: number; putGamma: number }>();
    let totalCallGex = 0;
    let totalPutGex = 0;

    for (const row of response.data) {
      const strike = parseFloat(row.strike);
      const callGamma = parseFloat(row.call_gamma) || 0;
      const putGamma = parseFloat(row.put_gamma) || 0;
      const existing = strikeMap.get(strike) || { callGamma: 0, putGamma: 0 };
      existing.callGamma += callGamma;
      existing.putGamma += putGamma;
      strikeMap.set(strike, existing);
      totalCallGex += callGamma;
      totalPutGex += putGamma;
    }

    const netGex = totalCallGex - Math.abs(totalPutGex);

    const levels = Array.from(strikeMap.entries()).map(([strike, { callGamma, putGamma }]) => ({
      strike,
      gex: callGamma - Math.abs(putGamma),
      callGex: callGamma,
      putGex: putGamma,
    }));

    levels.sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex));

    let flipPrice: number | null = null;
    const sortedByStrike = [...levels].sort((a, b) => a.strike - b.strike);
    for (let i = 1; i < sortedByStrike.length; i++) {
      if (sortedByStrike[i - 1].gex * sortedByStrike[i].gex < 0) {
        flipPrice = (sortedByStrike[i - 1].strike + sortedByStrike[i].strike) / 2;
        break;
      }
    }

    const majorLevels: GexLevel[] = levels.slice(0, 20).map((level) => ({
      strike: level.strike,
      gex: level.gex,
      callGex: level.callGex,
      putGex: level.putGex,
      type: this.classifyGexLevel(
        { strike: level.strike, gex: level.gex, call_gex: level.callGex, put_gex: level.putGex },
        flipPrice,
      ),
    }));

    return {
      symbol,
      totalGex: totalCallGex + totalPutGex,
      callGex: totalCallGex,
      putGex: totalPutGex,
      netGex,
      flipPrice,
      majorLevels,
      timestamp: Date.now(),
    };
  }

  async getFlow(symbol: string): Promise<OptionsFlowSummary> {
    const response = await this.request<UWNetPremTicksResponse>(
      'GET',
      `/api/stock/${symbol}/net-prem-ticks`,
      {},
      this.authHeaders,
    );

    if (!response?.data?.length) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty flow response for ${symbol}`);
    }

    let totalCallVol = 0;
    let totalPutVol = 0;
    let totalCallPrem = 0;
    let totalPutPrem = 0;

    for (const tick of response.data) {
      totalCallVol += tick.call_volume;
      totalPutVol += tick.put_volume;
      totalCallPrem += parseFloat(tick.net_call_premium) || 0;
      totalPutPrem += parseFloat(tick.net_put_premium) || 0;
    }

    const totalPremium = Math.abs(totalCallPrem) + Math.abs(totalPutPrem);
    const netPremium = totalCallPrem + totalPutPrem;
    const putCallRatio = totalCallVol > 0 ? totalPutVol / totalCallVol : 0;
    const sentiment: 'bullish' | 'bearish' | 'neutral' =
      netPremium > 0 ? 'bullish' : netPremium < 0 ? 'bearish' : 'neutral';

    return {
      symbol,
      totalPremium,
      callPremium: totalCallPrem,
      putPremium: totalPutPrem,
      netPremium,
      callVolume: totalCallVol,
      putVolume: totalPutVol,
      putCallRatio,
      largestTrades: [],
      sentiment,
      timestamp: Date.now(),
    };
  }

  async getIV(symbol: string): Promise<IVData> {
    const response = await this.request<UWInterpolatedIVResponse>(
      'GET',
      `/api/stock/${symbol}/interpolated-iv`,
      {},
      this.authHeaders,
    );

    if (!response?.data?.length) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty IV response for ${symbol}`);
    }

    const byDays = new Map(response.data.map((d) => [d.days, d]));
    const iv30 = byDays.get(30);
    const iv60 = byDays.get(60);
    const iv90 = byDays.get(90);

    const currentIV = iv30 ? parseFloat(iv30.volatility) : parseFloat(response.data[0].volatility);
    const ivPercentile = iv30 ? parseFloat(iv30.percentile) : parseFloat(response.data[0].percentile);
    const ivRank = ivPercentile;

    return {
      symbol,
      currentIV,
      ivRank,
      ivPercentile,
      historicalIV30: iv30 ? parseFloat(iv30.volatility) : 0,
      historicalIV60: iv60 ? parseFloat(iv60.volatility) : 0,
      historicalIV90: iv90 ? parseFloat(iv90.volatility) : 0,
      timestamp: Date.now(),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request('GET', '/api/stock/SPY/interpolated-iv', {}, this.authHeaders);
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
