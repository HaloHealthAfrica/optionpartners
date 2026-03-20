'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Sends alerts to an external operator channel (Slack, PagerDuty, etc.)
 * The destination webhook URL is configured via OPERATOR_ALERT_WEBHOOK_URL.
 * Messages are fire-and-forget; failures are logged but do not throw.
 */
class OperatorAlertService {
  constructor() {
    this.webhookUrl = process.env.OPERATOR_ALERT_WEBHOOK_URL || null;
    this.enabled = !!this.webhookUrl;
    if (!this.enabled) {
      logger.info('OperatorAlertService disabled (no webhook URL configured)', 'operator-alert');
    }
  }

  async sendAlert(subject, body = '') {
    if (!this.enabled) return;
    try {
      await axios.post(this.webhookUrl, {
        subject,
        body,
        timestamp: new Date().toISOString(),
      });
      logger.info(`Operator alert sent: ${subject}`, 'operator-alert');
    } catch (err) {
      logger.warn(`Failed to send operator alert: ${err.message}`, 'operator-alert');
    }
  }
}

module.exports = new OperatorAlertService();