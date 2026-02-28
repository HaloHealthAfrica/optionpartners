'use strict';

const db = require('../../../config/database');
const logger = require('../../../utils/logger');

class CalibrationStoreService {
  /**
   * Get the active calibrated weights for a user.
   * Returns a Map<componentKey, calibratedWeight> or null if none applied.
   */
  async getActiveWeights(userId) {
    const { rows } = await db.query(
      `SELECT component_key, calibrated_weight, static_weight, weight_drift,
              sample_size, win_rate_lift, calibrated_at
       FROM calibration_weights
       WHERE user_id = $1 AND is_active = true
       ORDER BY component_key`,
      [userId]
    );

    if (rows.length === 0) return null;
    return rows;
  }

  /**
   * Get active weights as a lookup map for the conviction engine.
   */
  async getWeightMap(userId) {
    const rows = await this.getActiveWeights(userId);
    if (!rows) return null;

    const map = new Map();
    for (const row of rows) {
      map.set(row.component_key, row.calibrated_weight);
    }
    return map;
  }

  /**
   * Apply calibration results — upsert all component weights and log the change.
   */
  async applyCalibration(userId, components, triggerType = 'MANUAL') {
    const currentWeights = await this.getActiveWeights(userId);
    const weightsBefore = currentWeights
      ? Object.fromEntries(currentWeights.map(w => [w.component_key, w.calibrated_weight]))
      : {};

    const weightsAfter = {};
    let appliedCount = 0;

    for (const comp of components) {
      if (!comp.significant) continue;

      await db.query(
        `INSERT INTO calibration_weights
           (user_id, component_key, static_weight, calibrated_weight, weight_drift,
            sample_size, win_rate_lift, calibrated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (user_id, component_key) DO UPDATE SET
           calibrated_weight = $4,
           weight_drift = $5,
           sample_size = $6,
           win_rate_lift = $7,
           calibrated_at = NOW(),
           is_active = true`,
        [
          userId,
          comp.key,
          comp.staticWeight,
          comp.recommendedWeight,
          comp.weightDrift,
          comp.present.sampleSize,
          comp.winRateLift,
        ]
      );

      weightsAfter[comp.key] = comp.recommendedWeight;
      appliedCount++;
    }

    const tradeCount = components.length > 0
      ? (components[0].present?.sampleSize || 0) + (components[0].absent?.sampleSize || 0)
      : 0;

    const action = triggerType === 'AUTO' ? 'AUTO_APPLIED' : 'APPLIED';
    const drifts = components.filter(c => c.significant && Math.abs(c.weightDrift) >= 3);
    const summary = `Applied ${appliedCount} weights (${drifts.length} drifts detected) from ${tradeCount} trades`;

    await this._logEvent(userId, action, triggerType, tradeCount, weightsBefore, weightsAfter, summary);

    await db.query(
      `UPDATE sim_intelligence_config
       SET trades_since_last_calibration = 0,
           last_calibration_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );

    logger.info(`[CALIBRATION] ${summary} for user ${userId}`, 'calibration-store');
    return { applied: appliedCount, summary };
  }

  /**
   * Revert to static weights — deactivate all calibrated weights.
   */
  async revertToStatic(userId) {
    const currentWeights = await this.getActiveWeights(userId);
    const weightsBefore = currentWeights
      ? Object.fromEntries(currentWeights.map(w => [w.component_key, w.calibrated_weight]))
      : {};

    await db.query(
      `UPDATE calibration_weights SET is_active = false WHERE user_id = $1`,
      [userId]
    );

    await this._logEvent(userId, 'REVERTED', 'MANUAL', 0, weightsBefore, {}, 'Reverted to static weights');

    logger.info(`[CALIBRATION] Reverted to static weights for user ${userId}`, 'calibration-store');
    return { reverted: true };
  }

  /**
   * Increment the trade counter. Returns the new count and whether threshold is reached.
   */
  async incrementTradeCount(userId) {
    const { rows } = await db.query(
      `UPDATE sim_intelligence_config
       SET trades_since_last_calibration = trades_since_last_calibration + 1
       WHERE user_id = $1
       RETURNING trades_since_last_calibration, calibration_trade_threshold, auto_calibration_enabled`,
      [userId]
    );

    if (rows.length === 0) return { count: 0, thresholdReached: false, autoEnabled: false };

    const row = rows[0];
    return {
      count: row.trades_since_last_calibration,
      threshold: row.calibration_trade_threshold,
      thresholdReached: row.trades_since_last_calibration >= row.calibration_trade_threshold,
      autoEnabled: row.auto_calibration_enabled,
    };
  }

  /**
   * Get calibration status — whether recalibration is due, counts, toggle state.
   */
  async getCalibrationStatus(userId) {
    const { rows } = await db.query(
      `SELECT trades_since_last_calibration, calibration_trade_threshold,
              auto_calibration_enabled, last_calibration_at
       FROM sim_intelligence_config
       WHERE user_id = $1`,
      [userId]
    );

    const activeWeights = await this.getActiveWeights(userId);
    const config = rows[0] || {};

    return {
      tradesSinceLastCalibration: config.trades_since_last_calibration || 0,
      calibrationThreshold: config.calibration_trade_threshold || 25,
      autoCalibrationEnabled: config.auto_calibration_enabled || false,
      lastCalibratedAt: config.last_calibration_at || null,
      recalibrationDue: (config.trades_since_last_calibration || 0) >= (config.calibration_trade_threshold || 25),
      hasActiveWeights: !!activeWeights && activeWeights.length > 0,
      activeWeightCount: activeWeights?.length || 0,
    };
  }

  /**
   * Toggle auto-calibration on/off.
   */
  async toggleAutoCalibration(userId, enabled) {
    await db.query(
      `UPDATE sim_intelligence_config
       SET auto_calibration_enabled = $2
       WHERE user_id = $1`,
      [userId]
    );

    await this._logEvent(
      userId, 'TOGGLED', 'MANUAL', 0, {}, {},
      `Auto-calibration ${enabled ? 'enabled' : 'disabled'}`
    );

    return { autoCalibrationEnabled: enabled };
  }

  /**
   * Update the trade threshold.
   */
  async setThreshold(userId, threshold) {
    const clamped = Math.max(10, Math.min(200, threshold));
    await db.query(
      `UPDATE sim_intelligence_config
       SET calibration_trade_threshold = $2
       WHERE user_id = $1`,
      [userId, clamped]
    );
    return { threshold: clamped };
  }

  /**
   * Get the calibration audit log.
   */
  async getLog(userId, limit = 50) {
    const { rows } = await db.query(
      `SELECT id, action, trigger_type, trade_count,
              weights_before, weights_after, summary, created_at
       FROM calibration_log
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return rows;
  }

  async _logEvent(userId, action, triggerType, tradeCount, weightsBefore, weightsAfter, summary) {
    await db.query(
      `INSERT INTO calibration_log
         (user_id, action, trigger_type, trade_count, weights_before, weights_after, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, action, triggerType, tradeCount,
       JSON.stringify(weightsBefore), JSON.stringify(weightsAfter), summary]
    );
  }
}

module.exports = new CalibrationStoreService();
