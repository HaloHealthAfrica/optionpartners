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
import { MarketDataAppProvider } from './providers/marketdata/provider';
import { computedGexProvider } from './providers/computed-gex-provider';
import { circuitBreaker, rateLimiter, monitoringService } from './services';

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

  // --- Initialize rate limiter (load persisted state, validate configuration) ---
  await rateLimiter.initialize();
  try {
    // Validate rate limit configurations
    rateLimiter.validateConfiguration([
      { provider: 'twelvedata', maxPerMinute: config.twelveData.rateLimit },
      { provider: 'unusual_whales', maxPerMinute: config.unusualWhales.rateLimit },
      { provider: 'polygon', maxPerMinute: config.polygon.rateLimit },
      { provider: 'cboe', maxPerMinute: config.cboe.rateLimit },
      { provider: 'marketdata', maxPerMinute: config.marketData.rateLimit },
    ]);
    logger.info('Rate limiter configuration validated successfully');
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : err }, 'Rate limiter configuration validation failed');
    throw err;
  }

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

  // TwelveData provider registration (primary stock/candles)
  if (config.twelveData.apiKey) {
    orchestrator.registerProvider(new TwelveDataClient());
    logger.info('TwelveData provider registered successfully (primary stock/candles) - API key present');
    registeredProviderCount++;
  } else {
    orchestrator.trackProviderRegistrationFailure('twelvedata', 'API key missing or empty', false);
    logger.warn('TwelveData provider failed to register - API key missing or empty');
  }

  // Unusual Whales provider registration (primary options chain + GEX/flow/IV)
  if (config.unusualWhales.apiKey) {
    orchestrator.registerProvider(new UnusualWhalesClient());
    logger.info('Unusual Whales provider registered successfully (primary options chain + GEX/flow/IV) - API key present');
    registeredProviderCount++;
  } else {
    orchestrator.trackProviderRegistrationFailure('unusual_whales', 'API key missing or empty', false);
    logger.warn('Unusual Whales provider failed to register - API key missing or empty');
  }

  // MarketData.app provider registration (fallback options chain — real-time, 100K daily credits)
  if (config.marketData.apiToken) {
    orchestrator.registerProvider(new MarketDataAppProvider());
    logger.info('MarketData.app provider registered successfully (fallback options chain) - API token present');
    registeredProviderCount++;
  } else {
    orchestrator.trackProviderRegistrationFailure('marketdata', 'API token missing or empty', false);
    logger.warn('MarketData.app provider not registered - MARKETDATA_API_TOKEN not set');
  }

  // Polygon provider registration (tertiary options chain — 15-min delayed, real Greeks)
  if (config.polygon.apiKey) {
    orchestrator.registerProvider(new PolygonClient());
    logger.info('Polygon provider registered successfully (tertiary options chain) - API key present');
    registeredProviderCount++;
  } else {
    orchestrator.trackProviderRegistrationFailure('polygon', 'API key missing or empty', false);
    logger.warn('Polygon provider failed to register - API key missing or empty');
  }

  // Computed GEX provider (fallback GEX — derived from chain data, zero API calls)
  orchestrator.registerProvider(computedGexProvider);
  logger.info('Computed GEX provider registered (fallback GEX from chain data — zero extra API calls)');

  // Provider registration validation summary
  if (registeredProviderCount === 0) {
    logger.error('CRITICAL: Zero data providers registered - service will not be able to fetch real market data. Please configure at least one provider API key (TWELVE_DATA_API_KEY, UNUSUAL_WHALES_API_KEY, or POLYGON_API_KEY)');
  } else {
    logger.info(`Provider registration complete: ${registeredProviderCount} provider(s) registered successfully`);
  }

  // --- Validate rate limiters are configured for all registered providers ---
  const registeredProviders: Array<'twelvedata' | 'unusual_whales' | 'polygon' | 'cboe' | 'marketdata'> = [];
  if (config.twelveData.apiKey) registeredProviders.push('twelvedata');
  if (config.unusualWhales.apiKey) registeredProviders.push('unusual_whales');
  if (config.polygon.apiKey) registeredProviders.push('polygon');
  if (config.cboe.rateLimit) {
    registeredProviders.push('cboe');
    rateLimiter.configure('cboe', config.cboe.rateLimit);
  }
  if (config.marketData.apiToken) registeredProviders.push('marketdata');

  try {
    if (registeredProviders.length > 0) {
      rateLimiter.validateAllProvidersConfigured(registeredProviders);
      const rateLimitStatus = rateLimiter.getAllStatus();
      logger.info({ 
        providers: rateLimitStatus.map(s => ({ 
          provider: s.provider, 
          maxTokens: s.maxTokens, 
          remaining: s.remaining 
        })) 
      }, 'Rate limiter status for all configured providers');
    }
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : err }, 'Rate limiter provider validation failed');
    throw err;
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

  // --- Minimal liveness (no auth — for circuit breaker recovery probe) ---
  // Always returns 200 if process is running. Backend uses this to detect service reachability.
  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
  });

  // --- Public health endpoint (no auth — used by Fly.io health checks) ---
  app.get('/api/health', async (_req, res) => {
    try {
      const providers = orchestrator.getProviderHealths();
      const workerStatus = workerManager.getStatus();
      const chainPriceMetrics = workerManager.chainPricePoller.getMetrics();
      const monitoringMetrics = monitoringService.getMetrics();
      const healthStatus = monitoringService.getHealthStatus();
      const isReady = registeredProviderCount > 0;

      // Determine if any critical feeds are dead
      const spyMetrics = chainPriceMetrics['SPY'];
      const hasFreshPrice = spyMetrics && (Date.now() - spyMetrics.lastPriceAt) < 300_000;
      const hasFreshChain = spyMetrics && (Date.now() - spyMetrics.lastChainAt) < 600_000;
      const healthyFeeds = hasFreshPrice && hasFreshChain;

      res.json({
        status: isReady
          ? healthyFeeds && healthStatus.status === 'healthy'
            ? 'ok'
            : 'degraded'
          : 'unhealthy',
        ready: isReady,
        uptime: process.uptime(),
        providers,
        workers: workerStatus,
        feeds: {
          price: {
            lastAt: spyMetrics?.lastPriceAt ? new Date(spyMetrics.lastPriceAt).toISOString() : null,
            fresh: hasFreshPrice,
            failures: spyMetrics?.priceFails ?? 0,
          },
          chain: {
            lastAt: spyMetrics?.lastChainAt ? new Date(spyMetrics.lastChainAt).toISOString() : null,
            fresh: hasFreshChain,
            failures: spyMetrics?.chainFails ?? 0,
          },
          allSymbols: chainPriceMetrics,
        },
        configuration: {
          apiKeysConfigured: configValidation.configuredCount,
          providersRegistered: registeredProviderCount,
          apiKeys: configValidation.summary,
        },
        monitoring: {
          timestamp: monitoringMetrics.timestamp,
          circuitBreakers: {
            total: monitoringMetrics.summary.totalProviders,
            closed: monitoringMetrics.summary.circuitBreakersClosed,
            open: monitoringMetrics.summary.circuitBreakersOpen,
            halfOpen: monitoringMetrics.summary.circuitBreakersHalfOpen,
          },
          rateLimiters: {
            healthy: monitoringMetrics.summary.rateLimitersHealthy,
            degraded: monitoringMetrics.summary.rateLimitersDegraded,
          },
          healthStatus: healthStatus.status,
        },
      });
    } catch {
      res.status(503).json({ status: 'degraded', ready: false });
    }
  });

  // --- Readiness probe (Fly.io / k8s) ---
  app.get('/api/readyz', async (_req, res) => {
    try {
      const metrics = workerManager.chainPricePoller.getMetrics();
      const spyMetrics = metrics['SPY'];
      const pollingActive = workerManager.chainPricePoller.isRunning();
      const hasFreshData = spyMetrics && (Date.now() - spyMetrics.lastPriceAt) < 300_000;

      if (pollingActive && registeredProviderCount > 0) {
        res.json({ ready: true, pollingActive, hasFreshData, providers: registeredProviderCount });
      } else {
        res.status(503).json({ ready: false, pollingActive, hasFreshData, providers: registeredProviderCount });
      }
    } catch {
      res.status(503).json({ ready: false });
    }
  });

  // --- Admin monitoring endpoints (detailed metrics) ---
  
  // Circuit breaker detailed metrics endpoint
  app.get('/api/admin/circuit-breaker/status', apiKeyAuth, async (_req, res) => {
    try {
      const metrics = monitoringService.getCircuitBreakerMetrics();
      const healthStatus = monitoringService.getHealthStatus();
      
      res.json({
        timestamp: new Date().toISOString(),
        healthy: healthStatus.status === 'healthy',
        status: healthStatus.status,
        details: healthStatus.details,
        circuitBreakers: metrics,
        summary: {
          total: metrics.length,
          closed: metrics.filter(m => m.state === 'closed').length,
          open: metrics.filter(m => m.state === 'open').length,
          halfOpen: metrics.filter(m => m.state === 'half-open').length,
        },
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to get circuit breaker metrics',
      });
    }
  });

  // Rate limiter detailed metrics endpoint
  app.get('/api/admin/rate-limiter/status', apiKeyAuth, async (_req, res) => {
    try {
      const metrics = monitoringService.getRateLimiterMetrics();
      const healthStatus = monitoringService.getHealthStatus();
      
      res.json({
        timestamp: new Date().toISOString(),
        healthy: healthStatus.status === 'healthy',
        status: healthStatus.status,
        details: healthStatus.details,
        rateLimiters: metrics,
        summary: {
          total: metrics.length,
          healthy: metrics.filter(m => m.healthy).length,
          degraded: metrics.filter(m => !m.healthy).length,
        },
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to get rate limiter metrics',
      });
    }
  });

  // Comprehensive monitoring metrics endpoint
  app.get('/api/admin/monitoring/metrics', apiKeyAuth, async (_req, res) => {
    try {
      const metrics = monitoringService.getMetrics();
      const healthy = monitoringService.areAllProvidersHealthy();
      
      res.json({
        ...metrics,
        healthy,
        allProvidersHealthy: healthy,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to get monitoring metrics',
      });
    }
  });

  // Provider-specific health endpoint
  app.get('/api/admin/monitoring/provider/:provider', apiKeyAuth, async (req, res) => {
    try {
      const provider = req.params.provider as any;
      const health = monitoringService.getProviderHealth(provider);
      
      if (!health.rateLimiter) {
        return res.status(404).json({
          error: `Provider not found: ${provider}`,
        });
      }
      
      res.json({
        provider: health.provider,
        healthy: health.healthy,
        circuitBreaker: health.circuitBreaker,
        rateLimiter: health.rateLimiter,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to get provider health',
      });
    }
  });

  // Provider performance metrics endpoint
  app.get('/api/admin/monitoring/performance', apiKeyAuth, async (_req, res) => {
    try {
      const metrics = monitoringService.getProviderPerformanceMetrics();
      res.json({
        timestamp: new Date().toISOString(),
        metrics,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to get performance metrics',
      });
    }
  });

  // Provider performance metrics for specific provider
  app.get('/api/admin/monitoring/performance/:provider', apiKeyAuth, async (req, res) => {
    try {
      const provider = req.params.provider as any;
      const metrics = monitoringService.getProviderPerformance(provider);
      
      if (!metrics) {
        return res.status(404).json({
          error: `Performance metrics not found for provider: ${provider}`,
        });
      }

      res.json({
        timestamp: new Date().toISOString(),
        metrics,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to get provider performance',
      });
    }
  });

  // Provider reliability report endpoint
  app.get('/api/admin/monitoring/reliability-report', apiKeyAuth, async (_req, res) => {
    try {
      const report = monitoringService.getReliabilityReport();
      res.json({
        timestamp: new Date().toISOString(),
        report,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to get reliability report',
      });
    }
  });

  // Fallback metrics endpoint
  app.get('/api/admin/monitoring/fallback', apiKeyAuth, async (_req, res) => {
    try {
      const metrics = monitoringService.getFallbackMetrics(orchestrator);
      res.json({
        timestamp: new Date().toISOString(),
        metrics,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to get fallback metrics',
      });
    }
  });

  // Load balancer strategy endpoints
  app.get('/api/admin/load-balancer/strategy', apiKeyAuth, async (_req, res) => {
    try {
      const strategy = orchestrator.getLoadBalancingStrategy();
      res.json({
        timestamp: new Date().toISOString(),
        strategy,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to get load balancer strategy',
      });
    }
  });

  app.post('/api/admin/load-balancer/strategy', apiKeyAuth, async (req, res) => {
    try {
      const { strategy } = req.body;
      if (typeof strategy !== 'string') {
        return res.status(400).json({ error: 'strategy must be a string' });
      }
      orchestrator.setLoadBalancingStrategy(strategy as any);
      res.json({
        timestamp: new Date().toISOString(),
        strategy,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to set load balancer strategy',
      });
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
