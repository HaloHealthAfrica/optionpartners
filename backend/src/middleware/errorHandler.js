const Sentry = require('@sentry/node');

const errorHandler = (err, req, res, next) => {
  const isClientDisconnect = err.message === 'aborted' ||
                              err.code === 'ECONNRESET' ||
                              err.code === 'EPIPE' ||
                              err.code === 'ECONNABORTED';

  if (!isClientDisconnect) {
    console.error(err.stack);
  }

  if (isClientDisconnect) {
    return;
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation Error',
      details: err.message
    });
  }

  if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid token'
    });
  }

  if (err.code === '23505') {
    return res.status(409).json({
      error: 'Conflict',
      message: 'Resource already exists'
    });
  }

  if (err.code === '23503') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid reference'
    });
  }

  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
};

module.exports = errorHandler;