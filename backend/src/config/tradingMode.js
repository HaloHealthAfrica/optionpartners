'use strict';

/**
 * @typedef {'SIM'} TradingMode
 */

const TRADING_MODE = process.env.TRADING_MODE || 'SIM';

if (TRADING_MODE !== 'SIM') {
  console.error(
    `FATAL: TRADING_MODE="${TRADING_MODE}" is not supported. Only SIM mode is allowed.`
  );
  process.exit(1);
}

function assertSimMode() {
  if (TRADING_MODE !== 'SIM') {
    throw new Error(`Operation rejected: TRADING_MODE must be SIM, got "${TRADING_MODE}"`);
  }
}

module.exports = {
  TRADING_MODE,
  assertSimMode,
};
