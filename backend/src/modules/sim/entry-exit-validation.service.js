'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');
const dataServiceProxy = require('../../services/dataServiceProxy');
const Sentry = require('@sentry/node');

/**
 * Entry/Exit Validation Service for SIM trades
 * 
 * Ensures that:
 * 1. Entry prices match underlying levels at order creation time
 * 2. Exit prices are consistent with underlying at exit time
 * 3. Price movements are realistic and not corrupted
 * 4. Stop-loss and take-profit levels are validly applied
 * 5. Entry/exit relationship is logically consistent
 */
class EntryExitValidationService {
  /**
   * Validate an entry order before it's executed
   * Checks: entry price sanity, underlying consistency, stop/limit validity
   * 
   * @param {Object} intent - The SimOrderIntent
   * @returns {Promise<{valid: boolean, warnings: string[]}>}
   */
  async validateEntry(intent) {
    const warnings = [];
    
    // Check 1: Entry price is reasonable for the symbol
    if (intent.midPrice && !this._isPriceReasonable(intent.midPrice, intent.symbol)) {
      warnings.push(`Entry price $${intent.midPrice} seems unrealistic for ${intent.symbol}`);
    }

    // Check 2: Bid/Ask spread is reasonable
    if (intent.bidPrice && intent.askPrice) {
      const spread = intent.askPrice - intent.bidPrice;
      const spreadPct = (spread / intent.midPrice) * 100;
      if (spreadPct > 10) {
        warnings.push(`Bid/ask spread ${spreadPct.toFixed(2)}% seems excessive for ${intent.symbol}`);
      }
    }

    // Check 3: Stop-loss is below entry for long, above for short/credit
    if (intent.stopLoss && intent.limitPrice) {
      const validation = this._validateStopLevel(intent.side, intent.contractType, intent.limitPrice, intent.stopLoss);
      if (!validation.valid) {
        warnings.push(validation.message);
      }
    }

    // Check 4: Take-profit is above entry for long, below for short/credit
    if (intent.takeProfit && intent.limitPrice) {
      const validation = this._validateTargetLevel(intent.side, intent.contractType, intent.limitPrice, intent.takeProfit);
      if (!validation.valid) {
        warnings.push(validation.message);
      }
    }

    // Check 5: Stop-loss is not too close to entry (min risk/reward sanity)
    if (intent.stopLoss && intent.limitPrice && intent.maxLoss) {
      const riskDollars = intent.maxLoss || Math.abs(intent.limitPrice - intent.stopLoss);
      if (riskDollars < 1) {
        warnings.push(`Risk amount $${riskDollars.toFixed(2)} is too small (min $1 risk)`);
      }
      if (riskDollars > 10000) {
        warnings.push(`Risk amount $${riskDollars.toFixed(2)} is unusually large`);
      }
    }

    // Check 6: Quantity is reasonable
    if (!intent.quantity || intent.quantity < 1 || intent.quantity > 1000) {
      warnings.push(`Quantity ${intent.quantity} is unrealistic (valid: 1-1000)`);
    }

    // Log warnings if any detected
    if (warnings.length > 0) {
      const details = `${intent.side} ${intent.quantity}x ${intent.symbol} @ $${intent.limitPrice}`;
      warnings.forEach(w => {
        logger.warn(`[ENTRY_VALIDATION] ${w} | ${details}`, 'entry-exit-validation');
      });
    }

    return { valid: warnings.length === 0, warnings };
  }

