import { BasePoller } from './base-poller';
import { MarketSession, isActiveSession } from './market-session';
import type { DataOrchestrator } from '../services/data-orchestrator';

const PRICE_INTERVALS: Record<string, number> = {
  [MarketSession.RTH]:         60 * 1000,        // 1 min
  [MarketSession.PRE_MARKET]:  5 * 60 * 1000,    // 5 min
  [MarketSession.POST_MARKET]: 5 * 60 * 1000,    // 5 min
};

const CHAIN_INTERVALS: Record<string, number> = {
  [MarketSession.RTH]:         2 * 60 * 1000,    // 2 min
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

      const chainInterval = CHAIN_INTERVALS[this.session] ?? CHAIN_INTERVALS[MarketSession.POST_MARKET];
      const chainAge = Date.now() - m.lastChainAt;
      if (chainAge >= chainInterval) {
        try {
          const result = await this.orchestrator.getOptionsChain(symbol);
          const contracts = result?.data?.contracts ?? [];
          if (Array.isArray(contracts) && contracts.length > 0) {
            m.lastChainAt = Date.now();
            m.chainFails = 0;
            chainOk++;
            this.log.info(
              { symbol, contracts: contracts.length },
              'Chain snapshot captured',
            );
          } else {
            m.chainFails++;
            chainFail++;
            this.log.warn({ symbol }, 'Chain poll returned empty contracts');
          }
        } catch (err) {
          m.chainFails++;
          chainFail++;
          this.log.warn(
            { symbol, error: err instanceof Error ? err.message : err, consecutiveFails: m.chainFails },
            'Chain poll failed',
          );
        }
      }

      this.metrics.set(symbol, m);
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
      { priceOk, priceFail, chainOk, chainFail, symbols: symbols.length, session: this.session },
      'Chain/price poll cycle complete',
    );
  }
}
