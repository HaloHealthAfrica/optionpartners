const Sentry = require('@sentry/node');
const { getErrorByInternalCode } = require('../config/errorCodes');

const errorHandler = (err, req, res, next) => {
  const isClientDisconnect = err.message === 'aborted' ||
                              err.code === 'ECONNRESET' ||
                              err.code === 'EPIPE' ||
                              err.code === 'ECONNABORTED';

  if (!isClientDisconnect) {
    console.error(err.stack);
    Sentry.captureException(err, {
      tags: { middleware: 'error-handler' },
      extra: { path: req?.path, method: req?.method },
    });
  }

  if (isClientDisconnect) {
    return;
  }

  if (err.name === 'ValidationError') {
    const catalogEntry = getErrorByInternalCode('VALIDATION_ERROR');
    return res.status(400).json({
      error: 'Validation Error',
      details: err.message,
      errorCode: catalogEntry?.code || null,
    });
  }

  if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
    const catalogEntry = getErrorByInternalCode('INVALID_TOKEN');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid token',
      errorCode: catalogEntry?.code || null,
    });
  }

  if (err.code === '23505') {
    const catalogEntry = getErrorByInternalCode('DUPLICATE_RESOURCE');
    return res.status(409).json({
      error: 'Conflict',
      message: 'Resource already exists',
      errorCode: catalogEntry?.code || null,
    });
  }

  if (err.code === '23503') {
    const catalogEntry = getErrorByInternalCode('INVALID_REFERENCE');
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid reference',
      errorCode: catalogEntry?.code || null,
    });
  }

  const catalogEntry = getErrorByInternalCode('INTERNAL_SERVER_ERROR');
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
    errorCode: catalogEntry?.code || null,
  });
};

module.exports = errorHandler;
