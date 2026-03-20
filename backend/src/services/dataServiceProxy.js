const axios = require('axios');
const logger = require('../utils/logger');
const Sentry = require('@sentry/node');
const connectivityGate = require('./connectivityGate');

const DATA_SERVICE_URL = process.env.DATA_SERVICE_URL || 'http://localhost:4000';
const DATA_SERVICE_API_KEY = process.env.DATA_SERVICE_API_KEY || 'dev-key';
const DATA_SERVICE_INTERNAL_KEY = process.env.DATA_SERVICE_INTERNAL_API_KEY || DATA_SERVICE_API_KEY;

const client = axios.create({
  baseURL: DATA_SERVICE_URL.replace(/\/$/, '') + '/api',
  timeout: 15000,
  headers: {
    'x-api-key': DATA_SERVICE_API_KEY,
    'Content-Type': 'application/json',
  },
});

const v1Client = axios.create({
  baseURL: DATA_SERVICE_URL.replace(/\/$/, '') + '/v1',
  timeout: 20000,
  headers: {
    'x-internal-api-key': DATA_SERVICE_INTERNAL_KEY,
    'Content-Type': 'application/json',
  },
});

async function proxyGet(path, params = {}) {
  if (!connectivityGate.canRequest()) {
    const error = new Error('Data service unreachable — connectivity gate UNHEALTHY');
    error.status = 503;
    throw error;
  }
  try {
    const response = await client.get(path, { params });
    return response.data;
  } catch (err) {
    const status = err.response?.status || 502;
    const message = err.response?.data?.error || err.message;
    logger.error(`[DataServiceProxy] ${path} failed: ${message}`, 'data-service');
    Sentry.captureException(err, { tags: { module: 'data-service-proxy' } });
    const error = new Error(message);
    error.status = status;
    throw error;
  }
}

async function v1Get(path, params = {}) {
  if (!connectivityGate.canRequest()) {
    const error = new Error('Data service unreachable — connectivity gate UNHEALTHY');
    error.status = 503;
    throw error;
  }
  try {
    const response = await v1Client.get(path, { params });
    return response.data;
  } catch (err) {
    const status = err.response?.status || 502;
    const message = err.response?.data?.error || err.message;
    logger.error(`[DataServiceProxy:v1] ${path} failed: ${message}`, 'data-service');
    Sentry.captureException(err, { tags: { module: 'data-service-proxy' } });
    const error = new Error(message);
    error.status = status;
    throw error;
  }
}

module.exports = {
  getQuote: (symbol) => proxyGet(`/quote/${symbol.toUpperCase()}`),
  getCandles: (symbol, timeframe = '5min', limit = 100) =>
    proxyGet(`/candles/${symbol.toUpperCase()}`, { timeframe, limit }),
  getMarketHours: () => proxyGet('/market-hours'),
  getOptionsChain: (symbol, expiration) =>
    proxyGet(`/options-chain/${symbol.toUpperCase()}`, expiration ? { expiration } : {}),
  getGEX: (symbol) => proxyGet(`/gex/${symbol.toUpperCase()}`),
  getFlow: (symbol) => proxyGet(`/flow/${symbol.toUpperCase()}`),
  getIV: (symbol) => proxyGet(`/iv/${symbol.toUpperCase()}`),
  getVIX: () => proxyGet('/vix'),
  getRegime: () => proxyGet('/regime'),
  getVolatilityRegime: (symbol) => proxyGet(`/regime/${symbol.toUpperCase()}`),
  getMacro: () => proxyGet('/macro'),
  getHealth: () => proxyGet('/health'),

  /**
   * Probe data-service liveness. Used by connectivity gate.
   * Any HTTP response (2xx/5xx) = reachable. Connection refused = unreachable.
   */
  async probeHealth() {
    for (const path of ['/ping', '/health']) {
      try {
        await client.get(path, { timeout: 10000 });
        return { ok: true };
      } catch (err) {
        if (err.response?.status === 404 && path === '/ping') continue;
        if (err.response?.status) return { ok: true };
        return { ok: false, error: err.message };
      }
    }
    return { ok: false, error: 'No probe path available' };
  },

  resetConnectivityGate: () => connectivityGate.reset(),
  getConnectivityState: () => connectivityGate.getState(),

  /**
   * Reset data-service's per-provider circuit breakers (optional).
   * Call after gate reset so data-service can retry failed providers.
   */
  async resetDataServiceCircuitBreakers() {
    try {
      const base = DATA_SERVICE_URL.replace(/\/$/, '');
      const response = await axios.post(
        `${base}/api/admin/circuit-breaker/reset`,
        {},
        {
          headers: {
            'x-api-key': DATA_SERVICE_API_KEY,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
      return { ok: true, data: response.data };
    } catch (err) {
      logger.warn(`[DataServiceProxy] Failed to reset data-service CBs: ${err.message}`, 'data-service');
      return { ok: false, error: err.message };
    }
  },

  // v1 historical endpoints
  getHistoricalRegime: (symbol, tf = '1d', lookback = 252) =>
    v1Get(`/historical/${symbol.toUpperCase()}/regime`, { tf, lookback }),
  getHistoricalMetrics: (symbol, tf = '1d', lookback = 252) =>
    v1Get(`/historical/${symbol.toUpperCase()}/metrics`, { tf, lookback }),
  getHistoricalCandles: (symbol, tf, start, end) =>
    v1Get(`/historical/${symbol.toUpperCase()}/candles`, { tf, start, end }),
  getHistoricalIV: (symbol) =>
    v1Get(`/historical/${symbol.toUpperCase()}/iv`),
};

// Start connectivity gate probe when using remote data-service
const isRemoteDataService = DATA_SERVICE_URL && !DATA_SERVICE_URL.includes('localhost');
if (isRemoteDataService) {
  connectivityGate.onRecovery(async () => {
    const dsReset = await module.exports.resetDataServiceCircuitBreakers();
    if (dsReset.ok) {
      logger.info('[ConnectivityGate] Data-service provider CBs reset', 'connectivity-gate');
    }
  });
  connectivityGate.startProbe(() => module.exports.probeHealth());
}
