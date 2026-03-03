import express from 'express';
import cors from 'cors';
import { config, validateProviderConfiguration } from './config';
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
import { createV1Routes } from './api/v1-routes';
import { apiKeyAuth } from './api/auth-middleware';
import { MarketDataClient } from './providers/marketdata/client';
import { MarketDataAdapter } from './providers/marketdata/adapter';
import { circuitBreaker } from './services/circuit-breaker';

async function main() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // --- Validate provider configuration at startup ---
  const configValidation = validateProviderConfiguration();
  logger.info({
    configuredProviders: configValidation.configuredCount,
    apiKeys: configValidation.summary,
  }, configValidation.message);

  if (!configValidation.isValid) {
    logger.error('Configuration validation failed: No provider API keys configured');
  }

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
  let registeredProviderCount = 0;

  // TwelveData provider registration
  if (config.twelveData.apiKey) {
    orchestrator.registerProvider(new TwelveDataClient());
    logger.info('TwelveData provider registered successfully (primary stock/candles) - API key present');
    registeredProviderCount++;
  } else {
    orchestrator.trackProviderRegistrationFailure('twelvedata', 'API key missing or empty', false);
    logger.warn('TwelveData provider failed to register - API key missing or empty');
  }

  // Unusual Whales provider registration
  if (config.unusualWhales.apiKey) {
    orchestrator.registerProvider(new UnusualWhalesClient());
    logger.info('Unusual Whales provider registered successfully (primary options/GEX/flow) - API key present');
    registeredProviderCount++;
  } else {
    orchestrator.trackProviderRegistrationFailure('unusual_whales', 'API key missing or empty', false);
    logger.warn('Unusual Whales provider failed to register - API key missing or empty');
  }

  // Polygon provider registration
  if (config.polygon.apiKey) {
    orchestrator.registerProvider(new PolygonClient());
    logger.info('Polygon provider registered successfully (tertiary fallback) - API key present');
    registeredProviderCount++;
  } else {
    orchestrator.trackProviderRegistrationFailure('polygon', 'API key missing or empty', false);
    logger.warn('Polygon provider failed to register - API key missing or empty');
  }

  // Provider registration validation summary
  if (registeredProviderCount === 0) {
    logger.error('CRITICAL: Zero data providers registered - service will not be able to fetch real market data. Please configure at least one provider API key (TWELVE_DATA_API_KEY, UNUSUAL_WHALES_API_KEY, or POLYGON_API_KEY)');
  } else {
    logger.info(`Provider registration complete: ${registeredProviderCount} provider(s) registered successfully`);
  }

  // --- Initialize MarketData.app adapter (IP-whitelisted, options authority) ---
  let marketDataAdapter: MarketDataAdapter | undefined;
  if (config.marketData.apiToken) {
    const mdClient = new MarketDataClient(config.marketData.apiToken);
    marketDataAdapter = new MarketDataAdapter(mdClient);
    logger.info('MarketData.app adapter initialized (options chain authority)');
  } else {
    logger.warn('MARKETDATA_API_TOKEN not set — MarketData.app adapter disabled');
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

  // --- Public health endpoint (no auth — used by Fly.io health checks) ---
  app.get('/api/health', async (_req, res) => {
    try {
      const providers = orchestrator.getProviderHealths();
      const isReady = registeredProviderCount > 0;
      
      res.json({
        status: isReady ? 'ok' : 'degraded',
        ready: isReady,
        providers,
        configuration: {
          apiKeysConfigured: configValidation.configuredCount,
          providersRegistered: registeredProviderCount,
          apiKeys: configValidation.summary,
        },
      });
    } catch {
      res.status(503).json({ status: 'degraded', ready: false });
    }
  });

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
        'GET /api/regime/:symbol?asOf=ISO_DATE',
        'GET /api/regime/summary?symbols=SPY,QQQ,IWM',
        'GET /api/health',
        'GET /api/workers/status',
        'POST /api/workers/symbols',
        'DELETE /api/workers/symbols/:symbol',
        'GET /v1/underlying/:symbol/quote',
        'GET /v1/options/:symbol/expirations',
        'GET /v1/options/:symbol/chain?exp=YYYY-MM-DD&right=CALL|PUT',
        'POST /v1/options/quotes',
        'POST /v1/options/greeks',
        'GET /v1/historical/:symbol/candles?tf=1d&start=YYYY-MM-DD&end=YYYY-MM-DD',
        'GET /v1/historical/:symbol/metrics?tf=1d&lookback=252',
        'GET /v1/historical/:symbol/regime?tf=1d&lookback=252',
        'GET /v1/historical/:symbol/iv (P1 stub)',
        'GET /v1/meta/sources',
        'GET /v1/health',
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

  // --- Mount v1 API routes (options, strike selection, observability) ---
  app.use('/v1', createV1Routes({
    orchestrator,
    marketDataAdapter,
    cacheManager,
    circuitBreaker,
    apiKey: config.apiKey,
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
  const host = process.env.HOST || '0.0.0.0';
  app.listen(config.port, host, () => {
    logger.info({ port: config.port, host, env: config.nodeEnv }, 'Data Integration Service started');
  });
}

main().catch((err) => {
  logger.fatal({ error: err }, 'Failed to start Data Integration Service');
  process.exit(1);
});
