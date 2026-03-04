import { createChildLogger } from '../utils/logger';
import { GexPoller } from './gex-poller';
import { FlowPoller } from './flow-poller';
import { VixPoller } from './vix-poller';
import { MacroPoller } from './macro-poller';
import { VolatilityPoller } from './volatility-poller';
import { IvPoller } from './iv-poller';
import { ChainPricePoller } from './chain-price-poller';
import { MarketSession, getCurrentSession, isActiveSession } from './market-session';
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
  enableChainPrice?: boolean;
}

const DEFAULT_SYMBOLS = ['SPY', 'QQQ', 'IWM'];

export class WorkerManager {
  readonly gexPoller: GexPoller;
  readonly flowPoller: FlowPoller;
  readonly vixPoller: VixPoller;
  readonly macroPoller: MacroPoller;
  readonly volatilityPoller: VolatilityPoller;
  readonly ivPoller: IvPoller;
  readonly chainPricePoller: ChainPricePoller;

  private marketHoursTimer: ReturnType<typeof setInterval> | null = null;
  private currentSession: MarketSession = MarketSession.OVERNIGHT;

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
    this.chainPricePoller = new ChainPricePoller(orchestrator, symbols);
  }

  start(config: WorkerManagerConfig = {}): void {
    log.info('Starting polling workers');

    if (config.enableGex !== false) this.gexPoller.start();
    if (config.enableFlow !== false) this.flowPoller.start();
    if (config.enableVix !== false) this.vixPoller.start();
    if (config.enableMacro !== false) this.macroPoller.start();
    if (config.enableVolatility !== false) this.volatilityPoller.start();
    if (config.enableIv !== false) this.ivPoller.start();
    if (config.enableChainPrice !== false) this.chainPricePoller.start();

    this.startMarketHoursMonitor();

    log.info({
      gex: this.gexPoller.isRunning(),
      flow: this.flowPoller.isRunning(),
      vix: this.vixPoller.isRunning(),
      macro: this.macroPoller.isRunning(),
      volatility: this.volatilityPoller.isRunning(),
      iv: this.ivPoller.isRunning(),
      chainPrice: this.chainPricePoller.isRunning(),
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
    this.chainPricePoller.stop();

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
    this.chainPricePoller.addSymbol(symbol);
    log.info({ symbol }, 'Symbol added to all pollers');
  }

  removeSymbol(symbol: string): void {
    this.gexPoller.removeSymbol(symbol);
    this.flowPoller.removeSymbol(symbol);
    this.volatilityPoller.removeSymbol(symbol);
    this.ivPoller.removeSymbol(symbol);
    this.chainPricePoller.removeSymbol(symbol);
    log.info({ symbol }, 'Symbol removed from all pollers');
  }

  getActiveSymbols(): string[] {
    return this.gexPoller.getSymbols();
  }

  getCurrentSession(): MarketSession {
    return this.currentSession;
  }

  getStatus(): Record<string, { running: boolean; paused?: boolean; symbols?: string[]; metrics?: unknown }> {
    return {
      gex: { running: this.gexPoller.isRunning(), paused: this.gexPoller.isPaused(), symbols: this.gexPoller.getSymbols() },
      flow: { running: this.flowPoller.isRunning(), paused: this.flowPoller.isPaused(), symbols: this.flowPoller.getSymbols() },
      vix: { running: this.vixPoller.isRunning(), paused: this.vixPoller.isPaused() },
      macro: { running: this.macroPoller.isRunning(), paused: this.macroPoller.isPaused() },
      volatility: { running: this.volatilityPoller.isRunning(), paused: this.volatilityPoller.isPaused(), symbols: this.volatilityPoller.getSymbols() },
      iv: { running: this.ivPoller.isRunning(), paused: this.ivPoller.isPaused(), symbols: this.ivPoller.getSymbols() },
      chainPrice: { running: this.chainPricePoller.isRunning(), paused: this.chainPricePoller.isPaused(), symbols: this.chainPricePoller.getSymbols(), metrics: this.chainPricePoller.getMetrics() },
    };
  }

  private startMarketHoursMonitor(): void {
    this.applySession(getCurrentSession());
    this.marketHoursTimer = setInterval(() => {
      const session = getCurrentSession();
      if (session !== this.currentSession) {
        this.applySession(session);
      }
    }, 60_000);
  }

  private applySession(session: MarketSession): void {
    const prev = this.currentSession;
    this.currentSession = session;

    log.info({ session, previousSession: prev }, 'Market session changed — adjusting pollers');

    this.gexPoller.setSession(session);
    this.flowPoller.setSession(session);
    this.ivPoller.setSession(session);
    this.chainPricePoller.setSession(session);

    // VIX (CBOE) is cheap; keep it running but pause on weekends
    if (session === MarketSession.WEEKEND) {
      this.vixPoller.pause();
    } else if (prev === MarketSession.WEEKEND) {
      this.vixPoller.resume();
    }
  }
}

export { MarketSession } from './market-session';
