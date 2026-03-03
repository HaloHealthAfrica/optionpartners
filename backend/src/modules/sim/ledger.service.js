'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');

class LedgerService {
  /**
   * Get or initialize the sim account state for a user
   */
  async getAccountState(userId) {
    let result = await db.query(
      'SELECT * FROM sim_account_state WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      const initialBalance = parseFloat(process.env.SIM_INITIAL_BALANCE || '100000');
      result = await db.query(
        `INSERT INTO sim_account_state (user_id, cash_balance, buying_power, equity, peak_equity)
         VALUES ($1, $2, $2, $2, $2)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING *`,
        [userId, initialBalance]
      );
      if (result.rows.length === 0) {
        result = await db.query('SELECT * FROM sim_account_state WHERE user_id = $1', [userId]);
      }
    }

    return result.rows[0];
  }

  /**
   * Reset sim account to initial state
   */
  async resetAccount(userId) {
    const initialBalance = parseFloat(process.env.SIM_INITIAL_BALANCE || '100000');
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      // Close all open positions
      await client.query(
        `UPDATE sim_positions SET status = 'CLOSED', closed_at = NOW() WHERE user_id = $1 AND status = 'OPEN'`,
        [userId]
      );

      // Reset account state
      await client.query(
        `UPDATE sim_account_state
         SET cash_balance = $2, buying_power = $2, margin_used = 0,
             equity = $2, unrealized_pnl = 0, realized_pnl = 0,
             peak_equity = $2, max_drawdown = 0, daily_pnl = 0,
             daily_pnl_reset_at = CURRENT_DATE,
             kill_switch_active = FALSE, updated_at = NOW()
         WHERE user_id = $1`,
        [userId, initialBalance]
      );

      await client.query('COMMIT');
      logger.info(`Sim account reset for user ${userId}`, 'sim-ledger');
    } catch (error) {
      await client.query('ROLLBACK');
      Sentry.captureException(error, { tags: { module: 'sim-ledger' } });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get all open positions for a user
   */
  async getOpenPositions(userId) {
    const result = await db.query(
      `SELECT * FROM sim_positions WHERE user_id = $1 AND status = 'OPEN' ORDER BY opened_at DESC`,
      [userId]
    );
    return result.rows;
  }

  /**
   * Get all positions with pagination
   */
  async getPositions(userId, { status, page = 1, limit = 25 } = {}) {
    const conditions = ['user_id = $1'];
    const params = [userId];
    let idx = 2;

    if (status) {
      conditions.push(`status = $${idx++}`);
      params.push(status);
    }

    const where = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT * FROM sim_positions WHERE ${where} ORDER BY opened_at DESC LIMIT $${idx++} OFFSET $${idx}`,
        [...params, limit, offset]
      ),
      db.query(`SELECT COUNT(*) as total FROM sim_positions WHERE ${where}`, params),
    ]);

    return {
      positions: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
      page,
      limit,
    };
  }

  /**
   * Get orders with pagination
   */
  async getOrders(userId, { status, page = 1, limit = 25 } = {}) {
    const conditions = ['o.user_id = $1'];
    const params = [userId];
    let idx = 2;

    if (status) {
      conditions.push(`o.status = $${idx++}`);
      params.push(status);
    }

    const where = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT o.*, f.fill_price, f.commission
         FROM sim_orders o
         LEFT JOIN sim_fills f ON f.order_id = o.id
         WHERE ${where}
         ORDER BY o.created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
        [...params, limit, offset]
      ),
      db.query(`SELECT COUNT(*) as total FROM sim_orders o WHERE ${where}`, params),
    ]);

    return {
      orders: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
      page,
      limit,
    };
  }

  /**
   * Take an equity snapshot for curve visualization
   */
  async takeEquitySnapshot(userId, simRunId = null) {
    const account = await this.getAccountState(userId);
    const openCount = await db.query(
      `SELECT COUNT(*) as count FROM sim_positions WHERE user_id = $1 AND status = 'OPEN'`,
      [userId]
    );

    await db.query(
      `INSERT INTO sim_equity_snapshots (user_id, sim_run_id, equity, cash_balance, unrealized_pnl, realized_pnl, open_positions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, simRunId, account.equity, account.cash_balance,
       account.unrealized_pnl, account.realized_pnl,
       parseInt(openCount.rows[0].count, 10)]
    );
  }

  /**
   * Get equity curve data
   */
  async getEquityCurve(userId, { simRunId, startDate, endDate, limit = 500 } = {}) {
    const conditions = ['user_id = $1'];
    const params = [userId];
    let idx = 2;

    if (simRunId) {
      conditions.push(`sim_run_id = $${idx++}`);
      params.push(simRunId);
    }
    if (startDate) {
      conditions.push(`snapshot_at >= $${idx++}`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`snapshot_at <= $${idx++}`);
      params.push(endDate);
    }

    const where = conditions.join(' AND ');

    const result = await db.query(
      `SELECT * FROM sim_equity_snapshots WHERE ${where} ORDER BY snapshot_at ASC LIMIT $${idx}`,
      [...params, limit]
    );

    return result.rows;
  }
}

module.exports = new LedgerService();
