const axios = require('axios');
const logger = require('../utils/logger');
const Sentry = require('@sentry/node');

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

/**
 * Simple circuit breaker to avoid hammering a down data-service.
 * CLOSED  → requests flow normally
 * OPEN    → requests fail fast for `resetTimeout` ms
 * HALF_OPEN → one probe request; success resets, failure re-opens
 */
const circuitBreaker = {
  state: 'CLOSED',
  failures: 0,
  threshold: parseInt(process.env.DATA_SERVICE_CB_THRESHOLD || '5', 10),
  resetTimeout: parseInt(process.env.DATA_SERVICE_CB_RESET_MS || '30000', 10),
  lastFailure: 0,

  recordSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  },

  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
      logger.warn(`[CircuitBreaker] OPEN — data-service unreachable after ${this.failures} failures. Retrying in ${this.resetTimeout / 1000}s`, 'data-service');
    }
  },

  canRequest() {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN' && Date.now() - this.lastFailure >= this.resetTimeout) {
      this.state = 'HALF_OPEN';
      return true;
    }
    return this.state === 'HALF_OPEN';
  },
};

async function proxyGet(path, params = {}) {
  if (!circuitBreaker.canRequest()) {
    const error = new Error('Data service circuit breaker OPEN — failing fast');
    error.status = 503;
    throw error;
  }
  try {
    const response = await client.get(path, { params });
    circuitBreaker.recordSuccess();
    return response.data;
  } catch (err) {
    circuitBreaker.recordFailure();
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
  if (!circuitBreaker.canRequest()) {
    const error = new Error('Data service circuit breaker OPEN — failing fast');
    error.status = 503;
    throw error;
  }
  try {
    const response = await v1Client.get(path, { params });
    circuitBreaker.recordSuccess();
    return response.data;
  } catch (err) {
    circuitBreaker.recordFailure();
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
