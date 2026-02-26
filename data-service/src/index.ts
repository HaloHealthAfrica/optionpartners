import express from 'express';
import cors from 'cors';
import { config } from './config';
import { logger } from './utils/logger';
import { DataOrchestrator } from './services/data-orchestrator';
import { MacroRegimeService } from './services/macro-regime';
import { TwelveDataClient } from './providers/twelvedata-client';
import { UnusualWhalesClient } from './providers/unusual-whales-client';
import { PolygonClient } from './providers/polygon-client';
import { CboeClient } from './providers/cboe-client';
import { FredClient } from './providers/fred-client';
import { cacheManager } from './cache';
import { initDatabase, runMigrations, closeDatabase, snapshotStore } from './persistence';
import { WorkerManager } from './workers/worker-manager';
import { createRoutes } from './api/routes';
import { apiKeyAuth } from './api/auth-middleware';

async function main() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // --- Initialize cache (Redis + memory fallback) ---
  await cacheManager.initialize();

  // --- Initialize database (Postgres — graceful if unavailable) ---
  const dbAvailable = await initDatabase();
  if (dbAvailable) {
    await runMigrations();
    snapshotStore.setAvailable(true);
    logger.info('Database initialized, migrations applied, snapshots enabled');
  } else {
    logger.warn('Database unavailable — running without snapshot persistence');
  }

  // --- Initialize providers ---
  const orchestrator = new DataOrchestrator();

  if (config.twelveData.apiKey) {
    orchestrator.registerProvider(new TwelveDataClient());
    logger.info('TwelveData provider registered (primary stock/candles)');
  }

  if (config.unusualWhales.apiKey) {
    orchestrator.registerProvider(new UnusualWhalesClient());
    logger.info('Unusual Whales provider registered (primary options/GEX/flow)');
  }

  if (config.polygon.apiKey) {
    orchestrator.registerProvider(new PolygonClient());
    logger.info('Polygon provider registered (tertiary fallback)');
  }

  // --- Initialize CBOE + FRED + Macro Regime ---
  const cboe = new CboeClient();
  const fred = new FredClient();
  const macroRegime = new MacroRegimeService(cboe, fred);
  orchestrator.setMacroRegimeService(macroRegime);
  logger.info('CBOE VIX + FRED macro providers registered');

  // --- Initialize polling workers ---
  const workerManager = new WorkerManager(orchestrator, macroRegime);
  workerManager.start();
  logger.info('Polling workers started');

  // --- Mount routes ---
  app.get('/', (_req, res) => {
    res.json({
      service: '@trade-partners/data-service',
      version: '1.0.0',
      status: 'running',
      endpoints: [
        'GET /api/quote/:symbol',
        'GET /api/candles/:symbol?timeframe=5min&limit=100',
        'GET /api/market-hours',
        'GET /api/options-chain/:symbol',
        'GET /api/gex/:symbol',
        'GET /api/flow/:symbol',
        'GET /api/iv/:symbol',
        'GET /api/vix',
        'GET /api/regime',
        'GET /api/macro',
        'GET /api/gex/:symbol/snapshot',
        'GET /api/flow/:symbol/snapshot',
        'GET /api/history/gex/:symbol?limit=50',
        'GET /api/history/flow/:symbol?limit=50',
        'GET /api/history/vix?limit=100',
        'GET /api/health',
        'GET /api/workers/status',
        'POST /api/workers/symbols',
        'DELETE /api/workers/symbols/:symbol',
      ],
    });
  });

  app.use('/api', apiKeyAuth, createRoutes(orchestrator, {
    snapshotStore,
    cboe,
    fred,
    dbAvailable,
    workerManager,
  }));

  // --- Graceful shutdown ---
  const shutdown = async () => {
    logger.info('Shutting down...');
    workerManager.stop();
    await cacheManager.shutdown();
    await closeDatabase();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // --- Start server ---
  app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'Data Integration Service started');
  });
}

main().catch((err) => {
  logger.fatal({ error: err }, 'Failed to start Data Integration Service');
  process.exit(1);
});
