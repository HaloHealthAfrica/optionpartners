const path = require('path');
try {
  require(path.join(__dirname, '..', 'backend', 'node_modules', 'dotenv')).config({
    path: path.join(__dirname, '..', 'backend', '.env'),
  });
} catch (_) {}
const { Pool } = require(path.join(__dirname, '..', 'backend', 'node_modules', 'pg'));
const crypto = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL || process.argv[2];
if (!DATABASE_URL) { console.error('Usage: DATABASE_URL=... node seed-sim-data.js'); process.exit(1); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
});

// Resolve USER_ID: use SEED_USER_ID env, or first user in DB (so seed matches logged-in user)
let USER_ID = process.env.SEED_USER_ID;

function uuid() { return crypto.randomUUID(); }
function days(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function ts(base, h, m) {
  const d = new Date(base);
  d.setHours(h, m, Math.floor(Math.random() * 59), 0);
  return d.toISOString();
}
function round(v, d = 2) { return Math.round(v * 10 ** d) / 10 ** d; }

// ── Webhook events: realistic payloads for each indicator source ─────────────
function buildWebhookEvents() {
  const events = [];
  const now = new Date();

  const orbPayloads = [
    { ticker: 'SPY', indicator: 'ORB', action: 'BUY', entry: 592.45, stop: 590.80, timeframe: '5m', timestamp: Math.floor(days(14).getTime() / 1000) },
    { ticker: 'QQQ', indicator: 'ORB', action: 'BUY', entry: 518.30, stop: 516.50, timeframe: '5m', timestamp: Math.floor(days(12).getTime() / 1000) },
    { ticker: 'AAPL', indicator: 'ORB', action: 'SELL', entry: 228.10, stop: 229.90, timeframe: '5m', timestamp: Math.floor(days(10).getTime() / 1000) },
    { ticker: 'NVDA', indicator: 'Stretch', action: 'BUY', entry: 138.50, stop: 136.80, timeframe: '5m', timestamp: Math.floor(days(8).getTime() / 1000) },
    { ticker: 'TSLA', indicator: 'EMA', action: 'SELL', entry: 356.20, stop: 360.10, timeframe: '15m', timestamp: Math.floor(days(5).getTime() / 1000) },
  ];

  const stratPayloads = [
    { ticker: 'SPY', journal: { engine: 'STRAT_V6_FULL' }, signal: { side: 'long' }, setup: '2-1-2_Bullish', entry: 591.80, stop: 589.50, target: 595.00, score: 82, timeframe: '5m', timestamp: Math.floor(days(13).getTime() / 1000) },
    { ticker: 'MSFT', journal: { engine: 'STRAT_V6_FULL' }, signal: { side: 'long' }, setup: 'Failed2', entry: 415.30, stop: 412.00, target: 420.00, score: 78, timeframe: '15m', timestamp: Math.floor(days(11).getTime() / 1000) },
    { ticker: 'AMZN', journal: { engine: 'STRAT_V6_FULL' }, signal: { side: 'short' }, setup: '3-2-2_Bearish', entry: 228.70, stop: 231.00, target: 225.00, score: 85, timeframe: '5m', timestamp: Math.floor(days(7).getTime() / 1000) },
    { ticker: 'META', journal: { engine: 'STRAT_V6_FULL' }, signal: { side: 'long' }, setup: '2-1-2_Bullish', entry: 605.40, stop: 601.00, target: 612.00, score: 90, timeframe: '5m', timestamp: Math.floor(days(3).getTime() / 1000) },
  ];

  const trendPayloads = [
    { ticker: 'SPY', bias: 'bullish', timeframes: { '3m': { dir: 'bullish', chg: true }, '5m': { dir: 'bullish', chg: false }, '15m': { dir: 'bullish', chg: true }, '30m': { dir: 'bullish', chg: false }, '1h': { dir: 'bullish', chg: false }, '4h': { dir: 'bullish', chg: false } }, alignment_score: 95, trigger_timeframe: '15m', price: 593.10, timestamp: Math.floor(days(9).getTime() / 1000) },
    { ticker: 'QQQ', bias: 'bearish', timeframes: { '3m': { dir: 'bearish', chg: true }, '5m': { dir: 'bearish', chg: true }, '15m': { dir: 'bullish', chg: false }, '30m': { dir: 'bearish', chg: true }, '1h': { dir: 'bearish', chg: false }, '4h': { dir: 'bullish', chg: false } }, alignment_score: 55, trigger_timeframe: '5m', price: 516.80, timestamp: Math.floor(days(6).getTime() / 1000) },
    { ticker: 'NVDA', bias: 'bullish', timeframes: { '3m': { dir: 'bullish', chg: false }, '5m': { dir: 'bullish', chg: true }, '15m': { dir: 'bullish', chg: true }, '30m': { dir: 'bullish', chg: false }, '1h': { dir: 'bullish', chg: true }, '4h': { dir: 'bullish', chg: false } }, alignment_score: 88, trigger_timeframe: '5m', price: 139.20, timestamp: Math.floor(days(4).getTime() / 1000) },
  ];

  const satyPayloads = [
    { ticker: 'SPY', meta: { engine: 'SATY_PO', source: 'satyland' }, regime_context: { local_bias: 'bullish' }, execution_guidance: { bias: 'bullish' }, event: { phase_name: 'MARKUP' }, timeframe: '5m', timestamp: Math.floor(days(11).getTime() / 1000) },
    { ticker: 'AAPL', meta: { engine: 'SATY_PO', source: 'satyland' }, regime_context: { local_bias: 'bearish' }, execution_guidance: { bias: 'bearish' }, event: { phase_name: 'MARKDOWN' }, timeframe: '15m', timestamp: Math.floor(days(6).getTime() / 1000) },
  ];

  const signalPayloads = [
    { ticker: 'SPY', signal: { type: 'long', quality: 'high', ai_score: 92, bar_time: days(10).toISOString(), timeframe: '5m' }, direction: 'long', trend: 'bullish', score: 92, pattern: 'GammaDealer', entry: { price: 591.50, stop_loss: 589.00, target_1: 595.00, target_2: 598.00 }, score_breakdown: { total: 92, trend: 25, momentum: 20, volume: 15, volatility: 18, pattern: 14 }, confidence: 88, timeframe: '5m', timestamp: Math.floor(days(10).getTime() / 1000) },
    { ticker: 'NVDA', signal: { type: 'long', quality: 'medium', ai_score: 75, bar_time: days(7).toISOString(), timeframe: '5m' }, direction: 'long', trend: 'bullish', score: 75, pattern: 'VolatilityBreakout', entry: { price: 137.80, stop_loss: 135.50, target_1: 141.00, target_2: 145.00 }, score_breakdown: { total: 75, trend: 20, momentum: 18, volume: 12, volatility: 15, pattern: 10 }, confidence: 72, timeframe: '5m', timestamp: Math.floor(days(7).getTime() / 1000) },
    { ticker: 'TSLA', signal: { type: 'short', quality: 'high', ai_score: 88, bar_time: days(3).toISOString(), timeframe: '15m' }, direction: 'short', trend: 'bearish', score: 88, pattern: 'ExhaustionTop', entry: { price: 358.90, stop_loss: 363.50, target_1: 352.00, target_2: 346.00 }, score_breakdown: { total: 88, trend: 22, momentum: 19, volume: 16, volatility: 17, pattern: 14 }, confidence: 85, timeframe: '15m', timestamp: Math.floor(days(3).getTime() / 1000) },
    { ticker: 'AMZN', signal: { type: 'long', quality: 'low', ai_score: 55, bar_time: days(1).toISOString(), timeframe: '5m' }, direction: 'long', trend: 'bullish', score: 55, pattern: 'MomentumSurge', entry: { price: 230.40, stop_loss: 228.00, target_1: 233.50, target_2: 236.00 }, score_breakdown: { total: 55, trend: 15, momentum: 10, volume: 8, volatility: 12, pattern: 10 }, confidence: 50, timeframe: '5m', timestamp: Math.floor(days(1).getTime() / 1000) },
  ];

  const allPayloads = [
    ...orbPayloads.map(p => ({ source: 'tradingview', payload: p, daysAgo: Math.floor((now - new Date(p.timestamp * 1000)) / 86400000) })),
    ...stratPayloads.map(p => ({ source: 'tradingview', payload: p, daysAgo: Math.floor((now - new Date(p.timestamp * 1000)) / 86400000) })),
    ...trendPayloads.map(p => ({ source: 'tradingview', payload: p, daysAgo: Math.floor((now - new Date(p.timestamp * 1000)) / 86400000) })),
    ...satyPayloads.map(p => ({ source: 'tradingview', payload: p, daysAgo: Math.floor((now - new Date(p.timestamp * 1000)) / 86400000) })),
    ...signalPayloads.map(p => ({ source: 'tradingview', payload: p, daysAgo: Math.floor((now - new Date(p.timestamp * 1000)) / 86400000) })),
  ];

  for (let i = 0; i < allPayloads.length; i++) {
    const { source, payload, daysAgo } = allPayloads[i];
    const receivedAt = days(daysAgo);
    receivedAt.setHours(9, 30 + Math.floor(Math.random() * 30), Math.floor(Math.random() * 59));
    const processed = i < allPayloads.length - 2;
    events.push({
      id: uuid(),
      received_at: receivedAt.toISOString(),
      source,
      raw_payload: payload,
      signature_valid: true,
      dedupe_key: `sim-seed-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: processed ? 'PROCESSED' : (i === allPayloads.length - 1 ? 'REJECTED' : 'RECEIVED'),
      error_message: i === allPayloads.length - 1 ? 'Signal score too low (55 < 60 threshold)' : null,
      processed_at: processed ? new Date(receivedAt.getTime() + 2000).toISOString() : null,
      user_id: USER_ID,
    });
  }
  return events;
}

// ── Sim trades: closed trades with realistic P&L across strategies ───────────
function buildSimTrades(webhookEvents) {
  const trades = [];
  const strategies = [
    { name: 'ORB_Breakout', trades: [
      { sym: 'SPY', under: 'SPY', type: 'CALL', strike: 590, exp: 7, entry: 4.20, exit: 6.80, qty: 2, side: 'long', dte: 7, delta: 0.52, daysAgo: 14, win: true },
      { sym: 'QQQ', under: 'QQQ', type: 'CALL', strike: 515, exp: 5, entry: 5.10, exit: 3.20, qty: 1, side: 'long', dte: 5, delta: 0.48, daysAgo: 12, win: false },
      { sym: 'AAPL', under: 'AAPL', type: 'PUT', strike: 230, exp: 10, entry: 3.80, exit: 5.50, qty: 2, side: 'short', dte: 10, delta: -0.45, daysAgo: 10, win: true },
      { sym: 'NVDA', under: 'NVDA', type: 'CALL', strike: 135, exp: 7, entry: 6.20, exit: 8.90, qty: 3, side: 'long', dte: 7, delta: 0.55, daysAgo: 8, win: true },
      { sym: 'TSLA', under: 'TSLA', type: 'PUT', strike: 360, exp: 5, entry: 7.50, exit: 10.30, qty: 1, side: 'short', dte: 5, delta: -0.50, daysAgo: 5, win: true },
    ]},
    { name: 'STRAT_Failed2', trades: [
      { sym: 'SPY', under: 'SPY', type: 'CALL', strike: 590, exp: 3, entry: 3.40, exit: 5.10, qty: 2, side: 'long', dte: 3, delta: 0.50, daysAgo: 13, win: true },
      { sym: 'MSFT', under: 'MSFT', type: 'CALL', strike: 415, exp: 7, entry: 4.80, exit: 2.90, qty: 1, side: 'long', dte: 7, delta: 0.47, daysAgo: 11, win: false },
      { sym: 'AMZN', under: 'AMZN', type: 'PUT', strike: 230, exp: 5, entry: 3.50, exit: 5.80, qty: 2, side: 'short', dte: 5, delta: -0.44, daysAgo: 7, win: true },
      { sym: 'META', under: 'META', type: 'CALL', strike: 605, exp: 7, entry: 8.20, exit: 12.40, qty: 1, side: 'long', dte: 7, delta: 0.53, daysAgo: 3, win: true },
    ]},
    { name: 'TREND_Alignment', trades: [
      { sym: 'SPY', under: 'SPY', type: 'CALL', strike: 592, exp: 5, entry: 3.90, exit: 6.20, qty: 2, side: 'long', dte: 5, delta: 0.51, daysAgo: 9, win: true },
      { sym: 'QQQ', under: 'QQQ', type: 'PUT', strike: 520, exp: 7, entry: 5.60, exit: 3.10, qty: 1, side: 'short', dte: 7, delta: -0.49, daysAgo: 6, win: false },
      { sym: 'NVDA', under: 'NVDA', type: 'CALL', strike: 138, exp: 5, entry: 5.30, exit: 8.70, qty: 2, side: 'long', dte: 5, delta: 0.54, daysAgo: 4, win: true },
    ]},
    { name: 'SIGNALS_Gamma', trades: [
      { sym: 'SPY', under: 'SPY', type: 'CALL', strike: 590, exp: 3, entry: 4.50, exit: 7.20, qty: 3, side: 'long', dte: 3, delta: 0.58, daysAgo: 10, win: true },
      { sym: 'NVDA', under: 'NVDA', type: 'CALL', strike: 137, exp: 5, entry: 5.80, exit: 4.10, qty: 2, side: 'long', dte: 5, delta: 0.50, daysAgo: 7, win: false },
      { sym: 'TSLA', under: 'TSLA', type: 'PUT', strike: 360, exp: 7, entry: 9.20, exit: 13.50, qty: 1, side: 'short', dte: 7, delta: -0.52, daysAgo: 3, win: true },
    ]},
    { name: 'SATY_Markup', trades: [
      { sym: 'SPY', under: 'SPY', type: 'CALL', strike: 591, exp: 5, entry: 4.10, exit: 6.50, qty: 2, side: 'long', dte: 5, delta: 0.51, daysAgo: 11, win: true },
      { sym: 'AAPL', under: 'AAPL', type: 'PUT', strike: 229, exp: 7, entry: 4.20, exit: 6.90, qty: 1, side: 'short', dte: 7, delta: -0.46, daysAgo: 6, win: true },
    ]},
    // Credit spreads, debit spreads, LEAPs (revenue target allowed types)
    { name: 'RevenueTarget_Spreads', trades: [
      { sym: 'SPY', under: 'SPY', type: 'CREDIT_SPREAD', strike_short: 500, strike_long: 495, optType: 'P', exp: 21, entry: 1.85, exit: 0.90, qty: 2, side: 'short', dte: 21, delta: -0.30, daysAgo: 12, win: true },
      { sym: 'QQQ', under: 'QQQ', type: 'CREDIT_SPREAD', strike_short: 515, strike_long: 510, optType: 'P', exp: 14, entry: 2.10, exit: 2.65, qty: 1, side: 'short', dte: 14, delta: -0.28, daysAgo: 9, win: false },
      { sym: 'SPY', under: 'SPY', type: 'DEBIT_SPREAD', strike_short: 600, strike_long: 595, optType: 'C', exp: 30, entry: 3.20, exit: 4.80, qty: 2, side: 'long', dte: 30, delta: 0.45, daysAgo: 8, win: true },
      { sym: 'NVDA', under: 'NVDA', type: 'DEBIT_SPREAD', strike_short: 145, strike_long: 140, optType: 'C', exp: 21, entry: 4.50, exit: 3.10, qty: 1, side: 'long', dte: 21, delta: 0.42, daysAgo: 5, win: false },
      { sym: 'SPY', under: 'SPY', type: 'CALL', strike: 600, exp: 400, entry: 42.50, exit: 48.20, qty: 1, side: 'long', dte: 400, delta: 0.55, daysAgo: 14, win: true },
      { sym: 'AAPL', under: 'AAPL', type: 'PUT', strike: 200, exp: 365, entry: 18.30, exit: 15.40, qty: 1, side: 'long', dte: 365, delta: -0.35, daysAgo: 6, win: false },
    ]},
  ];

  let weIdx = 0;
  for (const strat of strategies) {
    for (const t of strat.trades) {
      const isCreditSpread = t.type === 'CREDIT_SPREAD';
      const isDebitSpread = t.type === 'DEBIT_SPREAD';
      const pnl = isCreditSpread
        ? round((t.entry - t.exit) * t.qty * 100, 2)
        : round((t.exit - t.entry) * t.qty * 100, 2);
      const pnlPct = round(((t.exit - t.entry) / t.entry) * (isCreditSpread ? -1 : 1) * 100, 4);
      const risk = isCreditSpread && t.strike_short != null && t.strike_long != null
        ? (Math.abs(t.strike_short - t.strike_long) - t.entry) * t.qty * 100
        : Math.abs(t.entry - (t.entry * (t.side === 'long' ? 0.95 : 1.05))) * t.qty * 100;
      const rMul = risk > 0 ? round(pnl / risk, 4) : null;
      const comm = round(t.qty * 0.65 * 2, 2);
      const entryTime = ts(days(t.daysAgo), 9, 35 + Math.floor(Math.random() * 20));
      const exitDay = days(t.daysAgo - 1);
      const exitTime = ts(exitDay, 14, Math.floor(Math.random() * 55));
      const expDate = new Date(days(t.daysAgo));
      expDate.setDate(expDate.getDate() + t.exp);
      const expStr = expDate.toISOString().split('T')[0].replace(/-/g, '');

      let symbol;
      if (isCreditSpread || isDebitSpread) {
        const lo = Math.min(t.strike_short, t.strike_long);
        const hi = Math.max(t.strike_short, t.strike_long);
        const typeChar = t.optType || (t.type === 'CREDIT_SPREAD' ? 'P' : 'C');
        symbol = `${t.sym} ${lo}/${hi} ${typeChar}`;
      } else {
        symbol = `${t.sym} ${expStr} ${t.type.charAt(0)} ${t.strike}`;
      }

      const tradeId = uuid();
      const posId = uuid();
      const we = webhookEvents[weIdx % webhookEvents.length];
      weIdx++;

      const trade = {
        id: tradeId,
        position_id: posId,
        user_id: USER_ID,
        symbol,
        underlying_symbol: t.under,
        contract_type: t.type,
        side: t.side,
        strategy: strat.name,
        strike: t.strike ?? (t.strike_short != null ? t.strike_short : null),
        strike_short: t.strike_short ?? null,
        strike_long: t.strike_long ?? null,
        expiration: expDate.toISOString().split('T')[0],
        entry_price: t.entry,
        exit_price: t.exit,
        quantity: t.qty,
        contract_multiplier: 100,
        entry_time: entryTime,
        exit_time: exitTime,
        pnl,
        pnl_percent: pnlPct,
        r_multiple: rMul,
        commission_total: comm,
        max_favorable_excursion: round(t.win ? t.exit * 1.05 : t.entry * 1.02, 4),
        max_adverse_excursion: round(t.win ? t.entry * 0.98 : t.exit * 1.03, 4),
        dte_at_entry: t.dte,
        delta_at_entry: t.delta,
        is_sim: true,
        webhook_event_id: we.id,
        tags: t.win ? ['winner', strat.name.split('_')[0].toLowerCase()] : ['loser', strat.name.split('_')[0].toLowerCase()],
        notes: t.win ? `Clean ${strat.name} setup. Held for target.` : `${strat.name} failed. Stopped out near support.`,
        _posId: posId,
        _entryTime: entryTime,
        _exitTime: exitTime,
        _expDate: expDate.toISOString().split('T')[0],
      };
      trades.push(trade);
    }
  }
  return trades;
}

// ── Open positions (6: single options + credit spread, debit spread, LEAP) ───
function buildOpenPositions(webhookEvents) {
  const positions = [
    { sym: 'SPY 20260315 C 595', under: 'SPY', type: 'CALL', strike: 595, exp: '2026-03-15', qty: 2, avg: 3.80, cur: 5.20, delta: 0.52, strat: 'ORB_Breakout', daysAgo: 1 },
    { sym: 'NVDA 20260320 C 140', under: 'NVDA', type: 'CALL', strike: 140, exp: '2026-03-20', qty: 3, avg: 5.40, cur: 7.10, delta: 0.55, strat: 'SIGNALS_Gamma', daysAgo: 2 },
    { sym: 'TSLA 20260315 P 350', under: 'TSLA', type: 'PUT', strike: 350, exp: '2026-03-15', qty: 1, avg: 8.30, cur: 6.90, delta: -0.48, strat: 'STRAT_Failed2', daysAgo: 1 },
    { sym: 'SPY 498/503 P', under: 'SPY', type: 'CREDIT_SPREAD', strike_short: 503, strike_long: 498, exp: '2026-04-18', qty: 2, avg: 1.95, cur: 1.20, delta: -0.28, strat: 'RevenueTarget_Spreads', daysAgo: 1 },
    { sym: 'QQQ 520/525 C', under: 'QQQ', type: 'DEBIT_SPREAD', strike_short: 525, strike_long: 520, exp: '2026-04-15', qty: 1, avg: 2.80, cur: 3.40, delta: 0.42, strat: 'RevenueTarget_Spreads', daysAgo: 2 },
    { sym: 'SPY 20260320 C 620', under: 'SPY', type: 'CALL', strike: 620, exp: '2027-03-20', qty: 1, avg: 38.50, cur: 41.20, delta: 0.58, strat: 'RevenueTarget_Spreads', daysAgo: 3 },
  ];

  return positions.map((p, i) => {
    const id = uuid();
    const isCredit = p.type === 'CREDIT_SPREAD';
    const unrealPnl = isCredit
      ? round((p.avg - p.cur) * p.qty * 100, 2)
      : round((p.cur - p.avg) * p.qty * 100, 2);
    return {
      id,
      user_id: USER_ID,
      symbol: p.sym,
      underlying_symbol: p.under,
      contract_type: p.type,
      strike: p.strike ?? p.strike_short ?? null,
      strike_short: p.strike_short ?? null,
      strike_long: p.strike_long ?? null,
      expiration: p.exp,
      quantity: p.qty,
      avg_price: p.avg,
      current_price: p.cur,
      delta_at_entry: p.delta,
      unrealized_pnl: unrealPnl,
      strategy: p.strat,
      webhook_event_id: webhookEvents[i % webhookEvents.length].id,
      status: 'OPEN',
      stop_loss: round(p.avg * 0.70, 4),
      take_profit: round(p.avg * 1.50, 4),
      trailing_stop_pct: 0.05,
      highest_price: round(p.cur * 1.02, 4),
      max_hold_hours: 168,
      opened_at: ts(days(p.daysAgo), 9, 35),
    };
  });
}

// ── Equity snapshots: daily snapshots for the curve ──────────────────────────
function buildEquitySnapshots() {
  const snapshots = [];
  let equity = 100000;
  let cash = 100000;
  let realizedPnl = 0;

  const dailyChanges = [
    520, -190, 340, 680, -320, 150, 890, -410, 270, 560,
    -180, 720, 310, -250, 480, 620, -140, 390, 210, -90,
    530, 440, -360, 680, 150, 290, -170, 810, 370
  ];

  for (let i = 28; i >= 0; i--) {
    const change = dailyChanges[28 - i] || 0;
    realizedPnl += change;
    equity += change;
    cash += change;
    const openPos = i < 3 ? Math.min(3, 28 - i) : Math.floor(Math.random() * 3) + 1;
    const unrealized = round((Math.random() - 0.3) * 500, 2);

    const snapAt = days(i);
    snapAt.setHours(16, 0, 0, 0);

    snapshots.push({
      id: uuid(),
      user_id: USER_ID,
      sim_run_id: null,
      equity: round(equity + unrealized, 2),
      cash_balance: round(cash, 2),
      unrealized_pnl: unrealized,
      realized_pnl: round(realizedPnl, 2),
      open_positions: openPos,
      snapshot_at: snapAt.toISOString(),
    });
  }
  return { snapshots, finalEquity: equity, finalCash: cash, finalRealizedPnl: realizedPnl };
}

// ── Strategy scorecard ───────────────────────────────────────────────────────
function buildScorecards() {
  return [
    { strategy: 'ORB_Breakout', total: 5, wins: 4, losses: 1, winRate: 0.8000, pf: 3.24, avgR: 1.85, avgPnl: 412.00, stdPnl: 280.50, sharpe: 1.47, streak: 2, streakType: 'win', grossWins: 3860.00, grossLosses: -1190.00, status: 'ACTIVE' },
    { strategy: 'STRAT_Failed2', total: 4, wins: 3, losses: 1, winRate: 0.7500, pf: 2.78, avgR: 1.52, avgPnl: 350.00, stdPnl: 310.20, sharpe: 1.13, streak: 1, streakType: 'win', grossWins: 3230.00, grossLosses: -1160.00, status: 'ACTIVE' },
    { strategy: 'TREND_Alignment', total: 3, wins: 2, losses: 1, winRate: 0.6667, pf: 1.92, avgR: 1.20, avgPnl: 280.00, stdPnl: 350.10, sharpe: 0.80, streak: 1, streakType: 'win', grossWins: 1920.00, grossLosses: -1000.00, status: 'ACTIVE' },
    { strategy: 'SIGNALS_Gamma', total: 3, wins: 2, losses: 1, winRate: 0.6667, pf: 2.15, avgR: 1.35, avgPnl: 390.00, stdPnl: 420.80, sharpe: 0.93, streak: 1, streakType: 'win', grossWins: 2380.00, grossLosses: -1110.00, status: 'ACTIVE' },
    { strategy: 'SATY_Markup', total: 2, wins: 2, losses: 0, winRate: 1.0000, pf: 99.99, avgR: 2.10, avgPnl: 510.00, stdPnl: 180.30, sharpe: 2.83, streak: 2, streakType: 'win', grossWins: 1020.00, grossLosses: 0, status: 'ACTIVE' },
  ];
}

// ── Signal rejections ────────────────────────────────────────────────────────
function buildRejections(webhookEvents) {
  return [
    { symbol: 'AMZN', strategy: 'SIGNALS_Gamma', action: 'BUY', reason: 'Signal score 55 below threshold 60', gate: 'signal_quality', score: 55, eventId: webhookEvents[webhookEvents.length - 1].id, daysAgo: 1 },
    { symbol: 'GOOGL', strategy: 'ORB_Breakout', action: 'BUY', reason: 'Strategy on cooldown after 3 consecutive losses', gate: 'strategy_cooldown', score: 78, eventId: null, daysAgo: 4 },
    { symbol: 'AMD', strategy: 'TREND_Alignment', action: 'BUY', reason: 'Max correlated positions reached (3/3)', gate: 'correlation_limit', score: 82, eventId: null, daysAgo: 6 },
    { symbol: 'NFLX', strategy: 'STRAT_Failed2', action: 'BUY', reason: 'Drawdown throttle active (50% of peak equity)', gate: 'drawdown_throttle', score: 71, eventId: null, daysAgo: 8 },
    { symbol: 'COIN', strategy: 'SIGNALS_Gamma', action: 'SELL', reason: 'Kill switch active', gate: 'kill_switch', score: 90, eventId: null, daysAgo: 10 },
  ];
}

// ── Intelligence verdicts: trade decisions (traded + blocked) ────────────────
function buildIntelligenceVerdicts(webhookEvents, simTrades) {
  const verdicts = [];

  // Map webhook_event_id → sim_trade for easy lookup
  const tradeByWebhookId = {};
  for (const t of simTrades) {
    tradeByWebhookId[t.webhook_event_id] = t;
  }

  // Traded verdicts — signals that were approved and executed
  const tradedSignals = [
    { sym: 'SPY',  dir: 'LONG',  strat: 'ORB_Breakout',    score: 82, conf: 88, confluence: 4, flow: 'bullish',  flowRatio: 68, daysAgo: 14 },
    { sym: 'QQQ',  dir: 'LONG',  strat: 'ORB_Breakout',    score: 71, conf: 72, confluence: 3, flow: 'bullish',  flowRatio: 55, daysAgo: 12 },
    { sym: 'AAPL', dir: 'SHORT', strat: 'ORB_Breakout',    score: 78, conf: 80, confluence: 3, flow: 'bearish',  flowRatio: 38, daysAgo: 10 },
    { sym: 'NVDA', dir: 'LONG',  strat: 'ORB_Breakout',    score: 85, conf: 83, confluence: 4, flow: 'bullish',  flowRatio: 72, daysAgo: 8 },
    { sym: 'TSLA', dir: 'SHORT', strat: 'ORB_Breakout',    score: 76, conf: 78, confluence: 3, flow: 'bearish',  flowRatio: 35, daysAgo: 5 },
    { sym: 'SPY',  dir: 'LONG',  strat: 'STRAT_Failed2',   score: 88, conf: 90, confluence: 5, flow: 'bullish',  flowRatio: 74, daysAgo: 13 },
    { sym: 'MSFT', dir: 'LONG',  strat: 'STRAT_Failed2',   score: 69, conf: 65, confluence: 3, flow: 'neutral',  flowRatio: 50, daysAgo: 11 },
    { sym: 'AMZN', dir: 'SHORT', strat: 'STRAT_Failed2',   score: 83, conf: 85, confluence: 4, flow: 'bearish',  flowRatio: 32, daysAgo: 7 },
    { sym: 'META', dir: 'LONG',  strat: 'STRAT_Failed2',   score: 91, conf: 92, confluence: 5, flow: 'bullish',  flowRatio: 78, daysAgo: 3 },
    { sym: 'SPY',  dir: 'LONG',  strat: 'TREND_Alignment', score: 80, conf: 82, confluence: 4, flow: 'bullish',  flowRatio: 65, daysAgo: 9 },
    { sym: 'QQQ',  dir: 'SHORT', strat: 'TREND_Alignment', score: 62, conf: 60, confluence: 2, flow: 'bearish',  flowRatio: 42, daysAgo: 6 },
    { sym: 'NVDA', dir: 'LONG',  strat: 'TREND_Alignment', score: 86, conf: 84, confluence: 4, flow: 'bullish',  flowRatio: 70, daysAgo: 4 },
    { sym: 'SPY',  dir: 'LONG',  strat: 'SIGNALS_Gamma',   score: 92, conf: 88, confluence: 5, flow: 'bullish',  flowRatio: 76, daysAgo: 10 },
    { sym: 'NVDA', dir: 'LONG',  strat: 'SIGNALS_Gamma',   score: 72, conf: 70, confluence: 3, flow: 'bullish',  flowRatio: 58, daysAgo: 7 },
    { sym: 'TSLA', dir: 'SHORT', strat: 'SIGNALS_Gamma',   score: 87, conf: 85, confluence: 4, flow: 'bearish',  flowRatio: 30, daysAgo: 3 },
    { sym: 'SPY',  dir: 'LONG',  strat: 'SATY_Markup',     score: 79, conf: 80, confluence: 3, flow: 'bullish',  flowRatio: 62, daysAgo: 11 },
    { sym: 'AAPL', dir: 'SHORT', strat: 'SATY_Markup',     score: 81, conf: 82, confluence: 4, flow: 'bearish',  flowRatio: 36, daysAgo: 6 },
  ];

  for (let i = 0; i < tradedSignals.length; i++) {
    const s = tradedSignals[i];
    const we = webhookEvents[i % webhookEvents.length];
    const at = days(s.daysAgo);
    at.setHours(9, 32 + Math.floor(Math.random() * 25), Math.floor(Math.random() * 59));

    verdicts.push({
      id: uuid(),
      user_id: USER_ID,
      webhook_event_id: we.id,
      symbol: s.sym,
      direction: s.dir,
      strategy: s.strat,
      intelligence_score: s.score,
      allowed: true,
      rejection_reason: null,
      confluence_count: s.confluence,
      flow_alignment: s.flow,
      flow_bullish_ratio: s.flowRatio,
      signal_confidence: s.conf,
      price_delta_pct: round((Math.random() - 0.3) * 2, 4),
      checks_detail: JSON.stringify({
        action: s.dir === 'LONG' ? 'BUY_CALL' : 'BUY_PUT',
        rationale: [
          `+ ${s.strat} setup confirmed on ${s.sym}`,
          `+ Confluence ${s.confluence}/5 — ${s.flow} flow alignment (${s.flowRatio}%)`,
          s.score >= 80 ? `+ High conviction score ${s.score}` : `~ Moderate conviction ${s.score}`,
          s.conf >= 80 ? '+ Strong signal confidence' : '~ Acceptable signal quality',
          s.confluence >= 4 ? '+ Multi-timeframe alignment strong' : '- Partial timeframe alignment',
        ],
        delta_target: s.dir === 'LONG' ? 0.50 : -0.48,
        dte_target: 5,
        size_multiplier: s.score >= 85 ? 1.5 : 1.0,
        risk_parameters: {
          stop_source: 'technical',
          stop_level: round(s.dir === 'LONG' ? 590 * 0.97 : 360 * 1.03, 2),
          max_loss_pct: 0.02,
        },
      }),
      created_at: at.toISOString(),
    });
  }

  // Blocked verdicts — signals the engine rejected
  const blockedSignals = [
    { sym: 'AMZN', dir: 'LONG',  strat: 'SIGNALS_Gamma',   score: 55, conf: 50, reason: 'Signal score 55 below minimum threshold 60', gate: 'signal_quality', daysAgo: 1 },
    { sym: 'GOOGL', dir: 'LONG', strat: 'ORB_Breakout',    score: 78, conf: 75, reason: 'Strategy on cooldown after 3 consecutive losses', gate: 'strategy_cooldown', daysAgo: 4 },
    { sym: 'AMD',  dir: 'LONG',  strat: 'TREND_Alignment', score: 82, conf: 80, reason: 'Max correlated positions reached (3/3 tech sector)', gate: 'correlation_limit', daysAgo: 6 },
    { sym: 'NFLX', dir: 'LONG',  strat: 'STRAT_Failed2',  score: 71, conf: 68, reason: 'Drawdown throttle active — equity at 50% of peak', gate: 'drawdown_throttle', daysAgo: 8 },
    { sym: 'COIN', dir: 'SHORT', strat: 'SIGNALS_Gamma',   score: 90, conf: 88, reason: 'Kill switch active — all trading paused', gate: 'kill_switch', daysAgo: 10 },
    { sym: 'MSFT', dir: 'LONG',  strat: 'ORB_Breakout',    score: 45, conf: 42, reason: 'Conviction score 45 below minimum 60', gate: 'conviction_threshold', daysAgo: 2 },
    { sym: 'TSLA', dir: 'LONG',  strat: 'STRAT_Failed2',   score: 68, conf: 65, reason: 'Daily loss limit reached ($-500 max daily loss)', gate: 'daily_loss_limit', daysAgo: 5 },
    { sym: 'SPY',  dir: 'SHORT', strat: 'TREND_Alignment', score: 58, conf: 55, reason: 'Signal confidence 55 below threshold 60', gate: 'signal_quality', daysAgo: 3 },
    { sym: 'NVDA', dir: 'LONG',  strat: 'SATY_Markup',     score: 74, conf: 72, reason: 'Max open positions reached (5/5)', gate: 'position_limit', daysAgo: 7 },
    { sym: 'QQQ',  dir: 'SHORT', strat: 'SIGNALS_Gamma',   score: 63, conf: 58, reason: 'Bearish flow alignment insufficient (ratio 48%)', gate: 'flow_alignment', daysAgo: 9 },
    { sym: 'AAPL', dir: 'LONG',  strat: 'ORB_Breakout',    score: 77, conf: 74, reason: 'Strategy on cooldown after recent loss streak', gate: 'strategy_cooldown', daysAgo: 12 },
    { sym: 'META', dir: 'SHORT', strat: 'TREND_Alignment', score: 61, conf: 58, reason: 'Insufficient confluence (2/5 required minimum 3)', gate: 'confluence_minimum', daysAgo: 11 },
  ];

  for (let i = 0; i < blockedSignals.length; i++) {
    const s = blockedSignals[i];
    const we = webhookEvents[(tradedSignals.length + i) % webhookEvents.length];
    const at = days(s.daysAgo);
    at.setHours(9, 32 + Math.floor(Math.random() * 25), Math.floor(Math.random() * 59));

    verdicts.push({
      id: uuid(),
      user_id: USER_ID,
      webhook_event_id: we.id,
      symbol: s.sym,
      direction: s.dir,
      strategy: s.strat,
      intelligence_score: s.score,
      allowed: false,
      rejection_reason: s.reason,
      confluence_count: Math.floor(Math.random() * 3) + 1,
      flow_alignment: s.dir === 'LONG' ? 'neutral' : 'bearish',
      flow_bullish_ratio: s.dir === 'LONG' ? 45 + Math.floor(Math.random() * 10) : 30 + Math.floor(Math.random() * 15),
      signal_confidence: s.conf,
      price_delta_pct: round((Math.random() - 0.5) * 3, 4),
      checks_detail: JSON.stringify({
        action: 'BLOCKED',
        rationale: [
          `- BLOCKED at gate: ${s.gate}`,
          `- ${s.reason}`,
          `~ Signal score: ${s.score}, confidence: ${s.conf}`,
          s.score >= 70 ? '+ Score would have qualified if gate passed' : '- Score also below preferred threshold',
        ],
        gate: s.gate,
      }),
      created_at: at.toISOString(),
    });
  }

  return verdicts;
}

// ── Revenue target decision log (gate/sizer audit trail) ──────────────────────
function buildRevenueTargetDecisions(simTrades, webhookEvents) {
  const decisions = [];
  const now = new Date();

  // Sample decisions: mix of OPEN/CLOSE, allowed/blocked, various sizing, trade types
  const templates = [
    { action: 'OPEN', instrumentDesc: 'SPY 515C', reason: 'open', sizeMultiplier: 0.5, decision: 'ALLOWED', tradeType: 'CREDIT_SPREAD' },
    { action: 'OPEN', instrumentDesc: 'QQQ 430P', reason: 'open', sizeMultiplier: 0.75, decision: 'ALLOWED', tradeType: 'CREDIT_SPREAD' },
    { action: 'CLOSE', instrumentDesc: 'IWM 195C', reason: 'exempt - close leg', sizeMultiplier: 1, decision: 'ALLOWED', tradeType: null },
    { action: 'OPEN', instrumentDesc: 'SPY 510P', reason: 'closed - target met', sizeMultiplier: 0, decision: 'BLOCKED', tradeType: 'CREDIT_SPREAD' },
    { action: 'OPEN', instrumentDesc: 'SPY 590C', reason: 'open', sizeMultiplier: 0.5, decision: 'ALLOWED', tradeType: 'CREDIT_SPREAD' },
    { action: 'OPEN', instrumentDesc: 'QQQ 515C', reason: 'open', sizeMultiplier: 0.75, decision: 'ALLOWED', tradeType: 'DEBIT_SPREAD' },
    { action: 'CLOSE', instrumentDesc: 'AAPL 230P', reason: 'exempt - close leg', sizeMultiplier: 1, decision: 'ALLOWED', tradeType: null },
    { action: 'OPEN', instrumentDesc: 'NVDA 135C', reason: 'open', sizeMultiplier: 0.5, decision: 'ALLOWED', tradeType: 'LEAP' },
    { action: 'CLOSE', instrumentDesc: 'TSLA 360P', reason: 'exempt - close leg', sizeMultiplier: 1, decision: 'ALLOWED', tradeType: null },
    { action: 'OPEN', instrumentDesc: 'SPY 592C', reason: 'closed - target met', sizeMultiplier: 0, decision: 'BLOCKED', tradeType: 'CREDIT_SPREAD' },
  ];

  for (let i = 0; i < templates.length; i++) {
    const tpl = templates[i];
    const createdAt = new Date(now);
    createdAt.setMinutes(createdAt.getMinutes() - (templates.length - i) * 8);

    let webhookEventId = null;
    if (i < simTrades.length && tpl.decision === 'ALLOWED') {
      webhookEventId = simTrades[i].webhook_event_id;
    } else if (tpl.decision === 'BLOCKED' && webhookEvents.length > 0) {
      webhookEventId = webhookEvents[webhookEvents.length - 1].id;
    }

    decisions.push({
      user_id: USER_ID,
      created_at: createdAt.toISOString(),
      symbol: tpl.instrumentDesc.split(' ')[0],
      action: tpl.action,
      instrument_desc: tpl.instrumentDesc,
      decision: tpl.decision,
      reason: tpl.reason,
      size_multiplier: tpl.sizeMultiplier,
      trade_type: tpl.tradeType || null,
      webhook_event_id: webhookEventId,
    });
  }
  return decisions;
}

// ── Sim run ──────────────────────────────────────────────────────────────────
function buildSimRun() {
  return {
    id: uuid(),
    user_id: USER_ID,
    symbol: 'SPY',
    strategy: 'ORB_Breakout',
    timeframe: '5m',
    start_date: days(30).toISOString().split('T')[0],
    end_date: days(0).toISOString().split('T')[0],
    config_snapshot: { slippage: 0.001, commission: 0.65, initial_balance: 100000, signal_threshold: 60 },
    total_trades: 17,
    winning_trades: 13,
    losing_trades: 4,
    total_pnl: 8720.00,
    max_drawdown: 1850.00,
    win_rate: 0.7647,
    avg_r_multiple: 1.52,
    sharpe_ratio: 1.38,
    profit_factor: 2.85,
    status: 'COMPLETED',
    started_at: days(30).toISOString(),
    completed_at: days(0).toISOString(),
  };
}

async function seed() {
  const client = await pool.connect();
  try {
    if (!USER_ID) {
      const r = await client.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
      if (!r.rows.length) {
        console.error('No users in database. Create a user first (register/login).');
        process.exit(1);
      }
      USER_ID = r.rows[0].id;
      console.log(`Using user: ${USER_ID}`);
    }

    await client.query('BEGIN');

    // Clean existing sim seed data
    console.log('Cleaning existing sim data...');
    await client.query(`DELETE FROM intelligence_verdicts WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM signal_rejections WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM strategy_cooldowns WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM strategy_scorecard WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM sim_equity_snapshots WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM sim_fills WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM sim_trades WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM sim_orders WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM sim_positions WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM sim_runs WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM sim_account_state WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM revenue_target_decisions WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM sim_intelligence_config WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM webhook_events WHERE user_id = $1`, [USER_ID]);

    // 1. Webhook events
    console.log('Seeding webhook events...');
    const webhookEvents = buildWebhookEvents();
    for (const e of webhookEvents) {
      await client.query(
        `INSERT INTO webhook_events (id, received_at, source, raw_payload, signature_valid, dedupe_key, status, error_message, processed_at, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [e.id, e.received_at, e.source, JSON.stringify(e.raw_payload), e.signature_valid, e.dedupe_key, e.status, e.error_message, e.processed_at, e.user_id]
      );
    }
    console.log(`  ✓ ${webhookEvents.length} webhook events`);

    // 2. Sim account state
    console.log('Seeding sim account state...');
    const { snapshots, finalEquity, finalCash, finalRealizedPnl } = buildEquitySnapshots();
    const openPositions = buildOpenPositions(webhookEvents);
    const totalUnrealPnl = openPositions.reduce((s, p) => s + p.unrealized_pnl, 0);

    await client.query(
      `INSERT INTO sim_account_state (id, user_id, cash_balance, buying_power, margin_used, equity, unrealized_pnl, realized_pnl, peak_equity, max_drawdown, daily_pnl, kill_switch_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [uuid(), USER_ID, round(finalCash, 2), round(finalCash * 0.85, 2), round(totalUnrealPnl * 0.15, 2), round(finalEquity + totalUnrealPnl, 2), round(totalUnrealPnl, 2), round(finalRealizedPnl, 2), round(finalEquity + 810, 2), 1850.00, round(snapshots[snapshots.length - 1].realized_pnl - (snapshots.length > 1 ? snapshots[snapshots.length - 2].realized_pnl : 0), 2), false]
    );
    console.log('  ✓ sim account state');

    // 3. Sim trades (closed positions)
    console.log('Seeding sim trades...');
    const simTrades = buildSimTrades(webhookEvents);
    for (const t of simTrades) {
      // Closed position
      await client.query(
        `INSERT INTO sim_positions (id, user_id, symbol, underlying_symbol, contract_type, strike, strike_short, strike_long, expiration, quantity, avg_price, current_price, delta_at_entry, unrealized_pnl, strategy, webhook_event_id, status, opened_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'CLOSED',$17,$18)`,
        [t._posId, USER_ID, t.symbol, t.underlying_symbol, t.contract_type, t.strike, t.strike_short, t.strike_long, t._expDate, t.quantity, t.entry_price, t.exit_price, t.delta_at_entry, 0, t.strategy, t.webhook_event_id, t._entryTime, t._exitTime]
      );

      // Order (entry)
      const entryOrderId = uuid();
      await client.query(
        `INSERT INTO sim_orders (id, user_id, webhook_event_id, position_id, intent_payload, side, order_type, symbol, contract_type, quantity, status)
         VALUES ($1,$2,$3,$4,$5,$6,'MARKET',$7,$8,$9,'FILLED')`,
        [entryOrderId, USER_ID, t.webhook_event_id, t._posId, JSON.stringify({ action: 'BUY', symbol: t.underlying_symbol, strategy: t.strategy }), 'BUY', t.symbol, t.contract_type, t.quantity]
      );

      // Fill (entry)
      const entryFillId = uuid();
      await client.query(
        `INSERT INTO sim_fills (id, order_id, user_id, fill_price, quantity, slippage_applied, commission, contract_multiplier, notional_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,100,$8)`,
        [entryFillId, entryOrderId, USER_ID, t.entry_price, t.quantity, 0.001, round(t.quantity * 0.65, 2), round(t.entry_price * t.quantity * 100, 2)]
      );

      // Order (exit)
      const exitOrderId = uuid();
      await client.query(
        `INSERT INTO sim_orders (id, user_id, webhook_event_id, position_id, intent_payload, side, order_type, symbol, contract_type, quantity, status)
         VALUES ($1,$2,$3,$4,$5,$6,'MARKET',$7,$8,$9,'FILLED')`,
        [exitOrderId, USER_ID, t.webhook_event_id, t._posId, JSON.stringify({ action: 'SELL', symbol: t.underlying_symbol, strategy: t.strategy }), 'SELL', t.symbol, t.contract_type, t.quantity]
      );

      // Fill (exit)
      await client.query(
        `INSERT INTO sim_fills (id, order_id, user_id, fill_price, quantity, slippage_applied, commission, contract_multiplier, notional_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,100,$8)`,
        [uuid(), exitOrderId, USER_ID, t.exit_price, t.quantity, 0.001, round(t.quantity * 0.65, 2), round(t.exit_price * t.quantity * 100, 2)]
      );

      // Sim trade record (30 columns: id through notes)
      await client.query(
        `INSERT INTO sim_trades (id, user_id, position_id, symbol, underlying_symbol, contract_type, side, strategy, strike, strike_short, strike_long, expiration, entry_price, exit_price, quantity, contract_multiplier, entry_time, exit_time, pnl, pnl_percent, r_multiple, commission_total, max_favorable_excursion, max_adverse_excursion, dte_at_entry, delta_at_entry, is_sim, webhook_event_id, tags, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,100,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,true,$26,$27,$28)`,
        [t.id, USER_ID, t._posId, t.symbol, t.underlying_symbol, t.contract_type, t.side, t.strategy, t.strike, t.strike_short, t.strike_long, t.expiration, t.entry_price, t.exit_price, t.quantity, t.entry_time, t.exit_time, t.pnl, t.pnl_percent, t.r_multiple, t.commission_total, t.max_favorable_excursion, t.max_adverse_excursion, t.dte_at_entry, t.delta_at_entry, t.webhook_event_id, `{${t.tags.join(',')}}`, t.notes]
      );
    }
    console.log(`  ✓ ${simTrades.length} sim trades (with positions, orders, fills)`);

    // 4. Open positions
    console.log('Seeding open positions...');
    for (const p of openPositions) {
      await client.query(
        `INSERT INTO sim_positions (id, user_id, symbol, underlying_symbol, contract_type, strike, strike_short, strike_long, expiration, quantity, avg_price, current_price, delta_at_entry, unrealized_pnl, strategy, webhook_event_id, status, stop_loss, take_profit, trailing_stop_pct, highest_price, max_hold_hours, opened_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'OPEN',$17,$18,$19,$20,$21,$22)`,
        [p.id, USER_ID, p.symbol, p.underlying_symbol, p.contract_type, p.strike, p.strike_short, p.strike_long, p.expiration, p.quantity, p.avg_price, p.current_price, p.delta_at_entry, p.unrealized_pnl, p.strategy, p.webhook_event_id, p.stop_loss, p.take_profit, p.trailing_stop_pct, p.highest_price, p.max_hold_hours, p.opened_at]
      );

      // Entry order for open position
      const orderId = uuid();
      await client.query(
        `INSERT INTO sim_orders (id, user_id, webhook_event_id, position_id, intent_payload, side, order_type, symbol, contract_type, quantity, status)
         VALUES ($1,$2,$3,$4,$5,'BUY','MARKET',$6,$7,$8,'FILLED')`,
        [orderId, USER_ID, p.webhook_event_id, p.id, JSON.stringify({ action: 'BUY', symbol: p.underlying_symbol, strategy: p.strategy }), p.symbol, p.contract_type, p.quantity]
      );

      await client.query(
        `INSERT INTO sim_fills (id, order_id, user_id, fill_price, quantity, slippage_applied, commission, contract_multiplier, notional_value)
         VALUES ($1,$2,$3,$4,$5,0.001,$6,100,$7)`,
        [uuid(), orderId, USER_ID, p.avg_price, p.quantity, round(p.quantity * 0.65, 2), round(p.avg_price * p.quantity * 100, 2)]
      );
    }
    console.log(`  ✓ ${openPositions.length} open positions`);

    // 5. Equity snapshots
    console.log('Seeding equity curve...');
    for (const s of snapshots) {
      await client.query(
        `INSERT INTO sim_equity_snapshots (id, user_id, sim_run_id, equity, cash_balance, unrealized_pnl, realized_pnl, open_positions, snapshot_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [s.id, USER_ID, s.sim_run_id, s.equity, s.cash_balance, s.unrealized_pnl, s.realized_pnl, s.open_positions, s.snapshot_at]
      );
    }
    console.log(`  ✓ ${snapshots.length} equity snapshots`);

    // 6. Sim run
    console.log('Seeding sim run...');
    const simRun = buildSimRun();
    await client.query(
      `INSERT INTO sim_runs (id, user_id, symbol, strategy, timeframe, start_date, end_date, config_snapshot, total_trades, winning_trades, losing_trades, total_pnl, max_drawdown, win_rate, avg_r_multiple, sharpe_ratio, profit_factor, status, started_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [simRun.id, USER_ID, simRun.symbol, simRun.strategy, simRun.timeframe, simRun.start_date, simRun.end_date, JSON.stringify(simRun.config_snapshot), simRun.total_trades, simRun.winning_trades, simRun.losing_trades, simRun.total_pnl, simRun.max_drawdown, simRun.win_rate, simRun.avg_r_multiple, simRun.sharpe_ratio, simRun.profit_factor, simRun.status, simRun.started_at, simRun.completed_at]
    );
    console.log('  ✓ 1 sim run');

    // 7. Strategy scorecards
    console.log('Seeding strategy scorecards...');
    const scorecards = buildScorecards();
    for (const sc of scorecards) {
      await client.query(
        `INSERT INTO strategy_scorecard (id, user_id, strategy, window_size, total_trades, winning_trades, losing_trades, win_rate, profit_factor, avg_r_multiple, avg_pnl, stddev_pnl, sharpe_ratio, current_streak, streak_type, gross_wins, gross_losses, status)
         VALUES ($1,$2,$3,20,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [uuid(), USER_ID, sc.strategy, sc.total, sc.wins, sc.losses, sc.winRate, sc.pf, sc.avgR, sc.avgPnl, sc.stdPnl, sc.sharpe, sc.streak, sc.streakType, sc.grossWins, sc.grossLosses, sc.status]
      );
    }
    console.log(`  ✓ ${scorecards.length} strategy scorecards`);

    // 8. Signal rejections
    console.log('Seeding signal rejections...');
    const rejections = buildRejections(webhookEvents);
    for (const r of rejections) {
      const at = days(r.daysAgo);
      at.setHours(9, 35 + Math.floor(Math.random() * 25));
      await client.query(
        `INSERT INTO signal_rejections (id, user_id, webhook_event_id, symbol, strategy, action, reason, gate, signal_score, raw_signal, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [uuid(), USER_ID, r.eventId, r.symbol, r.strategy, r.action, r.reason, r.gate, r.score, JSON.stringify({ ticker: r.symbol, score: r.score }), at.toISOString()]
      );
    }
    console.log(`  ✓ ${rejections.length} signal rejections`);

    // 9. Intelligence verdicts (traded + blocked signals)
    console.log('Seeding intelligence verdicts...');
    const verdicts = buildIntelligenceVerdicts(webhookEvents, simTrades);
    for (const v of verdicts) {
      await client.query(
        `INSERT INTO intelligence_verdicts (id, user_id, webhook_event_id, symbol, direction, strategy, intelligence_score, allowed, rejection_reason, confluence_count, flow_alignment, flow_bullish_ratio, signal_confidence, price_delta_pct, checks_detail, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [v.id, v.user_id, v.webhook_event_id, v.symbol, v.direction, v.strategy, v.intelligence_score, v.allowed, v.rejection_reason, v.confluence_count, v.flow_alignment, v.flow_bullish_ratio, v.signal_confidence, v.price_delta_pct, v.checks_detail, v.created_at]
      );
    }
    console.log(`  ✓ ${verdicts.length} intelligence verdicts (${verdicts.filter(v => v.allowed).length} traded, ${verdicts.filter(v => !v.allowed).length} blocked)`);

    // 10. Revenue target decision log
    console.log('Seeding revenue target decision log...');
    const revenueDecisions = buildRevenueTargetDecisions(simTrades, webhookEvents);
    for (const d of revenueDecisions) {
      await client.query(
        `INSERT INTO revenue_target_decisions (user_id, created_at, symbol, action, instrument_desc, decision, reason, size_multiplier, trade_type, webhook_event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [d.user_id, d.created_at, d.symbol, d.action, d.instrument_desc, d.decision, d.reason, d.size_multiplier, d.trade_type, d.webhook_event_id]
      );
    }
    console.log(`  ✓ ${revenueDecisions.length} revenue target decisions`);

    // 11. Intelligence config
    console.log('Seeding intelligence config...');
    await client.query(
      `INSERT INTO sim_intelligence_config (id, user_id, min_win_rate, min_profit_factor, scorecard_window, enable_signal_priority, enable_exit_monitor, exit_check_interval_ms, default_trailing_stop_pct, default_max_hold_hours, force_close_at_dte_zero, enable_strategy_cooldown, cooldown_consecutive_losses, cooldown_duration_minutes, max_correlated_positions, enable_drawdown_throttle, drawdown_throttle_pct)
       VALUES ($1,$2,0.40,1.0,20,true,true,15000,0.05,168,true,true,3,60,3,true,0.50)`,
      [uuid(), USER_ID]
    );
    console.log('  ✓ intelligence config');

    await client.query('COMMIT');

    // Summary
    const counts = {};
    for (const table of ['webhook_events', 'sim_account_state', 'sim_positions', 'sim_orders', 'sim_fills', 'sim_trades', 'sim_runs', 'sim_equity_snapshots', 'strategy_scorecard', 'signal_rejections', 'intelligence_verdicts', 'revenue_target_decisions', 'sim_intelligence_config']) {
      const r = await client.query(`SELECT COUNT(*) as c FROM ${table} WHERE user_id = $1`, [USER_ID]);
      counts[table] = r.rows[0].c;
    }
    console.log('\n=== SEED COMPLETE ===');
    console.log(JSON.stringify(counts, null, 2));

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('SEED FAILED:', err.message);
    console.error(err.stack);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));
