const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const dataService = require('../services/dataServiceProxy');

/**
 * @swagger
 * tags:
 *   name: Market Data
 *   description: Proxied market intelligence from the data-service
 */

function handleError(res, err) {
  const status = err.status || 500;
  res.status(status).json({ error: err.message });
}

/**
 * @swagger
 * /api/market-data/regime:
 *   get:
 *     summary: Get current market regime (VIX-based)
 *     tags: [Market Data]
 *     security:
 *       - bearerAuth: []
 */
router.get('/regime', authenticate, async (req, res) => {
  try {
    const data = await dataService.getRegime();
    res.json(data);
  } catch (err) { handleError(res, err); }
});

/**
 * @swagger
 * /api/market-data/vix:
 *   get:
 *     summary: Get VIX spot and futures term structure
 *     tags: [Market Data]
 *     security:
 *       - bearerAuth: []
 */
router.get('/vix', authenticate, async (req, res) => {
  try {
    const data = await dataService.getVIX();
    res.json(data);
  } catch (err) { handleError(res, err); }
});

/**
 * @swagger
 * /api/market-data/macro:
 *   get:
 *     summary: Get macro economic indicators (Fed funds, yield curve, FOMC)
 *     tags: [Market Data]
 *     security:
 *       - bearerAuth: []
 */
router.get('/macro', authenticate, async (req, res) => {
  try {
    const data = await dataService.getMacro();
    res.json(data);
  } catch (err) { handleError(res, err); }
});

/**
 * @swagger
 * /api/market-data/market-hours:
 *   get:
 *     summary: Get current market hours status
 *     tags: [Market Data]
 *     security:
 *       - bearerAuth: []
 */
router.get('/market-hours', authenticate, async (req, res) => {
  try {
    const data = await dataService.getMarketHours();
    res.json(data);
  } catch (err) { handleError(res, err); }
});

/**
 * @swagger
 * /api/market-data/gex/{symbol}:
 *   get:
 *     summary: Get gamma exposure (GEX) data for a symbol
 *     tags: [Market Data]
 *     security:
 *       - bearerAuth: []
 */
router.get('/gex/:symbol', authenticate, async (req, res) => {
  try {
    const data = await dataService.getGEX(req.params.symbol);
    res.json(data);
  } catch (err) { handleError(res, err); }
});

/**
 * @swagger
 * /api/market-data/flow/{symbol}:
 *   get:
 *     summary: Get options flow summary for a symbol
 *     tags: [Market Data]
 *     security:
 *       - bearerAuth: []
 */
router.get('/flow/:symbol', authenticate, async (req, res) => {
  try {
    const data = await dataService.getFlow(req.params.symbol);
    res.json(data);
  } catch (err) { handleError(res, err); }
});

/**
 * @swagger
 * /api/market-data/iv/{symbol}:
 *   get:
 *     summary: Get implied volatility data for a symbol
 *     tags: [Market Data]
 *     security:
 *       - bearerAuth: []
 */
router.get('/iv/:symbol', authenticate, async (req, res) => {
  try {
    const data = await dataService.getIV(req.params.symbol);
    res.json(data);
  } catch (err) { handleError(res, err); }
});

/**
 * @swagger
 * /api/market-data/quote/{symbol}:
 *   get:
 *     summary: Get real-time quote for a symbol
 *     tags: [Market Data]
 *     security:
 *       - bearerAuth: []
 */
router.get('/quote/:symbol', authenticate, async (req, res) => {
  try {
    const data = await dataService.getQuote(req.params.symbol);
    res.json(data);
  } catch (err) { handleError(res, err); }
});

/**
 * @swagger
 * /api/market-data/health:
 *   get:
 *     summary: Get data-service health status
 *     tags: [Market Data]
 *     security:
 *       - bearerAuth: []
 */
router.get('/health', authenticate, async (req, res) => {
  try {
    const data = await dataService.getHealth();
    res.json(data);
  } catch (err) { handleError(res, err); }
});

module.exports = router;
