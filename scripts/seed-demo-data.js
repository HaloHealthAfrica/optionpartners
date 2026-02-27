#!/usr/bin/env node
/**
 * Seed demo data across the TradePartners platform.
 * Usage: node scripts/seed-demo-data.js <BASE_URL> <JWT_TOKEN>
 */

const BASE = process.argv[2] || 'https://optionpartners.fly.dev';
const TOKEN = process.argv[3];
if (!TOKEN) { console.error('Usage: node seed-demo-data.js <BASE_URL> <JWT_TOKEN>'); process.exit(1); }

const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

async function api(method, path, body) {
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  const status = res.status;
  if (status >= 400) console.warn(`  [${status}] ${method} ${path}: ${typeof data === 'object' ? JSON.stringify(data).slice(0, 120) : data}`);
  else console.log(`  [${status}] ${method} ${path}`);
  return { status, data };
}

function days(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function fmt(d) { return d.toISOString().split('T')[0]; }
function ts(d, h = 10, m = 0) { const c = new Date(d); c.setHours(h, m, 0, 0); return c.toISOString(); }
function round(v, dp = 2) { return Math.round(v * 10 ** dp) / 10 ** dp; }

// ─── Tags ────────────────────────────────────────────────────────────────────
const TAG_DEFS = [
  { name: 'Momentum', color: '#3B82F6' },
  { name: 'Breakout', color: '#10B981' },
  { name: 'Swing', color: '#8B5CF6' },
  { name: 'Scalp', color: '#F59E0B' },
  { name: 'Earnings', color: '#EF4444' },
  { name: 'Reversal', color: '#EC4899' },
  { name: 'Gap Fill', color: '#06B6D4' },
  { name: 'VWAP', color: '#6366F1' },
];

// ─── Closed stock trades ─────────────────────────────────────────────────────
const STOCK_TRADES = [
  { symbol: 'AAPL', daysAgo: 55, side: 'long', entry: 242.50, exit: 249.80, qty: 50, strategy: 'Momentum', tags: ['Momentum'], notes: 'Strong momentum after earnings beat. Entered on pullback to 20 EMA.' },
  { symbol: 'MSFT', daysAgo: 52, side: 'long', entry: 415.20, exit: 408.10, qty: 30, strategy: 'Breakout', tags: ['Breakout'], notes: 'False breakout above resistance. Stopped out below entry.' },
  { symbol: 'TSLA', daysAgo: 48, side: 'long', entry: 388.00, exit: 411.50, qty: 40, strategy: 'Swing', tags: ['Swing', 'Momentum'], notes: 'Multi-day swing after bounce off 200 SMA. Great risk/reward.' },
  { symbol: 'NVDA', daysAgo: 45, side: 'long', entry: 175.00, exit: 184.30, qty: 50, strategy: 'Momentum', tags: ['Momentum'], notes: 'AI hype continuation. Rode the trend with trailing stop.' },
  { symbol: 'SPY', daysAgo: 42, side: 'short', entry: 592.80, exit: 588.20, qty: 100, strategy: 'Reversal', tags: ['Reversal', 'VWAP'], notes: 'Shorted at VWAP rejection after gap up failed.' },
  { symbol: 'AMD', daysAgo: 39, side: 'long', entry: 118.50, exit: 112.30, qty: 60, strategy: 'Breakout', tags: ['Breakout'], notes: 'Breakout failed. Sector rotation out of semis.' },
  { symbol: 'META', daysAgo: 36, side: 'long', entry: 605.00, exit: 628.40, qty: 20, strategy: 'Swing', tags: ['Swing'], notes: 'Swing trade on social media sector strength. Clean trend.' },
  { symbol: 'GOOGL', daysAgo: 33, side: 'long', entry: 195.20, exit: 202.80, qty: 80, strategy: 'Momentum', tags: ['Momentum', 'Breakout'], notes: 'Breakout from bull flag. Volume confirmed.' },
  { symbol: 'AMZN', daysAgo: 30, side: 'long', entry: 236.50, exit: 233.20, qty: 50, strategy: 'Gap Fill', tags: ['Gap Fill'], notes: 'Gap fill trade that didn\'t work. Gap filled but reversed.' },
  { symbol: 'QQQ', daysAgo: 28, side: 'long', entry: 518.00, exit: 532.10, qty: 40, strategy: 'Momentum', tags: ['Momentum'], notes: 'Tech sector momentum trade. Held through minor pullback.' },
  { symbol: 'JPM', daysAgo: 25, side: 'long', entry: 258.40, exit: 265.60, qty: 50, strategy: 'Swing', tags: ['Swing', 'Earnings'], notes: 'Pre-earnings positioning. Financials showing relative strength.' },
  { symbol: 'AAPL', daysAgo: 22, side: 'long', entry: 252.10, exit: 249.50, qty: 40, strategy: 'Scalp', tags: ['Scalp'], notes: 'Quick scalp attempt on opening range. Market sold off hard.' },
  { symbol: 'NVDA', daysAgo: 20, side: 'long', entry: 180.00, exit: 189.70, qty: 40, strategy: 'Momentum', tags: ['Momentum'], notes: 'Second entry on NVDA. Continuation move on high volume.' },
  { symbol: 'SPY', daysAgo: 18, side: 'long', entry: 595.30, exit: 602.80, qty: 80, strategy: 'Breakout', tags: ['Breakout', 'VWAP'], notes: 'Breakout above range on FOMC day. Clean follow-through.' },
  { symbol: 'TSLA', daysAgo: 15, side: 'short', entry: 415.00, exit: 408.40, qty: 30, strategy: 'Reversal', tags: ['Reversal'], notes: 'Reversal at upper Bollinger. Overbought conditions.' },
  { symbol: 'COIN', daysAgo: 12, side: 'long', entry: 275.00, exit: 268.50, qty: 25, strategy: 'Momentum', tags: ['Momentum'], notes: 'Crypto sector play. BTC pulled back and dragged COIN down.' },
  { symbol: 'DIS', daysAgo: 10, side: 'long', entry: 112.30, exit: 118.90, qty: 70, strategy: 'Swing', tags: ['Swing', 'Earnings'], notes: 'Post-earnings swing. Streaming numbers beat expectations.' },
  { symbol: 'NFLX', daysAgo: 8, side: 'long', entry: 1005.00, exit: 1022.40, qty: 10, strategy: 'Momentum', tags: ['Momentum'], notes: 'Riding momentum into new highs. Strong subscriber growth narrative.' },
  { symbol: 'AMD', daysAgo: 5, side: 'long', entry: 108.20, exit: 115.90, qty: 50, strategy: 'Breakout', tags: ['Breakout'], notes: 'Breakout from consolidation pattern. AI chip demand thesis.' },
  { symbol: 'PLTR', daysAgo: 3, side: 'long', entry: 104.50, exit: 101.80, qty: 200, strategy: 'Scalp', tags: ['Scalp'], notes: 'Quick scalp that went against me. Cut losses quickly.' },
];

// ─── Closed option trades ────────────────────────────────────────────────────
const OPTION_TRADES = [
  { symbol: 'SPY', daysAgo: 50, side: 'long', entry: 4.20, exit: 7.85, qty: 10, optionType: 'call', strike: 595, dte: 14, strategy: 'Momentum', tags: ['Momentum'], notes: 'SPY calls on breakout. Great timing.' },
  { symbol: 'AAPL', daysAgo: 44, side: 'long', entry: 3.50, exit: 1.80, qty: 5, optionType: 'call', strike: 255, dte: 21, strategy: 'Earnings', tags: ['Earnings'], notes: 'Pre-earnings calls. IV crush destroyed the premium.' },
  { symbol: 'TSLA', daysAgo: 40, side: 'long', entry: 6.00, exit: 11.20, qty: 8, optionType: 'call', strike: 400, dte: 30, strategy: 'Swing', tags: ['Swing'], notes: 'Monthly calls on TSLA. Delivery numbers catalyst.' },
  { symbol: 'NVDA', daysAgo: 35, side: 'long', entry: 4.50, exit: 8.00, qty: 10, optionType: 'call', strike: 185, dte: 14, strategy: 'Momentum', tags: ['Momentum'], notes: 'NVDA weeklies on AI momentum. Huge move.' },
  { symbol: 'SPY', daysAgo: 27, side: 'long', entry: 5.80, exit: 3.20, qty: 15, optionType: 'put', strike: 580, dte: 7, strategy: 'Reversal', tags: ['Reversal'], notes: 'SPY puts on overbought conditions. Market stayed bid.' },
  { symbol: 'QQQ', daysAgo: 23, side: 'long', entry: 8.40, exit: 12.60, qty: 5, optionType: 'call', strike: 525, dte: 21, strategy: 'Breakout', tags: ['Breakout'], notes: 'QQQ calls on tech breakout. Perfect entry.' },
  { symbol: 'META', daysAgo: 16, side: 'long', entry: 9.00, exit: 14.50, qty: 4, optionType: 'call', strike: 620, dte: 30, strategy: 'Swing', tags: ['Swing'], notes: 'META monthlies. Social media spending increase thesis.' },
  { symbol: 'AMZN', daysAgo: 11, side: 'long', entry: 4.80, exit: 2.10, qty: 10, optionType: 'call', strike: 240, dte: 14, strategy: 'Momentum', tags: ['Momentum'], notes: 'AMZN calls on AWS growth. Whole sector pulled back though.' },
  { symbol: 'GOOGL', daysAgo: 7, side: 'long', entry: 5.50, exit: 9.30, qty: 6, optionType: 'call', strike: 310, dte: 21, strategy: 'Momentum', tags: ['Momentum'], notes: 'GOOGL calls ahead of Gemini announcements.' },
  { symbol: 'AAPL', daysAgo: 4, side: 'long', entry: 2.80, exit: 4.60, qty: 10, optionType: 'put', strike: 250, dte: 7, strategy: 'Reversal', tags: ['Reversal'], notes: 'AAPL puts on iPhone demand concerns. Paid off nicely.' },
];

// ─── Open positions ──────────────────────────────────────────────────────────
const OPEN_TRADES = [
  { symbol: 'NVDA', daysAgo: 2, side: 'long', entry: 182.00, qty: 40, strategy: 'Momentum', tags: ['Momentum'], notes: 'Riding NVDA momentum into GTC conference. Stop at 175.', stopLoss: 175, takeProfit: 195 },
  { symbol: 'SPY', daysAgo: 1, side: 'long', entry: 8.50, qty: 8, optionType: 'call', strike: 695, dte: 21, strategy: 'Breakout', tags: ['Breakout'], notes: 'SPY calls on breakout above resistance. Strong breadth.', stopLoss: 5.50, takeProfit: 14.00 },
  { symbol: 'MSFT', daysAgo: 1, side: 'long', entry: 400.50, qty: 25, strategy: 'Swing', tags: ['Swing'], notes: 'Azure cloud growth play. Targeting 420 area.', stopLoss: 392, takeProfit: 420 },
];

// ─── Diary entries ───────────────────────────────────────────────────────────
const DIARY_ENTRIES = [
  { daysAgo: 55, title: 'Week Start - Market Analysis', content: '## Market Overview\nS&P 500 is holding above the 20 EMA. Breadth is strong with over 70% of stocks above their 50 SMA. Looking for momentum continuation trades this week.\n\n## Key Levels\n- SPY: Support at 498, Resistance at 505\n- QQQ: Support at 432, Resistance at 440\n\n## Plan\nFocus on tech names showing relative strength. AAPL and NVDA look ready for breakouts.', market_bias: 'bullish', key_levels: 'SPY 498/505, QQQ 432/440', watchlist: ['AAPL', 'NVDA', 'MSFT'] },
  { daysAgo: 48, title: 'TSLA Swing Trade Setup', content: '## Pre-Market Analysis\nTSLA bounced perfectly off the 200 SMA yesterday. Volume was above average on the bounce. Looking for continuation today.\n\n## Trade Plan\n- Entry: Above yesterday\'s high (~248)\n- Stop: Below 200 SMA (~242)\n- Target: 270 area (prior resistance)\n- Risk/Reward: ~1:3.7\n\n## Lessons from Last TSLA Trade\nLast time I took profit too early. This time I\'ll use a trailing stop.', market_bias: 'bullish', key_levels: 'TSLA 242/248/270', watchlist: ['TSLA'], followed_plan: true },
  { daysAgo: 39, title: 'AMD Breakout Failure Review', content: '## Post-Trade Analysis\nThe AMD breakout failed. Looking back, there were warning signs:\n1. Volume was below average on the breakout candle\n2. Sector rotation was already underway (SMH weak)\n3. I forced the trade because I was impatient\n\n## Lessons Learned\n- Always confirm breakouts with volume\n- Check sector ETF first before individual names\n- Don\'t trade out of FOMO\n\n## Emotional State\nFrustrated but accepting. Loss was within risk parameters.', market_bias: 'neutral', lessons_learned: 'Confirm breakouts with volume. Check sector ETFs first.', followed_plan: false },
  { daysAgo: 30, title: 'Monthly Review - Strong Month', content: '## Monthly Performance Summary\nGreat month overall. Win rate at 65%, average R of 1.8.\n\n## What Worked\n- Momentum trades in tech sector\n- Patience waiting for setups\n- Sizing down on uncertain setups\n\n## What Didn\'t Work\n- Gap fill trades (0 for 2)\n- Options on earnings (IV crush)\n\n## Goals for Next Month\n1. Avoid gap fill setups (low edge)\n2. Only play earnings with defined risk spreads\n3. Continue momentum approach in trending markets', market_bias: 'bullish', lessons_learned: 'Gap fills are low probability in trending markets. Use spreads for earnings.' },
  { daysAgo: 20, title: 'NVDA Second Entry', content: '## Analysis\nNVDA pulled back to the 10 EMA and bounced with strong volume. This is the second entry signal in 3 weeks. The AI narrative remains intact.\n\n## Risk Management\n- Smaller position than first entry (10 shares vs 15)\n- Wider stop to account for volatility\n- Target remains the same: 950+\n\n## Market Context\nOverall market is healthy. VIX is low. Breadth is improving.', market_bias: 'bullish', key_levels: 'NVDA 895/910/950', watchlist: ['NVDA', 'AMD', 'AVGO'], followed_plan: true },
  { daysAgo: 10, title: 'DIS Earnings Play', content: '## Pre-Earnings Setup\nDIS reports tomorrow. The chart is setting up with a bull flag. Streaming subscriber estimates look beatable.\n\n## Trade Plan\n- Stock only (no options to avoid IV crush)\n- Entry: 112 area on pullback\n- Stop: 108 (below flag support)\n- Target: 120 (measured move)\n\n## Risk Assessment\nModerate risk. Earnings are always a coin flip but the setup is clean.', market_bias: 'bullish', key_levels: 'DIS 108/112/120', watchlist: ['DIS'], followed_plan: true },
  { daysAgo: 3, title: 'Market Getting Extended', content: '## Caution Signs\nMarket is getting extended:\n- RSI(14) on SPY is above 70\n- VIX is at extreme lows\n- Multiple gaps unfilled below\n\n## Adjustment Plan\n- Reduce position sizes by 25%\n- Take profits on winning trades\n- Look for mean reversion setups\n- Keep some cash ready for a dip\n\n## Watchlist\nDefensive names: JNJ, PG, KO. Also watching for short setups on overextended growth names.', market_bias: 'neutral', key_levels: 'SPY 510/515/520', watchlist: ['JNJ', 'PG', 'KO', 'SPY'] },
  { daysAgo: 0, title: 'Today\'s Game Plan', content: '## Pre-Market Notes\nFutures are flat. No major catalysts today. Fed speaker at 2pm could move markets.\n\n## Active Positions\n- NVDA long: trailing stop at 925, looking for 960+\n- SPY calls: will add on dip to VWAP\n- MSFT long: patient, targeting 440 zone\n\n## New Setups\n- GOOGL: Watching for breakout above 165\n- AMZN: Bull flag forming, needs volume\n\n## Rules for Today\n1. No trading first 15 minutes\n2. Max 2 new positions\n3. No revenge trading if stopped out', market_bias: 'bullish', key_levels: 'SPY 512/515, NVDA 925/960', watchlist: ['GOOGL', 'AMZN', 'NVDA'], followed_plan: true },
];

// ─── Watchlist ───────────────────────────────────────────────────────────────
const WATCHLIST = {
  name: 'Tech Momentum',
  description: 'High-momentum tech stocks with strong relative strength',
  symbols: [
    { symbol: 'NVDA', notes: 'AI leader, GTC catalyst upcoming' },
    { symbol: 'AAPL', notes: 'iPhone 16 cycle, services growth' },
    { symbol: 'MSFT', notes: 'Azure cloud growth, Copilot adoption' },
    { symbol: 'GOOGL', notes: 'Search + AI integration, Gemini' },
    { symbol: 'AMZN', notes: 'AWS re-acceleration, retail margins improving' },
    { symbol: 'META', notes: 'Ad revenue growth, Threads monetization' },
    { symbol: 'AMD', notes: 'MI300 GPU ramp, data center demand' },
    { symbol: 'AVGO', notes: 'VMware integration, networking for AI' },
    { symbol: 'CRM', notes: 'Agentforce AI platform, margin expansion' },
    { symbol: 'NFLX', notes: 'Ad tier growth, password sharing crackdown working' },
  ],
};

const WATCHLIST_2 = {
  name: 'Earnings Watch',
  description: 'Upcoming earnings with interesting setups',
  symbols: [
    { symbol: 'COST', notes: 'Consistent grower, membership fee increase' },
    { symbol: 'NKE', notes: 'Turnaround potential, new CEO' },
    { symbol: 'FDX', notes: 'Freight recovery play' },
    { symbol: 'MU', notes: 'Memory cycle recovery, HBM demand' },
    { symbol: 'LULU', notes: 'Athleisure leader, international expansion' },
  ],
};

// ─── Price Alerts ────────────────────────────────────────────────────────────
const PRICE_ALERTS = [
  { symbol: 'NVDA', alert_type: 'above', target_price: 200.00 },
  { symbol: 'NVDA', alert_type: 'below', target_price: 170.00 },
  { symbol: 'SPY', alert_type: 'above', target_price: 700.00 },
  { symbol: 'AAPL', alert_type: 'below', target_price: 240.00 },
  { symbol: 'GOOGL', alert_type: 'above', target_price: 320.00 },
  { symbol: 'TSLA', alert_type: 'below', target_price: 380.00 },
];

// ─── Account ─────────────────────────────────────────────────────────────────
const ACCOUNT = {
  accountName: 'Main Trading Account',
  accountIdentifier: 'TDA-7842',
  broker: 'TD Ameritrade',
  initialBalance: 50000,
  initialBalanceDate: fmt(days(90)),
  isPrimary: true,
  notes: 'Primary day trading account. PDT compliant.',
};

const TRANSACTIONS = [
  { type: 'deposit', amount: 10000, date: fmt(days(60)), notes: 'Additional capital for swing trades' },
  { type: 'deposit', amount: 5000, date: fmt(days(30)), notes: 'Monthly contribution' },
  { type: 'withdrawal', amount: 3000, date: fmt(days(15)), notes: 'Partial profit withdrawal' },
];

// ═══════════════════════════════════════════════════════════════════════════════
async function seed() {
  console.log(`\n🌱 Seeding demo data on ${BASE}\n`);

  // 1 ─ Tags ──────────────────────────────────────────────────────────────────
  console.log('── Creating tags ──');
  for (const t of TAG_DEFS) await api('POST', '/api/tags', t);

  // 2 ─ Account ───────────────────────────────────────────────────────────────
  console.log('\n── Creating brokerage account ──');
  const { data: acctData } = await api('POST', '/api/accounts', ACCOUNT);
  const accountId = acctData?.account?.id || acctData?.id;
  if (accountId) {
    console.log('\n── Adding account transactions ──');
    for (const tx of TRANSACTIONS) await api('POST', `/api/accounts/${accountId}/transactions`, tx);
  }

  // 3 ─ Closed stock trades ───────────────────────────────────────────────────
  console.log('\n── Creating closed stock trades ──');
  for (const t of STOCK_TRADES) {
    const commission = round(t.qty * 0.005 * 2, 2);
    const entryDate = days(t.daysAgo);
    const exitDate = days(t.daysAgo - 1);
    const isWin = (t.side === 'long' ? t.exit > t.entry : t.exit < t.entry);
    const confidence = isWin ? Math.floor(Math.random() * 3) + 7 : Math.floor(Math.random() * 3) + 4;
    await api('POST', '/api/trades', {
      symbol: t.symbol,
      side: t.side,
      instrumentType: 'stock',
      entryTime: ts(entryDate, 9, 35 + Math.floor(Math.random() * 20)),
      entryPrice: t.entry,
      exitTime: ts(exitDate, 14, Math.floor(Math.random() * 55)),
      exitPrice: t.exit,
      quantity: t.qty,
      commission,
      strategy: t.strategy,
      tags: t.tags,
      notes: t.notes,
      confidence,
      stopLoss: round(t.entry * (t.side === 'long' ? 0.97 : 1.03)),
      takeProfit: round(t.entry * (t.side === 'long' ? 1.05 : 0.95)),
    });
  }

  // 4 ─ Closed option trades ──────────────────────────────────────────────────
  console.log('\n── Creating closed option trades ──');
  for (const t of OPTION_TRADES) {
    const multiplier = 100;
    const commission = round(t.qty * 0.65 * 2, 2);
    const entryDate = days(t.daysAgo);
    const exitDate = days(t.daysAgo - 2);
    const expDate = new Date(entryDate);
    expDate.setDate(expDate.getDate() + t.dte);
    const isWin = t.exit > t.entry;
    const confidence = isWin ? Math.floor(Math.random() * 3) + 7 : Math.floor(Math.random() * 3) + 4;
    await api('POST', '/api/trades', {
      symbol: t.symbol,
      side: t.side,
      instrumentType: 'option',
      optionType: t.optionType,
      strikePrice: t.strike,
      expirationDate: fmt(expDate),
      underlyingSymbol: t.symbol,
      contractSize: multiplier,
      entryTime: ts(entryDate, 9, 40 + Math.floor(Math.random() * 15)),
      entryPrice: t.entry,
      exitTime: ts(exitDate, 15, Math.floor(Math.random() * 55)),
      exitPrice: t.exit,
      quantity: t.qty,
      commission,
      strategy: t.strategy,
      tags: t.tags,
      notes: t.notes,
      confidence,
    });
  }

  // 5 ─ Open positions ────────────────────────────────────────────────────────
  console.log('\n── Creating open positions ──');
  for (const t of OPEN_TRADES) {
    const entryDate = days(t.daysAgo);
    const body = {
      symbol: t.symbol,
      side: t.side,
      instrumentType: t.optionType ? 'option' : 'stock',
      entryTime: ts(entryDate, 9, 32 + Math.floor(Math.random() * 10)),
      entryPrice: t.entry,
      quantity: t.qty,
      strategy: t.strategy,
      tags: t.tags,
      notes: t.notes,
      stopLoss: t.stopLoss,
      takeProfit: t.takeProfit,
      confidence: 8,
    };
    if (t.optionType) {
      body.optionType = t.optionType;
      body.strikePrice = t.strike;
      const expDate = new Date(entryDate);
      expDate.setDate(expDate.getDate() + t.dte);
      body.expirationDate = fmt(expDate);
      body.underlyingSymbol = t.symbol;
      body.contractSize = 100;
    }
    await api('POST', '/api/trades', body);
  }

  // 6 ─ Diary entries ─────────────────────────────────────────────────────────
  console.log('\n── Creating diary entries ──');
  for (const d of DIARY_ENTRIES) {
    await api('POST', '/api/diary', {
      entryDate: fmt(days(d.daysAgo)),
      title: d.title,
      content: d.content,
      entryType: 'diary',
      marketBias: d.market_bias,
      keyLevels: d.key_levels || '',
      watchlist: d.watchlist || [],
      followedPlan: d.followed_plan,
      lessonsLearned: d.lessons_learned || '',
    });
  }

  // 7 ─ Watchlists ────────────────────────────────────────────────────────────
  console.log('\n── Creating watchlists ──');
  for (const wl of [WATCHLIST, WATCHLIST_2]) {
    const { data } = await api('POST', '/api/watchlists', { name: wl.name, description: wl.description });
    const wlId = data?.watchlist?.id || data?.id;
    if (wlId) {
      for (const s of wl.symbols) {
        await api('POST', `/api/watchlists/${wlId}/items`, { symbol: s.symbol, notes: s.notes });
      }
    }
  }

  // 8 ─ Price alerts ──────────────────────────────────────────────────────────
  console.log('\n── Creating price alerts ──');
  for (const a of PRICE_ALERTS) await api('POST', '/api/price-alerts', a);

  console.log('\n✅ Seed complete!\n');
}

seed().catch(err => { console.error('Seed failed:', err); process.exit(1); });
