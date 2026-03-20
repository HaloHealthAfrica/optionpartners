'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const webhookService = require('../webhooks/webhook.service');
const decisionRouter = require('./decision-router');
const executor = require('./executor');
const tradeFinalizer = require('./trade-finalizer');
const ledgerService = require('./ledger.service');
const dataServiceProxy = require('../../services/dataServiceProxy');
const { assertSimMode } = require('../../config/tradingMode');
const Sentry = require('@sentry/node');

const TRADE_TRIGGERS = new Set(['SIGNALS', 'STRAT', 'ORB', 'PIVOT_MB', 'SQUEEZE_PRO', 'REVERSAL', 'CRT']);
const BACKTEST_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const BACKTEST_PROGRESS_INTERVAL = 50; // update DB every N webhooks

/**
 * Webhook Backtest Service.
 * Replays historical webhooks through the decision pipeline with historical fill prices.
 */
class BacktestService {
  /**
   * Start a webhook backtest run.
   * @param {string} userId
   * @param {Object} params
   * @param {string} params.startDate - YYYY-MM-DD
   * @param {string} params.endDate - YYYY-MM-DD
   * @param {string[]} [params.indicatorSources] - STRAT, SIGNALS, REVERSAL, etc.
   * @param {string[]} [params.strategies] - reversal_strat, squeeze_pro, etc.
   * @param {Object} [params.config] - { bypassStrategyGate }
   * @returns {Promise<Object>} backtest_run record
   */
  async startBacktest(userId, { startDate, endDate, indicatorSources, strategies, config = {} }) {
    assertSimMode();

    const runId = uuidv4();
    const result = await db.query(
      `INSERT INTO backtest_runs (
        id, user_id, start_date, end_date, indicator_sources, strategies, config_snapshot, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'RUNNING')
      RETURNING *`,
      [
        runId,
        userId,
        startDate,
        endDate,
        indicatorSources || null,
        strategies || null,
        JSON.stringify(config),
      ]
    );

    const run = result.rows[0];
    this._executeBacktest(run, userId).catch((err) => {
      logger.error(`Backtest ${runId} failed: ${err.message}`, 'backtest');
      Sentry.captureException(err, { tags: { module: 'backtest' } });
    });

    return run;
  }

