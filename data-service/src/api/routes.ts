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

  // --- Volatility regime (persisted snapshot — no live recomputation) ---

  router.get('/regime/summary', async (req: Request, res: Response) => {
    try {
      if (!context?.snapshotStore) {
        res.status(503).json({ error: 'Snapshot store unavailable' });
        return;
      }
      const raw = (req.query.symbols as string) || '';
      const symbols = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (symbols.length === 0) {
        res.status(400).json({ error: 'Missing symbols query parameter' });
        return;
      }
      const data = await context.snapshotStore.getRegimeSummary(symbols);
      res.json({
        data: data.map((s) => ({
          symbol: s.symbol,
          regime: s.regime,
          hvPercentile: s.metrics.hvPercentile252,
          atrRatio: s.metrics.atr30 !== 0 ? s.metrics.atr14 / s.metrics.atr30 : 0,
          computedAt: s.computedAt,
          analyticsVersion: s.analyticsVersion,
        })),
        count: data.length,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/regime/:symbol', async (req: Request<SymbolParams>, res: Response) => {
    try {
      if (!context?.snapshotStore) {
        res.status(503).json({ error: 'Snapshot store unavailable' });
        return;
      }

      const asOfRaw = req.query.asOf as string | undefined;
      let snapshot;

      if (asOfRaw) {
        const asOf = new Date(asOfRaw);
        if (isNaN(asOf.getTime())) {
          res.status(400).json({ error: `Invalid asOf date: ${asOfRaw}` });
          return;
        }
        snapshot = await context.snapshotStore.getRegimeAsOf(sym(req), asOf);
      } else {
        snapshot = await context.snapshotStore.getLatestVolatilitySnapshot(sym(req));
      }

      if (!snapshot) {
        res.status(404).json({ error: `No volatility regime snapshot found for ${sym(req)}` });
        return;
      }
      res.json(snapshot);
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

  // --- IV history endpoint ---

  router.get('/history/iv/:symbol', async (req: Request<SymbolParams>, res: Response) => {
    try {
      const limit = parseInt((req.query.limit as string) || '50', 10);
      const data = context?.snapshotStore
        ? await context.snapshotStore.getRecentIv(sym(req), limit)
        : [];
      res.json({ data, count: data.length });
    } catch (err) {
      handleError(res, err);
    }
  });

  // --- Seed endpoint: pull initial data for symbols from all providers ---

  router.post('/seed', async (req: Request, res: Response) => {
    try {
      const body = req.body as { symbols?: string[] };
      const symbols = (body.symbols || ['SPY', 'QQQ', 'IWM']).map((s: string) => s.toUpperCase());
      const lookbackDays = 252;

      const results: Record<string, { candles?: number; regime?: string; gex?: boolean; flow?: boolean; iv?: boolean; vix?: boolean; macro?: boolean; errors: string[] }> = {};

      // 1. VIX + Macro (global, not per-symbol)
      let vixOk = false;
      let macroOk = false;
      try {
        await orchestrator.getVIX();
        vixOk = true;
      } catch (err) {
        // VIX fetch failed — non-critical
      }
      try {
        if (context?.fred) {
          await context.fred.getAllMacroData();
          macroOk = true;
        }
      } catch {
        // Macro fetch failed — non-critical
      }

      // 2. Per-symbol: candles, regime, GEX, flow, IV
      for (const symbol of symbols) {
        const r: { candles?: number; regime?: string; gex?: boolean; flow?: boolean; iv?: boolean; vix?: boolean; macro?: boolean; errors: string[] } = { errors: [] };
        r.vix = vixOk;
        r.macro = macroOk;

        // Historical candles (1d, last 252 days) — fetched + persisted
        try {
          const end = new Date();
          const start = new Date();
          start.setDate(start.getDate() - Math.ceil(lookbackDays * 1.5));

          const candleResult = await orchestrator.getCandles(symbol, '1day', lookbackDays);
          const candles = candleResult.data;

          if (context?.snapshotStore && Array.isArray(candles) && candles.length > 0) {
            await context.snapshotStore.saveCandles(symbol, '1day', candles, candleResult.provider);
          }
          r.candles = Array.isArray(candles) ? candles.length : 0;
        } catch (err) {
          r.errors.push(`candles: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Volatility regime from candles
        try {
          const candleResult = await orchestrator.getCandles(symbol, '1day', lookbackDays);
          const candles = candleResult.data;
          if (Array.isArray(candles) && candles.length >= 60) {
            const { buildDerivedMetrics, detectRegime } = await import('../analytics/regime.service');
            const metrics = buildDerivedMetrics(symbol, candles);
            const snapshot = detectRegime(metrics, candles);
            if (context?.snapshotStore) {
              await context.snapshotStore.saveVolatilitySnapshot(snapshot);
            }
            r.regime = snapshot.regime;
          }
        } catch (err) {
          r.errors.push(`regime: ${err instanceof Error ? err.message : String(err)}`);
        }

        // GEX snapshot
        try {
          await orchestrator.getGEXWithSnapshot(symbol);
          r.gex = true;
        } catch (err) {
          r.gex = false;
          r.errors.push(`gex: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Flow snapshot
        try {
          await orchestrator.getFlowWithSnapshot(symbol);
          r.flow = true;
        } catch (err) {
          r.flow = false;
          r.errors.push(`flow: ${err instanceof Error ? err.message : String(err)}`);
        }

        // IV snapshot
        try {
          const ivResult = await orchestrator.getIV(symbol);
          if (context?.snapshotStore) {
            await context.snapshotStore.saveIvSnapshot(symbol, {
              currentIV: ivResult.data.currentIV,
              ivRank: ivResult.data.ivRank,
              ivPercentile: ivResult.data.ivPercentile,
              historicalIV30: ivResult.data.historicalIV30,
              historicalIV60: ivResult.data.historicalIV60,
              historicalIV90: ivResult.data.historicalIV90,
            }, ivResult.provider);
          }
          r.iv = true;
        } catch (err) {
          r.iv = false;
          r.errors.push(`iv: ${err instanceof Error ? err.message : String(err)}`);
        }

        results[symbol] = r;
      }

      res.json({
        seeded: symbols,
        results,
        timestamp: Date.now(),
      });
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
