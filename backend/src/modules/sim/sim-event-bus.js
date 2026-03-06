'use strict';

const EventEmitter = require('events');
const logger = require('../../utils/logger');

/**
 * SimEventBus — Singleton event emitter for real-time SIM pipeline events.
 *
 * Events emitted:
 *   'trade:finalized'  — After a trade is closed and written to sim_trades
 *   'trade:blocked'    — After a signal is rejected by any gate
 *   'trade:approved'   — After a signal passes all gates and is approved
 *   'market:context'   — Periodic market context updates (regime, VIX, GEX)
 *   'insight:auto'     — Auto-generated AI insight triggered by trade count
 *
 * SSE clients subscribe via addClient(). The bus fans out events to all
 * connected SSE response objects per userId.
 */
class SimEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this._sseClients = new Map();
  }

  /**
   * Register an SSE response for a userId.
   * @param {string} userId
   * @param {import('express').Response} res
   * @returns {string} clientId for removal
   */
  addClient(userId, res) {
    const clientId = `${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (!this._sseClients.has(userId)) {
      this._sseClients.set(userId, new Map());
    }
    this._sseClients.get(userId).set(clientId, res);

    logger.info(`[SSE] Client connected: ${clientId} (user ${userId}, total: ${this._sseClients.get(userId).size})`, 'sim-event-bus');
    return clientId;
  }

  /**
   * Remove an SSE client.
   */
  removeClient(userId, clientId) {
    const userClients = this._sseClients.get(userId);
    if (userClients) {
      userClients.delete(clientId);
      if (userClients.size === 0) {
        this._sseClients.delete(userId);
      }
    }
    logger.info(`[SSE] Client disconnected: ${clientId}`, 'sim-event-bus');
  }

  /**
   * Send an SSE event to all connected clients for a given userId.
   * @param {string} userId
   * @param {string} eventType - SSE event name
   * @param {Object} payload
   */
  sendToUser(userId, eventType, payload) {
    const userClients = this._sseClients.get(userId);
    if (!userClients || userClients.size === 0) return;

    const data = JSON.stringify(payload);
    const message = `event: ${eventType}\ndata: ${data}\n\n`;

    for (const [clientId, res] of userClients) {
      try {
        res.write(message);
      } catch (err) {
        logger.error(`[SSE] Write failed for client ${clientId}: ${err.message}`, 'sim-event-bus');
        this.removeClient(userId, clientId);
      }
    }
  }

  /**
   * Broadcast to all connected clients (all users).
   */
  broadcast(eventType, payload) {
    for (const userId of this._sseClients.keys()) {
      this.sendToUser(userId, eventType, payload);
    }
  }

  /**
   * Get connection count for a user.
   */
  getClientCount(userId) {
    return this._sseClients.get(userId)?.size || 0;
  }

  /**
   * Get total connection count across all users.
   */
  getTotalClientCount() {
    let total = 0;
    for (const userClients of this._sseClients.values()) {
      total += userClients.size;
    }
    return total;
  }
}

const simEventBus = new SimEventBus();

module.exports = simEventBus;