  async _executeBacktest(run, userId) {
    const preState = await this._snapshotAccountState(userId);
    let webhooks = [];
    const ctx = { aborted: false, processedCount: 0 };
    const timeoutId = setTimeout(() => {
      ctx.aborted = true;
      this._markFailed(run.id, 'Backtest timed out (15 min limit). Try a shorter date range or fewer webhooks.', ctx.processedCount).catch((e) =>
        logger.error(`Failed to mark backtest timed out: ${e.message}`, 'backtest')
      );
    }, BACKTEST_TIMEOUT_MS);

    try {
      await ledgerService.resetAccount(userId);

      webhooks = await webhookService.getByDateRange(userId, run.start_date, run.end_date, {
        indicatorSources: run.indicator_sources,
        strategies: run.strategies,
        limit: 5000,
      });

      if (webhooks.length === 0) {
        clearTimeout(timeoutId);
        await this._restoreAccountState(userId, preState);
        await this._markFailed(
          run.id,
          'No webhooks found for the specified date range and filters. Use "Check webhooks" before running to verify data exists, or broaden your date range and filters.'
        );
        return;
      }

      const symbols = [...new Set(webhooks.map((w) => {
        const p = typeof w.raw_payload === 'string' ? JSON.parse(w.raw_payload) : w.raw_payload;
        return (p.ticker || p.symbol || p.meta?.ticker || p.meta?.symbol || '').toUpperCase();
      }).filter(Boolean))];

      const priceMap = await this._buildHistoricalPriceMap(symbols, run.start_date, run.end_date);
      if (ctx.aborted) return;

      const byStrategy = {};
      let totalTrades = 0;
      let winningTrades = 0;
      let totalPnl = 0;

      const backtestOpts = (run.config_snapshot && typeof run.config_snapshot === 'object')
        ? run.config_snapshot
        : (run.config_snapshot ? JSON.parse(run.config_snapshot) : {});
      const bypassGuards = backtestOpts.bypassGuards !== false;

      for (let i = 0; i < webhooks.length; i++) {
        if (ctx.aborted) break;
        ctx.processedCount = i + 1;
        if ((i + 1) % BACKTEST_PROGRESS_INTERVAL === 0) {
          await db.query(
            'UPDATE backtest_runs SET webhooks_processed = $2 WHERE id = $1',
            [run.id, i + 1]
          );
        }
        const event = webhooks[i];
        try {
          const payload = typeof event.raw_payload === 'string'
            ? JSON.parse(event.raw_payload)
            : event.raw_payload;

          const symbol = (payload.ticker || payload.symbol || payload.meta?.ticker || payload.meta?.symbol || '').toUpperCase();
          if (!symbol) continue;

          const decision = await decisionRouter.evaluate(payload, event.id, userId, { bypassGuards });

          if (decision.contextUpdateOnly) continue;

          if (!decision.approved || !decision.orderIntent) continue;

          const intents = decision.orderIntents || [decision.orderIntent];
          const receivedAt = new Date(event.received_at).getTime();

          for (const intent of intents) {
            this._injectHistoricalPrices(intent, symbol, receivedAt, priceMap, payload);

            try {
              const { order, fill, position } = await executor.simulateOrder(intent, userId);

              if (order.status === 'REJECTED') continue;

              if (position && position.status === 'CLOSED' && fill) {
                const trade = await tradeFinalizer.finalize(
                  position,
                  parseFloat(fill.fill_price),
                  userId,
                  { backtestRunId: run.id }
                );

                const strat = trade.strategy || 'UNKNOWN';
                if (!byStrategy[strat]) {
                  byStrategy[strat] = { trades: 0, wins: 0, pnl: 0 };
                }
                byStrategy[strat].trades++;
                byStrategy[strat].pnl += parseFloat(trade.pnl);
                if (parseFloat(trade.pnl) > 0) byStrategy[strat].wins++;

                totalTrades++;
                totalPnl += parseFloat(trade.pnl);
                if (parseFloat(trade.pnl) > 0) winningTrades++;
              }
            } catch (err) {
              logger.warn(`Backtest execution error for ${event.id}: ${err.message}`, 'backtest');
            }
          }
        } catch (err) {
          logger.warn(`Backtest decision error for ${event.id}: ${err.message}`, 'backtest');
        }
      }

      const account = await ledgerService.getAccountState(userId);
      const losingTrades = totalTrades - winningTrades;
      const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

      const grossWins = Object.values(byStrategy).reduce((s, v) => s + (v.pnl > 0 ? v.pnl : 0), 0);
      const grossLosses = Math.abs(Object.values(byStrategy).reduce((s, v) => s + (v.pnl < 0 ? v.pnl : 0), 0));
      const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 999 : 0);

      if (ctx.aborted) return;

      const byStrategyArray = Object.entries(byStrategy).map(([strategy, data]) => ({
        strategy,
        trades: data.trades,
        wins: data.wins,
        pnl: data.pnl,
        win_rate: data.trades > 0 ? data.wins / data.trades : 0,
      }));

      await db.query(
        `UPDATE backtest_runs SET
          status = 'COMPLETED',
          total_trades = $2,
          winning_trades = $3,
          losing_trades = $4,
          total_pnl = $5,
          win_rate = $6,
          profit_factor = $7,
          max_drawdown = $8,
          by_strategy = $9,
          webhooks_processed = $10,
          completed_at = NOW()
        WHERE id = $1`,
        [
          run.id,
          totalTrades,
          winningTrades,
          losingTrades,
          totalPnl,
          winRate,
          profitFactor,
          account.max_drawdown,
          JSON.stringify(byStrategyArray),
          webhooks.length,
        ]
      );

      logger.info(
        `Backtest completed: ${run.id} webhooks=${webhooks.length} trades=${totalTrades} pnl=$${totalPnl.toFixed(2)} WR=${(winRate * 100).toFixed(1)}%`,
        'backtest'
      );
    } catch (error) {
      clearTimeout(timeoutId);
      await this._markFailed(run.id, error.message, ctx.processedCount || webhooks.length);
      throw error;
    } finally {
      clearTimeout(timeoutId);
      await this._restoreAccountState(userId, preState);
    }
  }

  _injectHistoricalPrices(intent, symbol, timestampMs, priceMap, payload = null) {
    const bucket = Math.floor(timestampMs / 300000) * 300000;
    const key = `${symbol}:${bucket}`;
    const candle = priceMap[key];
    if (candle) {
      intent.bidPrice = candle.low;
      intent.askPrice = candle.high;
      intent.midPrice = (candle.open + candle.close) / 2;
      return;
    }
    // Fallback: use prices from payload when historical candles unavailable (data-service down, etc.)
    if (!intent.bidPrice && !intent.askPrice && !intent.midPrice && payload) {
      const bid = parseFloat(payload.bid ?? payload.entry?.bid ?? payload.meta?.bid);
      const ask = parseFloat(payload.ask ?? payload.entry?.ask ?? payload.meta?.ask);
      const mid = parseFloat(payload.mid ?? payload.entry?.price ?? payload.meta?.price ?? payload.current_price ?? payload.price);
      if (bid && ask) {
        intent.bidPrice = bid;
        intent.askPrice = ask;
        intent.midPrice = (bid + ask) / 2;
      } else if (mid) {
        intent.midPrice = mid;
        intent.bidPrice = mid * 0.99;
        intent.askPrice = mid * 1.01;
      }
    }
  }

  async _buildHistoricalPriceMap(symbols, startDate, endDate) {
    const map = {};
    const tf = '5m';

    for (const symbol of symbols) {
      try {
        const res = await dataServiceProxy.getHistoricalCandles(symbol, tf, startDate, endDate);
        const candles = res?.candles || [];
        for (const c of candles) {
          const ts = c.t ?? c.ts;
          const bucket = Math.floor(ts / 300000) * 300000;
          const key = `${symbol}:${bucket}`;
          if (!map[key]) {
            map[key] = { open: c.o, high: c.h, low: c.l, close: c.c };
          }
        }
      } catch (err) {
        logger.warn(`Historical candles fetch failed for ${symbol}: ${err.message}`, 'backtest');
      }
    }

    return map;
  }

  async _snapshotAccountState(userId) {
    const result = await db.query(
      'SELECT * FROM sim_account_state WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || null;
  }

  async _restoreAccountState(userId, snapshot) {
    if (!snapshot) return;
    try {
      await db.query(
        `DELETE FROM sim_positions WHERE user_id = $1 AND status = 'OPEN'`,
        [userId]
      );
      await db.query(
        `UPDATE sim_account_state
         SET cash_balance = $2, buying_power = $3, margin_used = $4,
             equity = $5, unrealized_pnl = $6, realized_pnl = $7,
             peak_equity = $8, max_drawdown = $9, daily_pnl = $10,
             daily_pnl_reset_at = $11, kill_switch_active = $12, updated_at = NOW()
         WHERE user_id = $1`,
        [
          userId,
          snapshot.cash_balance,
          snapshot.buying_power,
          snapshot.margin_used,
          snapshot.equity,
          snapshot.unrealized_pnl,
          snapshot.realized_pnl,
          snapshot.peak_equity,
          snapshot.max_drawdown,
          snapshot.daily_pnl,
          snapshot.daily_pnl_reset_at,
          snapshot.kill_switch_active,
        ]
      );
      logger.info(`Restored pre-backtest account state for user ${userId}`, 'backtest');
    } catch (err) {
      logger.error(`Failed to restore pre-backtest state: ${err.message}`, 'backtest');
      Sentry.captureException(err, { tags: { module: 'backtest' } });
    }
  }

  async _markFailed(runId, errorMessage, webhooksProcessed = 0) {
    await db.query(
      `UPDATE backtest_runs SET status = 'FAILED', error_message = $2, webhooks_processed = $3, completed_at = NOW() WHERE id = $1`,
      [runId, errorMessage, webhooksProcessed]
    );
  }

  async getRun(runId, userId) {
    const result = await db.query(
      'SELECT * FROM backtest_runs WHERE id = $1 AND user_id = $2',
      [runId, userId]
    );
    return result.rows[0] || null;
  }

  async listRuns(userId, { page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;
    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT * FROM backtest_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      db.query(
        'SELECT COUNT(*) as total FROM backtest_runs WHERE user_id = $1',
        [userId]
      ),
    ]);
    return {
      runs: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
      page,
      limit,
    };
  }

  async getStrategies(userId) {
    try {
      const result = await db.query(
        `SELECT DISTINCT strategy FROM strategy_trade_recipe WHERE (user_id = $1 OR user_id IS NULL) AND is_active = TRUE
         UNION
         SELECT DISTINCT strategy FROM sim_trades WHERE user_id = $1 AND strategy IS NOT NULL AND (backtest_run_id IS NULL)
         ORDER BY strategy`,
        [userId]
      );
      return result.rows.map((r) => r.strategy).filter(Boolean);
    } catch (err) {
      if (err.message && err.message.includes('backtest_run_id')) {
        logger.warn('backtest_run_id column missing, using fallback query', 'backtest');
        const result = await db.query(
          `SELECT DISTINCT strategy FROM strategy_trade_recipe WHERE (user_id = $1 OR user_id IS NULL) AND is_active = TRUE
           UNION
           SELECT DISTINCT strategy FROM sim_trades WHERE user_id = $1 AND strategy IS NOT NULL
           ORDER BY strategy`,
          [userId]
        );
        return result.rows.map((r) => r.strategy).filter(Boolean);
      }
      throw err;
    }
  }
}

module.exports = new BacktestService();
