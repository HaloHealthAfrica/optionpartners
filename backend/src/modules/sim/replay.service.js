'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const decisionRouter = require('./decision-router');
const executor = require('./executor');
const tradeFinalizer = require('./trade-finalizer');
const ledgerService = require('./ledger.service');
const { assertSimMode } = require('../../config/tradingMode');

/**
 * Historical replay engine.
 * Replays candles sequentially, feeds them into the decision router,
 * and executes through the sim executor. Fully deterministic.
 */
class ReplayService {
  /**
   * Start a new replay run.
   * @param {string} userId
   * @param {Object} params
   * @param {string} params.symbol
   * @param {string} params.timeframe - e.g. '5m', '15m', '1h', '1D'
   * @param {string} params.startDate - ISO date
   * @param {string} params.endDate - ISO date
   * @param {string} params.strategy
   * @param {Object} params.config - Strategy configuration snapshot
   * @returns {Promise<Object>} The sim_run record
   */
  async startReplay(userId, { symbol, timeframe, startDate, endDate, strategy, config }) {
    assertSimMode();

    const runId = uuidv4();

    // Create the run record
    const result = await db.query(
      `INSERT INTO sim_runs (id, user_id, symbol, strategy, timeframe, start_date, end_date, config_snapshot, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RUNNING')
       RETURNING *`,
      [runId, userId, symbol.toUpperCase(), strategy, timeframe, startDate, endDate, JSON.stringify(config)]
    );

    const run = result.rows[0];

    // Execute replay asynchronously
    this._executeReplay(run, userId).catch(err => {
      logger.error(`Replay ${runId} failed: ${err.message}`, 'sim-replay');
    });

    return run;
  }

  /**
   * Execute the replay loop. Processes candles sequentially to maintain determinism.
   */
  async _executeReplay(run, userId) {
    try {
      // Fetch historical candle data
      const candles = await this._fetchHistoricalData(
        run.symbol, run.timeframe, run.start_date, run.end_date
      );

      if (candles.length === 0) {
        await this._markFailed(run.id, 'No historical data available for the specified range');
        return;
      }

      let tradeCount = 0;
      let winCount = 0;
      let totalPnl = 0;

      // Take initial equity snapshot
      await ledgerService.takeEquitySnapshot(userId, run.id);

      // Process each candle sequentially for determinism
      for (const candle of candles) {
        const syntheticPayload = this._candle2Payload(candle, run.symbol, run.strategy);

        try {
          const decision = await decisionRouter.evaluate(syntheticPayload, null, userId);

          if (decision.approved && decision.orderIntent) {
            // Add price data from candle
            decision.orderIntent.bidPrice = candle.low;
            decision.orderIntent.askPrice = candle.high;
            decision.orderIntent.midPrice = (candle.open + candle.close) / 2;

            const { order, fill, position } = await executor.simulateOrder(
              decision.orderIntent, userId
            );

            if (position && position.status === 'CLOSED' && fill) {
              const trade = await tradeFinalizer.finalize(
                position, parseFloat(fill.fill_price), userId
              );
              tradeCount++;
              const pnl = parseFloat(trade.pnl);
              totalPnl += pnl;
              if (pnl > 0) winCount++;
            } else if (order.status === 'FILLED') {
              tradeCount++;
            }
          }
        } catch (err) {
          logger.warn(`Replay candle error: ${err.message}`, 'sim-replay');
        }

        // Snapshot equity periodically (every 10 candles)
        if (tradeCount % 10 === 0) {
          await ledgerService.takeEquitySnapshot(userId, run.id);
        }
      }

      // Final equity snapshot
      await ledgerService.takeEquitySnapshot(userId, run.id);

      // Get final account state for summary
      const account = await ledgerService.getAccountState(userId);

      const losingTrades = tradeCount - winCount;
      const winRate = tradeCount > 0 ? winCount / tradeCount : 0;

      await db.query(
        `UPDATE sim_runs
         SET status = 'COMPLETED',
             total_trades = $2,
             winning_trades = $3,
             losing_trades = $4,
             total_pnl = $5,
             win_rate = $6,
             max_drawdown = $7,
             completed_at = NOW()
         WHERE id = $1`,
        [run.id, tradeCount, winCount, losingTrades,
         totalPnl, winRate, account.max_drawdown]
      );

      logger.info(
        `Replay completed: ${run.id} trades=${tradeCount} pnl=$${totalPnl.toFixed(2)} winRate=${(winRate * 100).toFixed(1)}%`,
        'sim-replay'
      );
    } catch (error) {
      await this._markFailed(run.id, error.message);
      throw error;
    }
  }

  /**
   * Convert a candle to a synthetic webhook payload for the decision router.
   * This enables the same pipeline for live and replay modes.
   */
  _candle2Payload(candle, symbol, strategy) {
    const bullish = candle.close > candle.open;
    return {
      ticker: symbol,
      action: bullish ? 'buy' : 'sell',
      strategy: strategy,
      contract_type: 'STOCK',
      quantity: 1,
      bid: candle.low,
      ask: candle.high,
      mid: (candle.open + candle.close) / 2,
      time: candle.timestamp || candle.time || new Date().toISOString(),
      volume: candle.volume,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    };
  }

  /**
   * Fetch historical candle data. Uses the sim_historical_prices table
   * or falls back to a stub for development.
   */
  async _fetchHistoricalData(symbol, timeframe, startDate, endDate) {
    // Try to fetch from historical_prices table if it exists
    try {
      const result = await db.query(
        `SELECT date as timestamp, open, high, low, close, volume
         FROM historical_prices
         WHERE symbol = $1 AND date BETWEEN $2 AND $3
         ORDER BY date ASC`,
        [symbol, startDate, endDate]
      );
      if (result.rows.length > 0) return result.rows;
    } catch (e) {
      // Table might not exist
    }

    // Return empty -- no data available for replay
    logger.warn(
      `No historical data for ${symbol} ${startDate} to ${endDate}. Load data into historical_prices table.`,
      'sim-replay'
    );
    return [];
  }

  async _markFailed(runId, errorMessage) {
    await db.query(
      `UPDATE sim_runs SET status = 'FAILED', error_message = $2, completed_at = NOW() WHERE id = $1`,
      [runId, errorMessage]
    );
  }

  /**
   * Get a single run by ID
   */
  async getRun(runId, userId) {
    const result = await db.query(
      'SELECT * FROM sim_runs WHERE id = $1 AND user_id = $2',
      [runId, userId]
    );
    return result.rows[0] || null;
  }
}

module.exports = new ReplayService();
