import { BasePoller } from './base-poller';
import type { DataOrchestrator } from '../services/data-orchestrator';

const FLOW_INTERVAL = 2 * 60 * 1000; // 2 min

export class FlowPoller extends BasePoller {
  private symbols: Set<string>;

  constructor(
    private orchestrator: DataOrchestrator,
    symbols: string[] = ['SPY', 'QQQ', 'IWM'],
  ) {
    super({ name: 'flow', intervalMs: FLOW_INTERVAL });
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