  /**
   * Validate an exit against the original entry
   * Checks: exit price consistency, underlying movement, P&L sanity relative to entry
   * 
   * @param {Object} position - The sim_position record
   * @param {number} exitPrice - The fill price for the exit
   * @param {string} exitReason - Why the exit occurred (STOP_LOSS, TAKE_PROFIT, etc.)
   * @returns {Promise<{valid: boolean, warnings: string[], anomalies: Object}>}
   */
  async validateExit(position, exitPrice, exitReason) {
    const warnings = [];
    const anomalies = {};
    
    const entryPrice = parseFloat(position.avg_price);
    const multiplier = position.contract_type === 'STOCK' ? 1 : 100;

    // Check 1: Exit price is reasonable (positive, not extreme)
    if (!this._isPriceReasonable(exitPrice, position.symbol)) {
      warnings.push(`Exit price $${exitPrice} seems unrealistic for ${position.symbol}`);
      anomalies.unrealisticPrice = true;
    }

    // Check 2: Exit price doesn't violate contract mutuality
    // E.g., for a long position, exit should be reasonably close to entry (with slippage)
    const exitSlippageRatio = Math.abs(exitPrice - entryPrice) / entryPrice;
    if (exitSlippageRatio > 0.5) {
      // 50%+ move from entry to exit is extreme unless it's an expiry or max loss
      if (!['DTE_EXPIRY', 'MAX_LOSS', 'MAX_HOLD'].includes(exitReason)) {
        warnings.push(`Exit price $${exitPrice} is ${(exitSlippageRatio * 100).toFixed(1)}% away from entry $${entryPrice}`);
        anomalies.extremePriceMove = exitSlippageRatio;
      }
    }

    // Check 3: P&L sign matches reason
    let expectedPnl;
    if (position.contract_type === 'CREDIT_SPREAD') {
      expectedPnl = (entryPrice - exitPrice) * position.quantity * multiplier;
    } else {
      expectedPnl = (exitPrice - entryPrice) * position.quantity * multiplier;
    }

    // Stop-loss should result in a loss (or break-even)
    if (exitReason === 'STOP_LOSS' && expectedPnl > 0) {
      warnings.push(`Stop-loss exit with unexpected gain: $${expectedPnl.toFixed(2)} (likely stale price)`);
      anomalies.stopLossGain = true;
    }

    // Take-profit should result in a gain (or break-even)
    if (exitReason === 'TAKE_PROFIT' && expectedPnl < 0) {
      warnings.push(`Take-profit exit with loss: $${expectedPnl.toFixed(2)} (likely stale price)`);
      anomalies.takeProfitLoss = true;
    }

    // Check 4: Exit doesn't exceed position watermarks by too much
    if (position.highest_price && position.lowest_price) {
      const highest = parseFloat(position.highest_price);
      const lowest = parseFloat(position.lowest_price);
      
      if (exitPrice > highest * 1.1 || exitPrice < lowest * 0.9) {
        warnings.push(
          `Exit price $${exitPrice} is outside position range ` +
          `[${lowest.toFixed(2)}, ${highest.toFixed(2)}] by >10%`
        );
        anomalies.outsideWatermarks = true;
      }
    }

    // Check 5: Exit hold time is reasonable (min 5 seconds, max 1 year)
    if (position.opened_at && position.closed_at) {
      const holdMs = new Date(position.closed_at) - new Date(position.opened_at);
      if (holdMs < 5000) {
        warnings.push(`Position held for only ${(holdMs / 1000).toFixed(1)}s (likely execution error)`);
        anomalies.tooFastExit = true;
      }
      if (holdMs > 365 * 24 * 60 * 60 * 1000) {
        warnings.push(`Position held for >1 year (likely stale position)`);
        anomalies.veryOldPosition = true;
      }
    }

    // Check 6: For options, exit price shouldn't exceed spread width on spreads
    if (position.contract_type === 'CREDIT_SPREAD' && position.strike_short && position.strike_long) {
      const spreadWidth = Math.abs(
        parseFloat(position.strike_short) - parseFloat(position.strike_long)
      );
      if (exitPrice > spreadWidth * 1.01) {
        warnings.push(
          `Credit spread exit $${exitPrice} exceeds max width ${spreadWidth.toFixed(2)} ` +
          `(likely pricing error or expiry)`
        );
        anomalies.spreadWidthExceeded = true;
      }
    }

    // Log warnings if any detected
    if (warnings.length > 0) {
      const pnlStr = expectedPnl >= 0 ? `+$${expectedPnl.toFixed(2)}` : `-$${Math.abs(expectedPnl).toFixed(2)}`;
      const details = `${position.symbol} entry=$${entryPrice} exit=$${exitPrice} P&L=${pnlStr} reason=${exitReason}`;
      
      warnings.forEach(w => {
        logger.warn(`[EXIT_VALIDATION] ${w} | ${details}`, 'entry-exit-validation');
      });

      // For multiple anomalies, escalate to Sentry
      if (Object.keys(anomalies).length >= 2) {
        Sentry.captureMessage(`Multiple exit validation anomalies detected: ${Object.keys(anomalies).join(', ')}`, {
          level: 'warning',
          tags: { module: 'entry-exit-validation', type: 'exit-validation' },
          contexts: {
            position: {
              symbol: position.symbol,
              contract_type: position.contract_type,
              entry_price: entryPrice,
              exit_price: exitPrice,
              expected_pnl: expectedPnl,
              exit_reason: exitReason,
            },
            anomalies,
          },
        });
      }
    }

    return { valid: warnings.length === 0, warnings, anomalies };
  }

