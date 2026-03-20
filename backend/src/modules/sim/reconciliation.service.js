'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');

/**
 * Service responsible for verifying that simulated trades match the
 * signals the system received and approved.  It is intentionally
 * lightweight and non-blocking; failures are logged but not thrown.
 */
class ReconciliationService {
  constructor() {
    // nothing to initialize yet
  }

  /**
   * Find webhook events that were approved by the intelligence layer but
   * did not produce any sim_trade record.
   * @returns {Promise<Array>} list of {webhook_event_id, user_id}
   */
  async findOrphanedSignals() {
    try {
      const result = await db.query(
        `SELECT we.id AS webhook_event_id, we.user_id
         FROM webhook_events we
         JOIN intelligence_verdicts iv ON iv.webhook_event_id = we.id
         WHERE iv.allowed = TRUE
           AND we.status = 'PROCESSED'
           AND NOT EXISTS (
             SELECT 1 FROM sim_trades st WHERE st.webhook_event_id = we.id
           )`);
      return result.rows;
    } catch (err) {
      logger.error(`Reconciliation: failed to query orphaned signals: ${err.message}`, 'reconciliation');
      return [];
    }
  }

  /**
   * Find sim_trades that reference a webhook event which no longer exists
   * (should never happen) or trades with missing webhook linkage.
   * @returns {Promise<{missingWebhook:Array, noLink:Array}>}
   */
  async findOrphanedTrades() {
    const out = { missingWebhook: [], noLink: [] };
    try {
      const missing = await db.query(
        `SELECT st.id, st.webhook_event_id, st.user_id
         FROM sim_trades st
         LEFT JOIN webhook_events we ON we.id = st.webhook_event_id
         WHERE st.webhook_event_id IS NOT NULL AND we.id IS NULL`);
      out.missingWebhook = missing.rows;
    } catch (err) {
      logger.error(`Reconciliation: failed to query trades with missing webhook: ${err.message}`, 'reconciliation');
    }

    try {
      const nolink = await db.query(
        `SELECT st.id, st.user_id
         FROM sim_trades st
         WHERE st.webhook_event_id IS NULL`);
      out.noLink = nolink.rows;
    } catch (err) {
      logger.error(`Reconciliation: failed to query trades without webhook link: ${err.message}`, 'reconciliation');
    }

    return out;
  }

  /**
   * Run a full reconciliation.  Logs any anomalies and returns a summary
   * object for programmatic use (e.g. API endpoint).
   */
  async reconcileWebhooksToTrades() {
    const summary = {
      orphanedSignals: [],
      orphanedTrades: { missingWebhook: [], noLink: [] },
    };

    summary.orphanedSignals = await this.findOrphanedSignals();
    if (summary.orphanedSignals.length > 0) {
      logger.warn(
        `[RECONCILIATION] ${summary.orphanedSignals.length} processed webhook(s) had no matching sim_trade`,
        'reconciliation'
      );
      summary.orphanedSignals.forEach(s => {
        logger.warn(`[RECONCILIATION] Orphaned signal:webhook=${s.webhook_event_id} user=${s.user_id}`, 'reconciliation');
      });
    }

    const orphans = await this.findOrphanedTrades();
    summary.orphanedTrades = orphans;

    if (orphans.missingWebhook.length > 0) {
      logger.warn(
        `[RECONCILIATION] ${orphans.missingWebhook.length} sim_trade(s) reference missing webhook_event`,
        'reconciliation'
      );
      orphans.missingWebhook.forEach(t => {
        logger.warn(`[RECONCILIATION] Orphaned trade=${t.id} webhook=${t.webhook_event_id} user=${t.user_id}`, 'reconciliation');
      });
    }
    if (orphans.noLink.length > 0) {
      logger.warn(
        `[RECONCILIATION] ${orphans.noLink.length} sim_trade(s) have no webhook_event_id set`,
        'reconciliation'
      );
      orphans.noLink.forEach(t => {
        logger.warn(`[RECONCILIATION] Unlinked trade=${t.id} user=${t.user_id}`, 'reconciliation');
      });
    }

    return summary;
  }
}

module.exports = new ReconciliationService();