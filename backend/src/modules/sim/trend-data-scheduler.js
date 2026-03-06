'use strict';

const db = require('../../config/database');
const dataServiceProxy = require('../../services/dataServiceProxy');
const symbolStateService = require('./symbol-state.service');
const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');

const TREND_POLL_INTERVAL_MS = parseInt(process.env.TREND_POLL_INTERVAL_MS || '600000', 10); // 10 min
const EMA_FAST = parseInt(process.env.TREND_EMA_FAST || '9', 10);
const EMA_SLOW = parseInt(process.env.TREND_EMA_SLOW || '21', 10);

const POLL_TIMEFRAMES = [
  { apiTf: '5min',  key: '5m',  candleLimit: 50 },
  { apiTf: '15min', key: '15m', candleLimit: 50 },
  { apiTf: '1h',    key: '1h',  candleLimit: 50 },
  { apiTf: '4h',    key: '4h',  candleLimit: 50 },
];

const INTER_SYMBOL_DELAY_MS = 500;

// ── Helpers ──────────────────────────────────────────────────────────

function getETInfo() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return {
    day: et.getDay(),
    mins: et.getHours() * 60 + et.getMinutes(),
    dateStr: et.toISOString().slice(0, 10),
  };
}

function isWeekday() { return ![0, 6].includes(getETInfo().day); }

function isRTH() {
  const { day, mins } = getETInfo();
  if (day === 0 || day === 6) return false;
  return mins >= 570 && mins <= 960;
}

function isPreMarketResetWindow() {
  const { day, mins } = getETInfo();
  if (day === 0 || day === 6) return false;
  return mins >= 555 && mins < 570; // 9:15–9:30 ET
}

function computeEMA(prices, period) {
  if (!prices.length) return null;
  if (prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── Scheduler ────────────────────────────────────────────────────────

class TrendDataScheduler {
  constructor() {
    this._timer = null;
    this._lastResetDate = null;
    this._running = false;
  }

  start(intervalMs = TREND_POLL_INTERVAL_MS) {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), intervalMs);
    logger.info(`[TREND_SCHEDULER] Started (interval=${intervalMs / 1000}s)`, 'trend-scheduler');
    this._tick();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    logger.info('[TREND_SCHEDULER] Stopped', 'trend-scheduler');
  }

  async _tick() {
    if (this._running) return;
    this._running = true;
    try {
      await this._checkDailyReset();
      if (isRTH()) {
        await this._pollTrendData();
      }
    } catch (err) {
      logger.error(`[TREND_SCHEDULER] Tick error: ${err.message}`, 'trend-scheduler');
      Sentry.captureException(err, { tags: { module: 'trend-scheduler' } });
    } finally {
      this._running = false;
    }
  }

  // ── Daily reset ────────────────────────────────────────────────────
  //
  // Clears local_updated_at (trend freshness timestamp) for every
  // symbol_state row once per trading day, either during the pre-market
  // window (9:15–9:30 ET) or on the first RTH tick.  This forces the
  // trade-decision-engine to treat yesterday's trend data as unknown
  // rather than stale, avoiding false "severely stale" blocks on
  // legitimate early-morning signals.

  async _checkDailyReset() {
    if (!isWeekday()) return;
    const { dateStr } = getETInfo();
    if (this._lastResetDate === dateStr) return;
    if (isPreMarketResetWindow() || isRTH()) {
      await this._resetTrendData();
      this._lastResetDate = dateStr;
    }
  }

  async _resetTrendData() {
    try {
      const result = await db.query(
        `UPDATE symbol_state
         SET local_updated_at = NULL,
             local_bias = 'NEUTRAL',
             local_strength = 0,
             alignment_score = 0,
             conflict_score = 0,
             updated_at = NOW()
         WHERE local_updated_at IS NOT NULL`
      );

      symbolStateService._cache.clear();

      logger.info(
        `[TREND_SCHEDULER] Daily reset — ${result.rowCount} symbol states cleared`,
        'trend-scheduler'
      );
    } catch (err) {
      logger.error(`[TREND_SCHEDULER] Reset failed: ${err.message}`, 'trend-scheduler');
      Sentry.captureException(err, { tags: { module: 'trend-scheduler' } });
    }
  }

  // ── Active trend polling ───────────────────────────────────────────
  //
  // Fetches candles for every symbol in global_market_state across
  // multiple timeframes, computes fast / slow EMA to derive a
  // per-timeframe trend direction, then feeds the result through
  // symbolStateService.update('TREND', …) for every user that has
  // existing symbol_state entries.

  async _pollTrendData() {
    const symbolResult = await db.query(
      'SELECT symbol FROM global_market_state ORDER BY symbol'
    );
    const symbols = symbolResult.rows.map(r => r.symbol);
    if (symbols.length === 0) return;

    const userIds = await this._getTargetUserIds();
    if (userIds.length === 0) return;

    let updated = 0;
    let errors = 0;

    for (const symbol of symbols) {
      try {
        const trendPayload = await this._computeTrend(symbol);
        if (!trendPayload) continue;

        for (const userId of userIds) {
          await symbolStateService.update('TREND', trendPayload, userId, symbol);
        }
        updated++;
      } catch (err) {
        errors++;
        logger.error(`[TREND_SCHEDULER] ${symbol} poll failed: ${err.message}`, 'trend-scheduler');
      }

      await new Promise(r => setTimeout(r, INTER_SYMBOL_DELAY_MS));
    }

    logger.info(
      `[TREND_SCHEDULER] Poll complete: ${updated}/${symbols.length} updated, ${errors} errors`,
      'trend-scheduler'
    );
  }

  async _getTargetUserIds() {
    const result = await db.query('SELECT DISTINCT user_id FROM symbol_state');
    const ids = result.rows.map(r => r.user_id);
    if (ids.length > 0) return ids;
    const fallback = process.env.SIM_DEFAULT_USER_ID;
    return fallback ? [fallback] : [];
  }

  // ── EMA-based trend computation ────────────────────────────────────

  async _computeTrend(symbol) {
    const timeframes = {};
    let latestPrice = null;
    let bullish = 0;
    let bearish = 0;
    let totalTf = 0;

    for (const tf of POLL_TIMEFRAMES) {
      try {
        const resp = await dataServiceProxy.getCandles(symbol, tf.apiTf, tf.candleLimit);
        const candles = resp?.data || [];

        if (!Array.isArray(candles) || candles.length < EMA_SLOW) continue;

        const closes = candles.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
        if (closes.length < EMA_SLOW) continue;

        const fastEma = computeEMA(closes, EMA_FAST);
        const slowEma = computeEMA(closes, EMA_SLOW);

        if (tf.key === '5m') {
          latestPrice = closes[closes.length - 1];
        }

        const dir = fastEma > slowEma ? 'bullish' : 'bearish';
        timeframes[tf.key] = { dir, chg: false };
        totalTf++;
        if (dir === 'bullish') bullish++;
        else bearish++;
      } catch {
        // timeframe unavailable — skip
      }
    }

    if (totalTf === 0) return null;

    return {
      ticker: symbol,
      bias: bullish > bearish ? 'bullish' : bearish > bullish ? 'bearish' : 'neutral',
      timeframes,
      price: latestPrice,
      alignment_score: Math.round((Math.max(bullish, bearish) / totalTf) * 100),
      _source: 'trend_poller',
    };
  }
}

module.exports = new TrendDataScheduler();
module.exports.TrendDataScheduler = TrendDataScheduler;
