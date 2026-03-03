const Sentry = require('@sentry/node');

const SENTRY_DSN = process.env.SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || `tradepartners@${process.env.npm_package_version || 'unknown'}`,
    sendDefaultPii: true,

    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,

    ignoreErrors: [
      'ECONNRESET',
      'EPIPE',
      'ECONNABORTED',
      'aborted',
      'Not allowed by CORS',
    ],

    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['x-api-key'];
        delete event.request.headers['cookie'];
      }
      return event;
    },
  });

  console.log(`[Sentry] Initialized (env=${process.env.NODE_ENV || 'development'})`);
} else {
  console.log('[Sentry] Disabled — SENTRY_DSN not set');
}
