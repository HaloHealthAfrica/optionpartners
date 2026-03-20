/**
 * Data Provider Validation - API Routes
 */

const express = require('express');
const router = express.Router();
const controller = require('./data-validation.controller');
const { authenticate, optionalAuth } = require('../../middleware/auth');

// All routes require auth
router.use(authenticate);

router.get('/freshness', controller.getFreshness);
router.get('/today', controller.getTodayRuns);
router.get('/history', controller.getHistoryHeatmap);
router.get('/alerts', controller.getAlerts);
router.post('/alerts/:id/dismiss', controller.dismissAlert);
router.post('/run-now', controller.runNow);
router.post('/ensure-slots', controller.ensureSlots);

module.exports = router;
