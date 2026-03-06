'use strict';

const db = require('../../../config/database');
const logger = require('../../../utils/logger');

class RemediationLogService {
  async getEntries(userId, { limit = 100 } = {}) {
    const result = await db.query(
      `SELECT id, title, description, category, status, assessment_date, applied_date, created_at
       FROM system_remediation_log
       WHERE user_id = $1
       ORDER BY applied_date DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  }

  async addEntry(userId, { title, description, category, status = 'applied', assessmentDate = null }) {
    const result = await db.query(
      `INSERT INTO system_remediation_log (user_id, title, description, category, status, assessment_date, applied_date)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [userId, title, description, category, status, assessmentDate]
    );
    logger.info(`[REMEDIATION_LOG] Added entry "${title}" for user ${userId}`, 'remediation-log');
    return result.rows[0];
  }

  async addEntries(userId, entries) {
    const results = [];
    for (const entry of entries) {
      results.push(await this.addEntry(userId, entry));
    }
    return results;
  }

  async removeEntry(userId, entryId) {
    await db.query(
      `DELETE FROM system_remediation_log WHERE id = $1 AND user_id = $2`,
      [entryId, userId]
    );
  }

  async updateEntry(userId, entryId, updates) {
    const fields = [];
    const values = [entryId, userId];
    let idx = 3;

    for (const [key, val] of Object.entries(updates)) {
      const col = key === 'assessmentDate' ? 'assessment_date' : key === 'appliedDate' ? 'applied_date' : key;
      if (['title', 'description', 'category', 'status', 'assessment_date', 'applied_date'].includes(col)) {
        fields.push(`${col} = $${idx}`);
        values.push(val);
        idx++;
      }
    }

    if (fields.length === 0) return null;

    const result = await db.query(
      `UPDATE system_remediation_log SET ${fields.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  buildPromptSection(entries) {
    if (!entries || entries.length === 0) return '';

    const lines = [
      '\n## PREVIOUSLY IMPLEMENTED FIXES (Remediation Log)',
      'The following issues were identified in prior health assessments and have ALREADY been fixed.',
      'Do NOT repeat these as new recommendations. Instead, verify whether the fix is working by checking the data.',
      'If a previously-fixed issue is still showing up in the data, note it as "FIX NOT YET EFFECTIVE" with possible reasons (insufficient time, data lag, deeper root cause).\n',
    ];

    for (const entry of entries) {
      const date = entry.applied_date
        ? new Date(entry.applied_date).toISOString().split('T')[0]
        : 'unknown';
      lines.push(`- [${date}] [${entry.category}] ${entry.title}`);
      lines.push(`  Status: ${entry.status} | ${entry.description}`);
    }

    return lines.join('\n');
  }
}

module.exports = new RemediationLogService();
