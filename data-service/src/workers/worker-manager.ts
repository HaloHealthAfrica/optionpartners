import { createChildLogger } from '../utils/logger';
import { GexPoller } from './gex-poller';
import { FlowPoller } from './flow-poller';
import { VixPoller } from './vix-poller';
import { MacroPoller } from './macro-poller';
import { VolatilityPoller } from './volatility-poller';
import { IvPoller } from './iv-poller';
import type { DataOrchestrator } from '../services/data-orchestrator';
import type { MacroRegimeService } from '../services/macro-regime';

const log = createChildLogger('worker-manager');

export interface WorkerManagerConfig {
  defaultSymbols?: string[];
  enableGex?: boolean;
  enableFlow?: boolean;
  enableVix?: boolean;
  enableMacro?: boolean;
  enableVolatility?: boolean;
  enableIv?: boolean;
}

const DEFAULT_SYMBOLS = ['SPY', 'QQQ', 'IWM'];

export class WorkerManager {
  readonly gexPoller: GexPoller;
  readonly flowPoller: FlowPoller;
  readonly vixPoller: VixPoller;
  readonly macroPoller: MacroPoller;
  readonly volatilityPoller: VolatilityPoller;
  readonly ivPoller: IvPoller;

  private marketHoursTimer: ReturnType<typeof setInterval> | null = null;
  private isRTH = false;

  constructor(
    orchestrator: DataOrchestrator,
    macroRegime: MacroRegimeService,
    config: WorkerManagerConfig = {},
  ) {
    const symbols = config.defaultSymbols ?? DEFAULT_SYMBOLS;

    this.gexPoller = new GexPoller(orchestrator, symbols);
    this.flowPoller = new FlowPoller(orchestrator, symbols);
    this.vixPoller = new VixPoller(orchestrator);
    this.macroPoller = new MacroPoller(macroRegime);
    this.volatilityPoller = new VolatilityPoller(orchestrator, symbols);
    this.ivPoller = new IvPoller(orchestrator, symbols);
  }

  start(config: WorkerManagerConfig = {}): void {
    log.info('Starting polling workers');

    if (config.enableGex !== false) this.gexPoller.start();
    if (config.enableFlow !== false) this.flowPoller.start();
    if (config.enableVix !== false) this.vixPoller.start();
    if (config.enableMacro !== false) this.macroPoller.start();
    if (config.enableVolatility !== false) this.volatilityPoller.start();
    if (config.enableIv !== false) this.ivPoller.start();

    // Check market hours every minute and adjust GEX poller interval
    this.startMarketHoursMonitor();

    log.info({
      gex: this.gexPoller.isRunning(),
      flow: this.flowPoller.isRunning(),
      vix: this.vixPoller.isRunning(),
      macro: this.macroPoller.isRunning(),
      volatility: this.volatilityPoller.isRunning(),
      iv: this.ivPoller.isRunning(),
      symbols: this.gexPoller.getSymbols(),
    }, 'Workers started');
  }

  stop(): void {
    log.info('Stopping all polling workers');
    this.gexPoller.stop();
    this.flowPoller.stop();
    this.vixPoller.stop();
    this.macroPoller.stop();
    this.volatilityPoller.stop();
    this.ivPoller.stop();

    if (this.marketHoursTimer) {
      clearInterval(this.marketHoursTimer);
      this.marketHoursTimer = null;
    }
  }

  addSymbol(symbol: string): void {
    this.gexPoller.addSymbol(symbol);
    this.flowPoller.addSymbol(symbol);
    this.volatilityPoller.addSymbol(symbol);
    this.ivPoller.addSymbol(symbol);
    log.info({ symbol }, 'Symbol added to all pollers');
  }

  removeSymbol(symbol: string): void {
    this.gexPoller.removeSymbol(symbol);
    this.flowPoller.removeSymbol(symbol);
    this.volatilityPoller.removeSymbol(symbol);
    this.ivPoller.removeSymbol(symbol);
    log.info({ symbol }, 'Symbol removed from all pollers');
  }

  getActiveSymbols(): string[] {
    return this.gexPoller.getSymbols();
  }

  getStatus(): Record<string, { running: boolean; symbols?: string[] }> {
    return {
      gex: { running: this.gexPoller.isRunning(), symbols: this.gexPoller.getSymbols() },
      flow: { running: this.flowPoller.isRunning(), symbols: this.flowPoller.getSymbols() },
      vix: { running: this.vixPoller.isRunning() },
      macro: { running: this.macroPoller.isRunning() },
      volatility: { running: this.volatilityPoller.isRunning(), symbols: this.volatilityPoller.getSymbols() },
      iv: { running: this.ivPoller.isRunning(), symbols: this.ivPoller.getSymbols() },
    };
  }

  private startMarketHoursMonitor(): void {
    this.checkMarketHours();
    this.marketHoursTimer = setInterval(() => this.checkMarketHours(), 60_000);
  }

  private checkMarketHours(): void {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    const totalUtcMin = utcHour * 60 + utcMin;
    const day = now.getUTCDay();

    // NYSE RTH: 9:30-16:00 ET = 14:30-21:00 UTC (approx, DST shifts this)
    const isWeekday = day >= 1 && day <= 5;
    const isRTH = isWeekday && totalUtcMin >= 870 && totalUtcMin < 1260;

    if (isRTH !== this.isRTH) {
      this.isRTH = isRTH;
      this.gexPoller.setMarketHoursInterval(isRTH);
      log.info({ isRTH }, 'Market hours state changed');
    }
  }
}
