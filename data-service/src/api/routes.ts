import { Router, Request, Response } from 'express';
import type { DataOrchestrator } from '../services/data-orchestrator';
import type { SnapshotStore } from '../persistence/snapshot-store';
import type { CboeClient } from '../providers/cboe-client';
import type { FredClient } from '../providers/fred-client';
import type { WorkerManager } from '../workers/worker-manager';
import type { Timeframe } from '../types';

type SymbolParams = { symbol: string };

const VALID_TIMEFRAMES = new Set<Timeframe>([
  '1min', '5min', '15min', '30min', '1h', '4h', '1day', '1week',
]);

function sym(req: Request<SymbolParams>): string {
  return String(req.params.symbol).toUpperCase();
}

export interface RouteContext {
  orchestrator: DataOrchestrator;
  snapshotStore?: SnapshotStore;
  cboe?: CboeClient;
  fred?: FredClient;
  dbAvailable?: boolean;
  workerManager?: WorkerManager;
}

export function createRoutes(
  orchestrator: DataOrchestrator,
  context?: Omit<RouteContext, 'orchestrator'>,
): Router {
  const router = Router();

  router.get('/quote/:symbol', async (req: Request<SymbolParams>, res: Response) => {
    try {
      const result = await orchestrator.getQuote(sym(req));
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/candles/:symbol', async (req: Request<SymbolParams>, res: Response) => {
    try {
      const timeframe = (req.query.timeframe as string) || '5min';
      if (!VALID_TIMEFRAMES.has(timeframe as Timeframe)) {
        res.status(400).json({ error: `Invalid timeframe: ${timeframe}` });
        return;
      }
      const limit = parseInt((req.query.limit as string) || '100', 10);
      const result = await orchestrator.getCandles(sym(req), timeframe as Timeframe, limit);
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/market-hours', async (_req: Request, res: Response) => {
    try {
      const result = await orchestrator.getMarketHours();
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/options-chain/:symbol', async (req: Request<SymbolParams>, res: Response) => {
    try {
      const expiration = req.query.expiration as string | undefined;
      const result = await orchestrator.getOptionsChain(sym(req), expiration);
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/gex/:symbol', async (req: Request<SymbolParams>, res: Response) => {
    try {
      const result = await orchestrator.getGEX(sym(req));
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/flow/:symbol', async (req: Request<SymbolParams>, res: Response) => {
    try {
      const result = await orchestrator.getFlow(sym(req));
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/iv/:symbol', async (req: Request<SymbolParams>, res: Response) => {
    try {
      const result = await orchestrator.getIV(sym(req));
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  // --- Phase 3: VIX / Macro / Regime ---

  router.get('/vix', async (_req: Request, res: Response) => {
    try {
      const result = await orchestrator.getVIX();
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/regime', async (_req: Request, res: Response) => {
    try {
      const result = await orchestrator.getMarketRegime();
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/macro', async (_req: Request, res: Response) => {
    try {
      const result = await orchestrator.getMacroData();
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  // --- Snapshot-persisted endpoints (same data, also writes to Postgres) ---

  router.get('/gex/:symbol/snapshot', async (req: Request<SymbolParams>, res: Response) => {
    try {
      const result = await orchestrator.getGEXWithSnapshot(sym(req));
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/flow/:symbol/snapshot', async (req: Request<SymbolParams>, res: Response) => {
    try {
      const result = await orchestrator.getFlowWithSnapshot(sym(req));
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const providers = orchestrator.getProviderHealths();
      const checks = await orchestrator.runHealthChecks();

      const cboeHealthy = context?.cboe ? await context.cboe.healthCheck() : null;
      const fredHealthy = context?.fred ? await context.fred.healthCheck() : null;

      const allProvidersHealthy = providers.every((p) => p.healthy);
      const overallHealthy = allProvidersHealthy && cboeHealthy !== false;

      res.status(overallHealthy ? 200 : 503).json({
        status: overallHealthy ? 'healthy' : 'degraded',
        uptime: process.uptime(),
        providers,
        liveChecks: {
          ...checks,
          cboe: cboeHealthy,
          fred: fredHealthy,
        },
        infrastructure: {
          database: context?.dbAvailable ?? false,
          snapshotsEnabled: context?.dbAvailable ?? false,
        },
        timestamp: Date.now(),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // --- History endpoints (read from Postgres) ---

  router.get('/history/gex/:symbol', async (req: Request<SymbolParams>, res: Response) => {
    try {
      const limit = parseInt((req.query.limit as string) || '50', 10);
      const data = context?.snapshotStore
        ? await context.snapshotStore.getRecentGex(sym(req), limit)
        : [];
      res.json({ data, count: data.length });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/history/flow/:symbol', async (req: Request<SymbolParams>, res: Response) => {
    try {
      const limit = parseInt((req.query.limit as string) || '50', 10);
      const data = context?.snapshotStore
        ? await context.snapshotStore.getRecentFlow(sym(req), limit)
        : [];
      res.json({ data, count: data.length });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/history/vix', async (req: Request, res: Response) => {
    try {
      const limit = parseInt((req.query.limit as string) || '100', 10);
      const data = context?.snapshotStore
        ? await context.snapshotStore.getVixHistory(limit)
        : [];
      res.json({ data, count: data.length });
    } catch (err) {
      handleError(res, err);
    }
  });

  // --- Worker management endpoints ---

  router.get('/workers/status', (_req: Request, res: Response) => {
    if (!context?.workerManager) {
      res.json({ status: 'workers not initialized' });
      return;
    }
    res.json({
      workers: context.workerManager.getStatus(),
      activeSymbols: context.workerManager.getActiveSymbols(),
    });
  });

  router.post('/workers/symbols', (req: Request, res: Response) => {
    if (!context?.workerManager) {
      res.status(503).json({ error: 'Workers not initialized' });
      return;
    }
    const { symbol } = req.body as { symbol?: string };
    if (!symbol || typeof symbol !== 'string') {
      res.status(400).json({ error: 'Missing or invalid symbol' });
      return;
    }
    context.workerManager.addSymbol(symbol.toUpperCase());
    res.json({
      added: symbol.toUpperCase(),
      activeSymbols: context.workerManager.getActiveSymbols(),
    });
  });

  router.delete('/workers/symbols/:symbol', (req: Request<SymbolParams>, res: Response) => {
    if (!context?.workerManager) {
      res.status(503).json({ error: 'Workers not initialized' });
      return;
    }
    context.workerManager.removeSymbol(sym(req));
    res.json({
      removed: sym(req),
      activeSymbols: context.workerManager.getActiveSymbols(),
    });
  });

  return router;
}

function handleError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : 'Unknown error';
  const status = message.includes('CIRCUIT_OPEN') ? 503 : message.includes('RATE_LIMITED') ? 429 : 500;
  res.status(status).json({ error: message, timestamp: Date.now() });
}
