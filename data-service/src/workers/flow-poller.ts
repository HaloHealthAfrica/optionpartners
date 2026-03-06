import { BasePoller } from './base-poller';
import { MarketSession, isActiveSession } from './market-session';
import type { DataOrchestrator } from '../services/data-orchestrator';

const SESSION_INTERVALS: Record<string, number> = {
  [MarketSession.RTH]:         5 * 60 * 1000,   // 5 min (UW daily limit: 1500 req)
  [MarketSession.PRE_MARKET]:  15 * 60 * 1000,  // 15 min
  [MarketSession.POST_MARKET]: 15 * 60 * 1000,  // 15 min
};

export class FlowPoller extends BasePoller {
  private symbols: Set<string>;

  constructor(
    private orchestrator: DataOrchestrator,
    symbols: string[] = ['SPY', 'QQQ', 'IWM'],
  ) {
    super({ name: 'flow', intervalMs: SESSION_INTERVALS[MarketSession.RTH] });
    this.symbols = new Set(symbols.map((s) => s.toUpperCase()));
  }

  addSymbol(symbol: string): void {
    this.symbols.add(symbol.toUpperCase());
    this.log.info({ symbol, total: this.symbols.size }, 'Symbol added to flow poller');
  }

  removeSymbol(symbol: string): void {
    this.symbols.delete(symbol.toUpperCase());
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }

  setSession(session: MarketSession): void {
    if (!isActiveSession(session)) {
      this.pause();
      return;
    }
    if (this.isPaused()) this.resume();
    const interval = SESSION_INTERVALS[session] ?? SESSION_INTERVALS[MarketSession.POST_MARKET];
    this.updateInterval(interval);
    this.log.info({ session, intervalMs: interval }, 'Flow poller interval updated');
  }

  /** @deprecated Use setSession instead */
  setMarketHoursInterval(isRTH: boolean): void {
    this.setSession(isRTH ? MarketSession.RTH : MarketSession.POST_MARKET);
  }

  protected async tick(): Promise<void> {
    const symbols = [...this.symbols];
    const results = await Promise.allSettled(
      symbols.map((symbol) => this.orchestrator.getFlowWithSnapshot(symbol)),
    );

    let succeeded = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') succeeded++;
      else failed++;
    }

    this.log.info({ succeeded, failed, total: symbols.length }, 'Flow poll cycle complete');
  }
}
