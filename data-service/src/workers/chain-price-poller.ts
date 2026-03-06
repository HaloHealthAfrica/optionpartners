import { BasePoller } from './base-poller';
import { MarketSession, isActiveSession } from './market-session';
import { computeGex } from '../analysis/gex-calculator';
import { computedGexProvider } from '../providers/computed-gex-provider';
import { snapshotStore } from '../persistence/snapshot-store';
import type { DataOrchestrator } from '../services/data-orchestrator';

const PRICE_INTERVALS: Record<string, number> = {
  [MarketSession.RTH]:         60 * 1000,        // 1 min
  [MarketSession.PRE_MARKET]:  5 * 60 * 1000,    // 5 min
  [MarketSession.POST_MARKET]: 5 * 60 * 1000,    // 5 min
};

const CHAIN_INTERVALS: Record<string, number> = {
  [MarketSession.RTH]:         5 * 60 * 1000,    // 5 min (UW daily limit: 1500 req)
  [MarketSession.PRE_MARKET]:  15 * 60 * 1000,   // 15 min
  [MarketSession.POST_MARKET]: 15 * 60 * 1000,   // 15 min
};

interface SymbolMetrics {
  lastPriceAt: number;
  lastChainAt: number;
  priceFails: number;
  chainFails: number;
}

export class ChainPricePoller extends BasePoller {
  private symbols: Set<string>;
  private metrics = new Map<string, SymbolMetrics>();
  private session: MarketSession = MarketSession.RTH;
  private chainRoundRobinIdx = 0;

  constructor(
    private orchestrator: DataOrchestrator,
    symbols: string[] = ['SPY', 'QQQ', 'IWM'],
  ) {
    super({ name: 'chain-price', intervalMs: PRICE_INTERVALS[MarketSession.RTH] });
    this.symbols = new Set(symbols.map(s => s.toUpperCase()));
    for (const s of this.symbols) {
      this.metrics.set(s, { lastPriceAt: 0, lastChainAt: 0, priceFails: 0, chainFails: 0 });
    }
  }

  addSymbol(symbol: string): void {
    const s = symbol.toUpperCase();
    this.symbols.add(s);
    if (!this.metrics.has(s)) {
      this.metrics.set(s, { lastPriceAt: 0, lastChainAt: 0, priceFails: 0, chainFails: 0 });
    }
  }

  removeSymbol(symbol: string): void {
    this.symbols.delete(symbol.toUpperCase());
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }

  setSession(session: MarketSession): void {
    if (!isActiveSession(session)) {
      this.session = session;
      this.pause();
      return;
    }
    const wasPaused = this.isPaused();
    this.session = session;
    const interval = PRICE_INTERVALS[session] ?? PRICE_INTERVALS[MarketSession.POST_MARKET];
    if (wasPaused) {
      this.updateInterval(interval);
      this.resume();
    } else {
      this.updateInterval(interval);
    }
    this.log.info({ session, priceIntervalMs: interval }, 'Market session changed');
  }

  /** @deprecated Use setSession instead */
  setMarketHours(isRTH: boolean): void {
    this.setSession(isRTH ? MarketSession.RTH : MarketSession.POST_MARKET);
  }

  getMetrics(): Record<string, SymbolMetrics> {
    const result: Record<string, SymbolMetrics> = {};
    for (const [sym, m] of this.metrics) {
      result[sym] = { ...m };
    }
    return result;
  }

  private lastSpotPrices = new Map<string, number>();

  protected async tick(): Promise<void> {
    const symbols = [...this.symbols];
    const isRTH = this.session === MarketSession.RTH;
    let priceOk = 0, priceFail = 0, chainOk = 0, chainFail = 0;

    for (const symbol of symbols) {
      const m = this.metrics.get(symbol) ?? { lastPriceAt: 0, lastChainAt: 0, priceFails: 0, chainFails: 0 };

      try {
        const result = await this.orchestrator.getQuote(symbol);
        if (result?.data?.price) {
          m.lastPriceAt = Date.now();
          m.priceFails = 0;
          priceOk++;
          this.lastSpotPrices.set(symbol, result.data.price);
        } else {
          m.priceFails++;
          priceFail++;
        }
      } catch (err) {
        m.priceFails++;
        priceFail++;
        this.log.warn(
          { symbol, error: err instanceof Error ? err.message : err, consecutiveFails: m.priceFails },
          'Price poll failed',
        );
      }

      this.metrics.set(symbol, m);
    }

    // Chain: fetch at most ONE symbol per tick (round-robin) to stay within
    // provider daily limits. After a successful chain fetch, compute GEX
    // in-memory (zero additional API calls).
    const chainInterval = CHAIN_INTERVALS[this.session] ?? CHAIN_INTERVALS[MarketSession.POST_MARKET];
    const chainCandidate = symbols[this.chainRoundRobinIdx % symbols.length];
    this.chainRoundRobinIdx = (this.chainRoundRobinIdx + 1) % symbols.length;

    const cm = this.metrics.get(chainCandidate) ?? { lastPriceAt: 0, lastChainAt: 0, priceFails: 0, chainFails: 0 };
    const chainAge = Date.now() - cm.lastChainAt;

    if (chainAge >= chainInterval) {
      try {
        const result = await this.orchestrator.getOptionsChain(chainCandidate);
        const contracts = result?.data?.contracts ?? [];
        if (Array.isArray(contracts) && contracts.length > 0) {
          cm.lastChainAt = Date.now();
          cm.chainFails = 0;
          chainOk++;
          this.log.info(
            { symbol: chainCandidate, contracts: contracts.length },
            'Chain snapshot captured',
          );

          // Compute GEX from chain data — piggybacks on existing fetch, zero extra API calls
          const spotPrice = this.lastSpotPrices.get(chainCandidate);
          if (spotPrice && result.data) {
            const gexData = computeGex(result.data, spotPrice);
            if (gexData) {
              computedGexProvider.store(gexData);
              await snapshotStore.saveGexSnapshot(gexData, 'computed');
              this.log.info(
                { symbol: chainCandidate, netGex: Math.round(gexData.netGex), flipPrice: gexData.flipPrice?.toFixed(2), levels: gexData.majorLevels.length },
                'Computed GEX from chain data',
              );
            }
          }
        } else {
          cm.chainFails++;
          chainFail++;
          this.log.warn({ symbol: chainCandidate }, 'Chain poll returned empty contracts');
        }
      } catch (err) {
        cm.chainFails++;
        chainFail++;
        this.log.warn(
          { symbol: chainCandidate, error: err instanceof Error ? err.message : err, consecutiveFails: cm.chainFails },
          'Chain poll failed',
        );
      }
      this.metrics.set(chainCandidate, cm);
    }

    if (isRTH) {
      for (const [sym, m] of this.metrics) {
        if (m.priceFails >= 5) {
          this.log.error(
            { symbol: sym, consecutiveFails: m.priceFails },
            'DEAD PRICE FEED — no successful price fetch in multiple cycles',
          );
        }
        if (m.chainFails >= 3) {
          this.log.error(
            { symbol: sym, consecutiveFails: m.chainFails },
            'DEAD CHAIN FEED — no successful chain fetch in multiple cycles',
          );
        }
      }
    }

    this.log.info(
      { priceOk, priceFail, chainOk, chainFail, chainSymbol: chainCandidate, symbols: symbols.length, session: this.session },
      'Chain/price poll cycle complete',
    );
  }
}
