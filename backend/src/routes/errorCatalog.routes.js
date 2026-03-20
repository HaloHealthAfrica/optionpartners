const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  getAllErrors,
  getCategories,
  getSeveritySummary,
  getErrorsByCategory,
  getErrorsBySeverity,
  ERROR_CATALOG,
  CATEGORY,
} = require('../config/errorCodes');

router.get('/', authenticate, (req, res) => {
  const { category, severity, search } = req.query;

  let errors = getAllErrors();

  if (category && CATEGORY[category]) {
    errors = errors.filter(e => e.category.key === CATEGORY[category].key);
  }

  if (severity) {
    errors = errors.filter(e => e.severity === severity);
  }

  if (search) {
    const q = search.toLowerCase();
    errors = errors.filter(e =>
      e.code.toLowerCase().includes(q) ||
      e.title.toLowerCase().includes(q) ||
      e.message.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.internalCode.toLowerCase().includes(q)
    );
  }

  res.json({
    errors,
    categories: getCategories(),
    severitySummary: getSeveritySummary(),
  });
});

router.get('/:code', authenticate, (req, res) => {
  const error = ERROR_CATALOG[req.params.code.toUpperCase()];
  if (!error) {
    return res.status(404).json({ error: 'Error code not found' });
  }
  res.json(error);
});

module.exports = router;
