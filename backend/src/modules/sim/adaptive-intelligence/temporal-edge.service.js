'use strict';

const db = require('../../../config/database');
const logger = require('../../../utils/logger');

const HOUR_BLOCKS = [
  { label: '9:30-10', start: 9, startMin: 30, end: 10, endMin: 0 },
  { label: '10-11',   start: 10, startMin: 0,  end: 11, endMin: 0 },
  { label: '11-12',   start: 11, startMin: 0,  end: 12, endMin: 0 },
  { label: '12-13',   start: 12, startMin: 0,  end: 13, endMin: 0 },
  { label: '13-14',   start: 13, startMin: 0,  end: 14, endMin: 0 },
  { label: '14-15',   start: 14, startMin: 0,  end: 15, endMin: 0 },
  { label: '15-16',   start: 15, startMin: 0,  end: 16, endMin: 0 },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

class TemporalEdgeService {
  /**
   * Compute performance by hour-of-day and day-of-week for sim trades.
   * Returns a heatmap matrix and per-strategy breakdowns.
   */
  async analyze(userId, options = {}) {
    const lookbackDays = options.lookbackDays || 90;
    const minSampleSize = options.minSampleSize || 3;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lookbackDays);

    // Get user timezone
    let userTimezone = 'America/New_York';
    try {
      const tzResult = await db.query(
        `SELECT timezone FROM user_settings WHERE user_id = $1`,
        [userId]
      );
      if (tzResult.rows[0]?.timezone) {
        userTimezone = tzResult.rows[0].timezone;
      }
    } catch {
      // Default to ET
    }

    const { rows } = await db.query(
      `SELECT
         strategy,
         symbol,
         pnl,
         pnl_percent,
         r_multiple,
         entry_time,
         EXTRACT(HOUR FROM (entry_time AT TIME ZONE $3)) as entry_hour,
         EXTRACT(MINUTE FROM (entry_time AT TIME ZONE $3)) as entry_minute,
         EXTRACT(DOW FROM (entry_time AT TIME ZONE $3)) as entry_dow
       FROM sim_trades
       WHERE user_id = $1
         AND exit_time IS NOT NULL
         AND entry_time >= $2
       ORDER BY entry_time DESC`,
      [userId, cutoff, userTimezone]
    );

    if (rows.length === 0) {
      return { heatmap: [], hourSummary: [], daySummary: [], strategySummary: [], totalTrades: 0, lookbackDays };
    }

    // Build hour × day heatmap
    const heatmap = this._buildHeatmap(rows, minSampleSize);

    // Build hour summary (all days combined)
    const hourSummary = this._buildHourSummary(rows, minSampleSize);

    // Build day summary (all hours combined)
    const daySummary = this._buildDaySummary(rows, minSampleSize);

    // Build per-strategy temporal breakdown
    const strategySummary = this._buildStrategySummary(rows, minSampleSize);

    // Identify edge hours (statistically significant edges)
    const baseWinRate = rows.filter(r => parseFloat(r.pnl) > 0).length / rows.length;
    const edgeHours = hourSummary
      .filter(h => h.sampleSize >= minSampleSize && Math.abs(h.winRate - baseWinRate) > 0.10)
      .map(h => ({
        hour: h.hour,
        label: h.label,
        winRateDelta: Math.round((h.winRate - baseWinRate) * 10000) / 100,
        direction: h.winRate > baseWinRate ? 'STRONG' : 'WEAK',
        sampleSize: h.sampleSize,
      }));

    return {
      heatmap,
      hourSummary,
      daySummary,
      strategySummary,
      edgeHours,
      baseWinRate: Math.round(baseWinRate * 10000) / 10000,
      totalTrades: rows.length,
      lookbackDays,
      timezone: userTimezone,
      computedAt: Date.now(),
    };
  }

  _getHourBlock(hour, minute) {
    const totalMin = hour * 60 + minute;
    for (const block of HOUR_BLOCKS) {
      const blockStart = block.start * 60 + block.startMin;
      const blockEnd = block.end * 60 + block.endMin;
      if (totalMin >= blockStart && totalMin < blockEnd) {
        return block.label;
      }
    }
    return null;
  }

  _buildHeatmap(rows, minSampleSize) {
    const cells = new Map();

    for (const row of rows) {
      const hourBlock = this._getHourBlock(parseInt(row.entry_hour), parseInt(row.entry_minute));
      const dow = parseInt(row.entry_dow);
      if (!hourBlock || dow === 0 || dow === 6) continue; // Skip weekends and out-of-hours

      const key = `${hourBlock}::${dow}`;
      if (!cells.has(key)) {
        cells.set(key, { hour: hourBlock, day: DAY_NAMES[dow], dow, trades: [] });
      }
      cells.get(key).trades.push(row);
    }

    const result = [];
    for (const [, cell] of cells) {
      const metrics = this._computeMetrics(cell.trades);
      result.push({
        hour: cell.hour,
        day: cell.day,
        dow: cell.dow,
        ...metrics,
        significant: metrics.sampleSize >= minSampleSize,
      });
    }

    result.sort((a, b) => {
      const hourOrder = HOUR_BLOCKS.findIndex(h => h.label === a.hour) - HOUR_BLOCKS.findIndex(h => h.label === b.hour);
      return hourOrder !== 0 ? hourOrder : a.dow - b.dow;
    });

    return result;
  }

  _buildHourSummary(rows, minSampleSize) {
    const byHour = new Map();

    for (const row of rows) {
      const hourBlock = this._getHourBlock(parseInt(row.entry_hour), parseInt(row.entry_minute));
      if (!hourBlock) continue;

      if (!byHour.has(hourBlock)) {
        byHour.set(hourBlock, []);
      }
      byHour.get(hourBlock).push(row);
    }

    return HOUR_BLOCKS.map(block => {
      const trades = byHour.get(block.label) || [];
      const metrics = this._computeMetrics(trades);
      return {
        hour: block.start,
        label: block.label,
        ...metrics,
        significant: metrics.sampleSize >= minSampleSize,
      };
    });
  }

  _buildDaySummary(rows, minSampleSize) {
    const byDay = new Map();

    for (const row of rows) {
      const dow = parseInt(row.entry_dow);
      if (dow === 0 || dow === 6) continue;
      if (!byDay.has(dow)) {
        byDay.set(dow, []);
      }
      byDay.get(dow).push(row);
    }

    return [1, 2, 3, 4, 5].map(dow => {
      const trades = byDay.get(dow) || [];
      const metrics = this._computeMetrics(trades);
      return {
        day: DAY_NAMES[dow],
        dow,
        ...metrics,
        significant: metrics.sampleSize >= minSampleSize,
      };
    });
  }

  _buildStrategySummary(rows, minSampleSize) {
    const byStrategy = new Map();

    for (const row of rows) {
      const hourBlock = this._getHourBlock(parseInt(row.entry_hour), parseInt(row.entry_minute));
      if (!hourBlock) continue;
      const key = `${row.strategy}::${hourBlock}`;
      if (!byStrategy.has(key)) {
        byStrategy.set(key, { strategy: row.strategy, hour: hourBlock, trades: [] });
      }
      byStrategy.get(key).trades.push(row);
    }

    const result = [];
    for (const [, cell] of byStrategy) {
      const metrics = this._computeMetrics(cell.trades);
      if (metrics.sampleSize >= minSampleSize) {
        result.push({
          strategy: cell.strategy,
          hour: cell.hour,
          ...metrics,
        });
      }
    }

    result.sort((a, b) => a.strategy.localeCompare(b.strategy));
    return result;
  }

  _computeMetrics(trades) {
    if (trades.length === 0) {
      return { sampleSize: 0, winRate: 0, avgPnl: 0, avgR: 0, totalPnl: 0 };
    }

    const pnls = trades.map(t => parseFloat(t.pnl));
    const wins = pnls.filter(p => p > 0);
    const totalPnl = pnls.reduce((a, b) => a + b, 0);

    const rValues = trades.filter(t => t.r_multiple != null).map(t => parseFloat(t.r_multiple));
    const avgR = rValues.length > 0 ? rValues.reduce((a, b) => a + b, 0) / rValues.length : 0;

    return {
      sampleSize: trades.length,
      winRate: Math.round((wins.length / trades.length) * 10000) / 10000,
      avgPnl: Math.round((totalPnl / trades.length) * 100) / 100,
      avgR: Math.round(avgR * 1000) / 1000,
      totalPnl: Math.round(totalPnl * 100) / 100,
    };
  }
}

module.exports = new TemporalEdgeService();
