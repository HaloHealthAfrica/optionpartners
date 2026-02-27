const axios = require('axios');
const logger = require('../utils/logger');

const DATA_SERVICE_URL = process.env.DATA_SERVICE_URL || 'http://localhost:4000';
const DATA_SERVICE_API_KEY = process.env.DATA_SERVICE_API_KEY || 'dev-key';

const client = axios.create({
  baseURL: DATA_SERVICE_URL.replace(/\/$/, '') + '/api',
  timeout: 15000,
  headers: {
    'x-api-key': DATA_SERVICE_API_KEY,
    'Content-Type': 'application/json',
  },
});

async function proxyGet(path, params = {}) {
  try {
    const response = await client.get(path, { params });
    return response.data;
  } catch (err) {
    const status = err.response?.status || 502;
    const message = err.response?.data?.error || err.message;
    logger.error(`[DataServiceProxy] ${path} failed: ${message}`, 'data-service');
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
  getMacro: () => proxyGet('/macro'),
  getHealth: () => proxyGet('/health'),
};
