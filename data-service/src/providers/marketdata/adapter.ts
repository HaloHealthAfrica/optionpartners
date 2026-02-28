import { createChildLogger } from '../../utils/logger';
import { formatCanonical, parseCanonical } from '../../contracts/canonical';
import {
  MarketDataClient,
  MarketDataOptionContract,
  MarketDataQuoteResponse,
} from './client';

// ---------------------------------------------------------------------------
// Normalized types
// ---------------------------------------------------------------------------

export interface NormalizedOptionContract {
  canonicalId: string;
  underlying: string;
  expiration: string;
  right: 'C' | 'P';
  strike: number;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume: number;
  openInterest: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  updatedAt: number;
  source: 'marketdata';
}

export interface NormalizedOptionQuote {
  canonicalId: string;
  bid: number;
  ask: number;
  mid: number;
  updatedAt: number;
  source: 'marketdata';
}

// ---------------------------------------------------------------------------
// OCC <-> Canonical helpers
//
// Canonical : O:SPY:20260320:C:500000       (YYYYMMDD, strike × 1000)
// OCC       : SPY260320C00500000            (YYMMDD,  8-digit strike × 1000)
// ---------------------------------------------------------------------------

function occToCanonical(occ: string): string {
  const strikeStr = occ.slice(-8);
  const side = occ.slice(-9, -8) as 'C' | 'P';
  const dateYYMMDD = occ.slice(-15, -9);
  const underlying = occ.slice(0, -15);

  const expirationYYYYMMDD = '20' + dateYYMMDD;
  const strike = parseInt(strikeStr, 10);

  return formatCanonical({ underlying, expirationYYYYMMDD, right: side, strike });
}

function canonicalToOcc(canonicalId: string): string {
  const { underlying, expirationYYYYMMDD, right, strike } = parseCanonical(canonicalId);
  const dateYYMMDD = expirationYYYYMMDD.slice(2); // YYYYMMDD → YYMMDD
  const strikeOcc = Math.round(strike * 1000).toString().padStart(8, '0');
  return `${underlying}${dateYYMMDD}${right}${strikeOcc}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class MarketDataAdapter {
  private readonly log;

  constructor(private readonly client: MarketDataClient) {
    this.log = createChildLogger('marketdata-adapter');
  }

  async getExpirations(symbol: string): Promise<string[]> {
    this.log.debug({ symbol }, 'Getting expirations');
    return this.client.getExpirations(symbol);
  }

  async getOptionsChain(
    symbol: string,
    expiration: string,
    right?: 'call' | 'put',
  ): Promise<NormalizedOptionContract[]> {
    this.log.debug({ symbol, expiration, right }, 'Getting options chain');

    const contracts = await this.client.getOptionChain(symbol, expiration, right);

    return contracts.map((c) => this.normalizeContract(c));
  }

  async getOptionQuotes(canonicalIds: string[]): Promise<NormalizedOptionQuote[]> {
    if (canonicalIds.length === 0) return [];

    this.log.debug({ count: canonicalIds.length }, 'Getting option quotes');

    const occSymbols = canonicalIds.map(canonicalToOcc);

    const occToCanonicalMap = new Map<string, string>();
    for (let i = 0; i < occSymbols.length; i++) {
      occToCanonicalMap.set(occSymbols[i], canonicalIds[i]);
    }

    const quotes = await this.client.getOptionQuotes(occSymbols);

    return quotes.map((q) => this.normalizeQuote(q, occToCanonicalMap));
  }

  // ---- private ------------------------------------------------------------

  private normalizeContract(c: MarketDataOptionContract): NormalizedOptionContract {
    return {
      canonicalId: occToCanonical(c.optionSymbol),
      underlying: c.underlying,
      expiration: c.expiration,
      right: c.side === 'call' ? 'C' : 'P',
      strike: c.strike,
      bid: c.bid,
      ask: c.ask,
      mid: c.mid,
      last: c.last,
      volume: c.volume,
      openInterest: c.openInterest,
      iv: c.iv,
      delta: c.delta,
      gamma: c.gamma,
      theta: c.theta,
      vega: c.vega,
      updatedAt: c.updated,
      source: 'marketdata',
    };
  }

  private normalizeQuote(
    q: MarketDataQuoteResponse,
    lookupMap: Map<string, string>,
  ): NormalizedOptionQuote {
    let canonicalId = lookupMap.get(q.optionSymbol);

    if (!canonicalId) {
      this.log.warn(
        { optionSymbol: q.optionSymbol },
        'Quote returned for symbol not in request map; deriving canonical ID from OCC',
      );
      canonicalId = occToCanonical(q.optionSymbol);
    }

    return {
      canonicalId,
      bid: q.bid,
      ask: q.ask,
      mid: q.mid,
      updatedAt: q.updated,
      source: 'marketdata',
    };
  }
}
