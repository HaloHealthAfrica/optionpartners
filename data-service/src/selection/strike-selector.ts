import { createChildLogger } from '../utils/logger';
import type { MarketDataAdapter, NormalizedOptionContract } from '../providers/marketdata/adapter';

const log = createChildLogger('strike-selector');

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SingleLegParams {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  dteRange: { min: number; max: number };
  deltaRange: { min: number; max: number };
  maxSpreadPct: number;
  minOpenInterest: number;
  minIvPercentile?: number;
  maxIvPercentile?: number;
}

export interface CreditSpreadParams {
  symbol: string;
  direction: 'BULL_PUT' | 'BEAR_CALL';
  dteRange: { min: number; max: number };
  shortDeltaRange: { min: number; max: number };
  spreadWidth: number;
  maxSpreadPct: number;
  minOpenInterest: number;
  minCredit: number;
}

export interface ScoredCandidate {
  canonicalId: string;
  underlying: string;
  expiration: string;
  right: 'C' | 'P';
  strike: number;
  bid: number;
  ask: number;
  mid: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  openInterest: number;
  volume: number;
  spreadPct: number;
  score: number;
  tieBreakRank: number;
}

export interface RejectionRecord {
  canonicalId: string;
  reason: string;
}

export interface SelectionSnapshot {
  symbol: string;
  strategy: string;
  params: Record<string, unknown>;
  candidateCount: number;
  selectedContract: string | null;
  computedAt: number;
}

export interface StrikeSelectionResult {
  selected: ScoredCandidate | null;
  candidates: ScoredCandidate[];
  rejections: RejectionRecord[];
  snapshot: SelectionSnapshot;
}

export interface SpreadSelectionResult {
  shortLeg: ScoredCandidate | null;
  longLeg: NormalizedOptionContract | null;
  credit: number;
  candidates: ScoredCandidate[];
  rejections: RejectionRecord[];
  snapshot: SelectionSnapshot;
}

// ---------------------------------------------------------------------------
// Deterministic scoring weights
// ---------------------------------------------------------------------------

const WEIGHT_DELTA = 0.4;
const WEIGHT_LIQUIDITY = 0.3;
const WEIGHT_SPREAD = 0.3;
const STALENESS_LIMIT_MS = 60_000;

// ---------------------------------------------------------------------------
// Strike selector
// ---------------------------------------------------------------------------

export class StrikeSelector {
  constructor(private adapter: MarketDataAdapter) {}