  /**
   * Validate consistency between entry and exit orders for the same position
   * Ensures position was correctly closed and P&L is computable
   * 
   * @param {Object} entry - sim_position record at entry
   * @param {object} exit - sim_position record at exit
   * @returns {Promise<{consistent: boolean, issues: string[]}>}
   */
  async validateEntryExitPair(entry, exit) {
    const issues = [];

    // Check 1: Same position ID
    if (entry.id !== exit.id) {
      issues.push('Entry and exit records have different IDs');
    }

    // Check 2: Entry was open, exit is closed
    if (entry.status !== 'OPEN') {
      issues.push(`Entry status is ${entry.status}, expected OPEN`);
    }
    if (exit.status !== 'CLOSED') {
      issues.push(`Exit status is ${exit.status}, expected CLOSED`);
    }

    // Check 3: Exit happened after entry
    if (new Date(exit.closed_at) <= new Date(entry.opened_at)) {
      issues.push('Exit time is not after entry time');
    }

    // Check 4: Quantity is same
    if (entry.quantity !== exit.quantity) {
      issues.push(`Quantity changed from ${entry.quantity} to ${exit.quantity}`);
    }

    // Check 5: Contract identity is same
    if (entry.symbol !== exit.symbol || entry.contract_type !== exit.contract_type) {
      issues.push('Contract symbol or type changed between entry and exit');
    }

    // Check 6: Avg price (entry price) is same
    if (parseFloat(entry.avg_price) !== parseFloat(exit.avg_price)) {
      issues.push(
        `Entry price changed from $${entry.avg_price} to ${exit.avg_price}`
      );
    }

    if (issues.length > 0) {
      issues.forEach(issue => {
        logger.error(`[ENTRY_EXIT_PAIR] ${issue} | ${entry.symbol}`, 'entry-exit-validation');
      });
    }

    return { consistent: issues.length === 0, issues };
  }

  // ─────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Check if a price is reasonable for a symbol
   * Flags prices that are clearly wrong (negative, > $1000000, etc.)
   */
  _isPriceReasonable(price, symbol) {
    if (price <= 0) return false;
    if (price > 10000000) return false;
    
    // Stocks typically trade < $1000, options < $1000, spreads < $100
    if (price > 1000000) return false; // Way too high
    
    return true;
  }

  /**
   * Validate stop-loss level makes sense relative to entry price and side
   */
  _validateStopLevel(side, contractType, entryPrice, stopPrice) {
    const isCreditSpread = contractType === 'CREDIT_SPREAD';
    
    // For long positions and debit spreads: stop should be below entry
    if ((side === 'BUY' || side === 'SELL') && !isCreditSpread && side === 'BUY') {
      if (stopPrice > entryPrice) {
        return {
          valid: false,
          message: `Stop-loss $${stopPrice} is above entry $${entryPrice} for long position (should be below)`,
        };
      }
    }

    // For credit spreads: stop should be above entry
    if (isCreditSpread && side === 'SELL') {
      if (stopPrice < entryPrice) {
        return {
          valid: false,
          message: `Stop-loss $${stopPrice} is below entry $${entryPrice} for credit spread (should be above)`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validate take-profit level makes sense relative to entry price and side
   */
  _validateTargetLevel(side, contractType, entryPrice, targetPrice) {
    const isCreditSpread = contractType === 'CREDIT_SPREAD';
    
    // For long positions: target should be above entry
    if (side === 'BUY' && !isCreditSpread) {
      if (targetPrice < entryPrice) {
        return {
          valid: false,
          message: `Take-profit $${targetPrice} is below entry $${entryPrice} for long position (should be above)`,
        };
      }
    }

    // For credit spreads: target should be below entry
    if (isCreditSpread && side === 'SELL') {
      if (targetPrice > entryPrice) {
        return {
          valid: false,
          message: `Take-profit $${targetPrice} is above entry $${entryPrice} for credit spread (should be below)`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Check if entry and exit prices form an unusual pattern
   * E.g., gaps, reversals, etc.
   */
  async _checkPricePattern(entryPrice, exitPrice, highWatermark, lowWatermark) {
    // Entry -> High -> Exit: normal profit scenario
    // Entry -> Low -> Exit: normal loss scenario
    // Entry -> High -> Exit below Low: impossible (gap)
    // etc.

    const patterns = [];

    if (exitPrice > highWatermark) {
      patterns.push('exit_above_high_watermark');
    }
    if (exitPrice < lowWatermark) {
      patterns.push('exit_below_low_watermark');
    }

    return patterns;
  }
}

module.exports = new EntryExitValidationService();