  async selectSingleLegSwing(params: SingleLegParams): Promise<StrikeSelectionResult> {
    const { symbol, direction, dteRange, deltaRange, maxSpreadPct, minOpenInterest } = params;
    const right: 'call' | 'put' = direction === 'LONG' ? 'call' : 'put';

    log.info({ symbol, direction, dteRange, deltaRange }, 'Starting single-leg selection');

    // 1) Get expirations
    const expirations = await this.adapter.getExpirations(symbol);
    if (expirations.length === 0) {
      return emptyResult(symbol, 'SINGLE_LEG_SWING', params);
    }

    // 2) Find closest expiration within DTE range
    const expiration = pickExpiration(expirations, dteRange);
    if (!expiration) {
      log.warn({ symbol, dteRange, available: expirations.length }, 'No expiration within DTE range');
      return emptyResult(symbol, 'SINGLE_LEG_SWING', params);
    }

    // 3) Get chain for that expiration
    const chain = await this.adapter.getOptionsChain(symbol, expiration, right);
    if (chain.length === 0) {
      return emptyResult(symbol, 'SINGLE_LEG_SWING', params);
    }

    // 4-6) Filter + score
    const now = Date.now();
    const rejections: RejectionRecord[] = [];
    const targetDelta = (deltaRange.min + deltaRange.max) / 2;

    const filtered: ScoredCandidate[] = [];

    // Sort chain by canonical ID for determinism (step 7)
    const sorted = [...chain].sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));

    for (const c of sorted) {
      const mid = c.mid > 0 ? c.mid : (c.bid + c.ask) / 2;
      const spreadPct = mid > 0 ? (c.ask - c.bid) / mid : Infinity;
      const absDelta = Math.abs(c.delta);

      // Filter checks
      if (c.bid <= 0 || c.ask <= 0) {
        rejections.push({ canonicalId: c.canonicalId, reason: 'bid or ask <= 0' });
        continue;
      }
      if (spreadPct > maxSpreadPct) {
        rejections.push({ canonicalId: c.canonicalId, reason: `spreadPct ${spreadPct.toFixed(4)} > max ${maxSpreadPct}` });
        continue;
      }
      if (c.openInterest < minOpenInterest) {
        rejections.push({ canonicalId: c.canonicalId, reason: `OI ${c.openInterest} < min ${minOpenInterest}` });
        continue;
      }
      if (absDelta < deltaRange.min || absDelta > deltaRange.max) {
        rejections.push({ canonicalId: c.canonicalId, reason: `delta ${absDelta.toFixed(4)} outside [${deltaRange.min}, ${deltaRange.max}]` });
        continue;
      }
      if (params.minIvPercentile !== undefined && c.iv < params.minIvPercentile) {
        rejections.push({ canonicalId: c.canonicalId, reason: `IV ${c.iv} < minIvPercentile ${params.minIvPercentile}` });
        continue;
      }
      if (params.maxIvPercentile !== undefined && c.iv > params.maxIvPercentile) {
        rejections.push({ canonicalId: c.canonicalId, reason: `IV ${c.iv} > maxIvPercentile ${params.maxIvPercentile}` });
        continue;
      }
      if (now - c.updatedAt > STALENESS_LIMIT_MS) {
        rejections.push({ canonicalId: c.canonicalId, reason: `quote stale (${Math.round((now - c.updatedAt) / 1000)}s old)` });
        continue;
      }

      // Score (step 8-9)
      const deltaScore = Math.max(0, 1 - Math.abs(absDelta - targetDelta) / 0.5);
      const liquidityScore = Math.min(1, c.openInterest / 1000);
      const spreadScore = Math.max(0, 1 - spreadPct / maxSpreadPct);
      const score = WEIGHT_DELTA * deltaScore + WEIGHT_LIQUIDITY * liquidityScore + WEIGHT_SPREAD * spreadScore;

      filtered.push({
        canonicalId: c.canonicalId,
        underlying: c.underlying,
        expiration: c.expiration,
        right: c.right,
        strike: c.strike,
        bid: c.bid,
        ask: c.ask,
        mid,
        delta: c.delta,
        gamma: c.gamma,
        theta: c.theta,
        vega: c.vega,
        iv: c.iv,
        openInterest: c.openInterest,
        volume: c.volume,
        spreadPct,
        score,
        tieBreakRank: 0,
      });
    }

    // Deterministic sort: score desc, then OI desc, then spread asc, then canonical ID asc
    filtered.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.openInterest !== a.openInterest) return b.openInterest - a.openInterest;
      if (a.spreadPct !== b.spreadPct) return a.spreadPct - b.spreadPct;
      return a.canonicalId.localeCompare(b.canonicalId);
    });

    for (let i = 0; i < filtered.length; i++) {
      filtered[i].tieBreakRank = i + 1;
    }

    const selected = filtered.length > 0 ? filtered[0] : null;

    log.info({
      symbol,
      expiration,
      chainSize: chain.length,
      candidates: filtered.length,
      rejected: rejections.length,
      selected: selected?.canonicalId ?? null,
      score: selected?.score?.toFixed(4) ?? null,
    }, 'Single-leg selection complete');

    return {
      selected,
      candidates: filtered,
      rejections,
      snapshot: {
        symbol,
        strategy: 'SINGLE_LEG_SWING',
        params: params as unknown as Record<string, unknown>,
        candidateCount: filtered.length,
        selectedContract: selected?.canonicalId ?? null,
        computedAt: Date.now(),
      },
    };
  }

  async selectCreditSpread(params: CreditSpreadParams): Promise<SpreadSelectionResult> {
    const { symbol, direction, spreadWidth, minCredit } = params;
    const right: 'call' | 'put' = direction === 'BEAR_CALL' ? 'call' : 'put';

    log.info({ symbol, direction, spreadWidth }, 'Starting credit spread selection');

    // Select short leg using single-leg algorithm
    const shortResult = await this.selectSingleLegSwing({
      symbol,
      direction: direction === 'BEAR_CALL' ? 'SHORT' : 'LONG',
      dteRange: params.dteRange,
      deltaRange: params.shortDeltaRange,
      maxSpreadPct: params.maxSpreadPct,
      minOpenInterest: params.minOpenInterest,
    });

    if (!shortResult.selected) {
      return {
        shortLeg: null,
        longLeg: null,
        credit: 0,
        candidates: shortResult.candidates,
        rejections: shortResult.rejections,
        snapshot: {
          symbol,
          strategy: 'CREDIT_SPREAD',
          params: params as unknown as Record<string, unknown>,
          candidateCount: 0,
          selectedContract: null,
          computedAt: Date.now(),
        },
      };
    }

    const shortLeg = shortResult.selected;

    // Find long leg: offset by spreadWidth
    const longStrike = direction === 'BULL_PUT'
      ? shortLeg.strike - spreadWidth
      : shortLeg.strike + spreadWidth;

    const chain = await this.adapter.getOptionsChain(symbol, shortLeg.expiration, right);
    const longLeg = chain.find((c) =>
      Math.abs(c.strike - longStrike) < 0.01 && c.right === shortLeg.right,
    ) ?? null;

    if (!longLeg) {
      log.warn({ symbol, shortStrike: shortLeg.strike, longStrike }, 'Long leg not found at target strike');
      return {
        shortLeg,
        longLeg: null,
        credit: 0,
        candidates: shortResult.candidates,
        rejections: [...shortResult.rejections, { canonicalId: `strike_${longStrike}`, reason: 'Long leg not found' }],
        snapshot: {
          symbol,
          strategy: 'CREDIT_SPREAD',
          params: params as unknown as Record<string, unknown>,
          candidateCount: shortResult.candidates.length,
          selectedContract: null,
          computedAt: Date.now(),
        },
      };
    }

    const credit = shortLeg.bid - longLeg.ask;

    if (credit < minCredit) {
      log.warn({ credit, minCredit }, 'Credit below minimum');
      return {
        shortLeg,
        longLeg,
        credit,
        candidates: shortResult.candidates,
        rejections: [...shortResult.rejections, { canonicalId: longLeg.canonicalId, reason: `credit ${credit.toFixed(2)} < minCredit ${minCredit}` }],
        snapshot: {
          symbol,
          strategy: 'CREDIT_SPREAD',
          params: params as unknown as Record<string, unknown>,
          candidateCount: shortResult.candidates.length,
          selectedContract: null,
          computedAt: Date.now(),
        },
      };
    }

    log.info({
      symbol,
      shortStrike: shortLeg.strike,
      longStrike: longLeg.strike,
      credit: credit.toFixed(2),
    }, 'Credit spread selected');

    return {
      shortLeg,
      longLeg,
      credit,
      candidates: shortResult.candidates,
      rejections: shortResult.rejections,
      snapshot: {
        symbol,
        strategy: 'CREDIT_SPREAD',
        params: params as unknown as Record<string, unknown>,
        candidateCount: shortResult.candidates.length,
        selectedContract: `${shortLeg.canonicalId}/${longLeg.canonicalId}`,
        computedAt: Date.now(),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickExpiration(expirations: string[], dteRange: { min: number; max: number }): string | null {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const nowMs = now.getTime();

  let best: string | null = null;
  let bestDteDiff = Infinity;
  const targetDte = (dteRange.min + dteRange.max) / 2;

  for (const exp of expirations) {
    const expDate = new Date(exp + 'T16:00:00Z');
    const dte = Math.round((expDate.getTime() - nowMs) / 86_400_000);

    if (dte < dteRange.min || dte > dteRange.max) continue;

    const diff = Math.abs(dte - targetDte);
    if (diff < bestDteDiff) {
      bestDteDiff = diff;
      best = exp;
    }
  }

  return best;
}

function emptyResult(symbol: string, strategy: string, params: unknown): StrikeSelectionResult {
  return {
    selected: null,
    candidates: [],
    rejections: [],
    snapshot: {
      symbol,
      strategy,
      params: params as Record<string, unknown>,
      candidateCount: 0,
      selectedContract: null,
      computedAt: Date.now(),
    },
  };
}
