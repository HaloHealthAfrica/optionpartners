# Deep Dive: Signals, Fixes, and Profitability — 3/10/2026

## Executive Summary

| Metric | Value |
|--------|-------|
| Trades today | 8 |
| Total P&L | **-$2,965.05** |
| Win rate | 50% (4W / 4L) |
| Main blocker | **Kill switch** (374 of 375 SAFETY_GUARD rejections) |
| Fixes deployed? | **Partially** — server may need restart for Fix 2 sub-categories |

---

## 1. Today's Trades — What Went Wrong

### Trade-by-Trade Breakdown

| # | Strategy | Symbol | Side | Entry (ET) | Exit | P&L | Exit Reason |
|---|----------|--------|------|------------|------|-----|-------------|
| 1 | squeeze_pro | AMZN C 195 | long | Mon 9:47 PM | 9:53 PM | **+$1,511** | TAKE_PROFIT |
| 2 | squeeze_pro | META P 580 | long | Mon 9:47 PM | 9:53 PM | **-$1,822** | STOP_LOSS |
| 3 | squeeze_pro | AMZN C 195 | long | Mon 10:05 PM | 10:17 PM | **+$1,511** | TAKE_PROFIT |
| 4 | squeeze_pro | META P 580 | long | Mon 10:05 PM | 10:10 PM | **-$1,822** | STOP_LOSS |
| 5 | SIGNALS | SPY C 680 | long | **Tue 4:15 AM** | 9:39 AM | **-$822** | STOP_LOSS |
| 6 | SIGNALS | SPY P 680 | long | Tue 9:45 AM | 10:09 AM | **+$93** | TAKE_PROFIT |
| 7 | SIGNALS | SPY P 680 | long | Tue 9:45 AM | 10:09 AM | **+$83** | TAKE_PROFIT |
| 8 | SIGNALS | SPY P 670 | long | Tue 10:10 AM | 10:35 AM | **-$1,698** | STOP_LOSS |

### Why the Losing Trades Lost

1. **squeeze_pro META puts (2x -$1,822 each)**  
   - Same setup, same outcome: direction was wrong. META moved against the puts.  
   - Assessment flagged squeeze_pro as SUPPRESS — PF 0.81, negative P&L. **Not yet suppressed.**

2. **SIGNALS SPY 680 call (-$822)**  
   - **Entry at 4:15 AM ET** — pre-market. Assessment: 100% of edge is in 9:30–10:00.  
   - Pre-market options have wide spreads and low liquidity. Wrong time window.

3. **SIGNALS SPY 670 put (-$1,698)**  
   - Entry at 10:10 AM — slightly after the 9:30–10:00 sweet spot.  
   - Large loss (-59%) — stop may be too wide, or direction was wrong.

### Strategy Performance Today

| Strategy | Trades | Wins | Losses | P&L |
|----------|--------|------|--------|-----|
| squeeze_pro | 4 | 2 | 2 | **-$621.71** |
| SIGNALS | 4 | 2 | 2 | **-$2,343.34** |

---

## 2. Have Our Fixes Fixed the Issues?

### Fix 2: SAFETY_GUARD Sub-Category Logging

**Status:** Code is in place, but rejections still show `safety_violation`.

**Evidence:** Last 10 SAFETY_GUARD rejections all have `reason: "Kill switch is active"` but `rejection_reason: safety_violation` instead of `safety_kill_switch`.

**Conclusion:** Backend likely needs a **restart** to pick up the change. After restart, new rejections will log `safety_kill_switch`, `safety_daily_loss_limit`, etc.

### Fix 4: TRADE_ENGINE Data Infrastructure

**Status:** Partially effective.

- **Today:** 15 `chain_data_unavailable`, 10 `data_staleness` — 25 total.
- **Retry logic:** Will reduce `chain_data_unavailable` when data-service is flaky.
- **Staleness auto-purge:** Clears cache on rejection so the next signal gets a fresh fetch.
- **Root cause:** E2E report notes data-service circuit breaker was OPEN — chain data ~85 hours stale. Fix 4 helps once data-service is healthy; it does not fix a down data-service.

### Fix 1: Regime Fallback to NEUTRAL

**Status:** Deployed. Today's SIGNALS trades show `regime_at_entry: NEUTRAL`. squeeze_pro shows `N/A` (older trades before fix).

### Fix 5: squeeze_pro Suppression

**Status:** **Not implemented.** Assessment said to add squeeze_pro to SUPPRESSED_STRATEGIES. Default remains `SIGNALS` only. squeeze_pro traded today and lost -$621.

---

## 3. Why 374 Rejections Were "Kill Switch"

**Sequence of events:**

1. Trades executed (squeeze_pro + SIGNALS).
2. Losses accumulated (META puts, SPY call, SPY put).
3. Daily P&L hit `SIM_MAX_DAILY_LOSS` (default $2,000).
4. Kill switch activated automatically.
5. All subsequent signals blocked with "Kill switch is active" (374 rejections).

**Conclusion:** The kill switch behaved as designed. It stopped trading after losses exceeded the limit. The problem was the losing trades that triggered it, not the kill switch itself.

---

## 4. What to Do to Start Trading Profitably

### Immediate (Deploy Today)

1. **Add squeeze_pro to SUPPRESSED_STRATEGIES**
   ```bash
   SUPPRESSED_STRATEGIES=SIGNALS,squeeze_pro
   ```
   Prevents further squeeze_pro losses (PF 0.81, -$621 today).

2. **Entry session (default: full market hours 9:30–16:00 ET)**
   ```bash
   ENTRY_SESSION_START=09:30
   ENTRY_SESSION_END=16:00
   ```
   Full market hours allow trading 9:30–4pm. The trade-decision-engine applies best-practice session quality: 9:30–10:00 gets a free pass (validated edge window); outside that window with valid regime flows normally; outside with UNKNOWN regime gets a conviction penalty (not a block). Set `ENTRY_SESSION_END=10:00` only if you want to restrict to opening drive.

3. **Restart backend** so Fix 2 sub-category logging takes effect. Enables proper diagnosis of future SAFETY_GUARD rejections.

### Short-Term (This Week)

4. **Keep data-service healthy**  
   Fix 4 helps when data-service is up. Ensure:
   - Data-service is running and reachable.
   - Circuit breaker is closed (use `POST /api/sim/data-service/circuit-breaker/reset` if needed).
   - Provider API keys (Polygon, TwelveData) are valid.

5. **Lean into what works**  
   Assessment: ORB_Breakout (83% WR, +$8,592) and SIGNALS_Gamma (75% WR, +$10,730) have edge. Ensure these strategies are not suppressed and have room to trade.

6. **Tighten SIGNALS or keep suppressed**  
   SIGNALS has PF 0.07 historically. Today: 4 trades, -$2,343. Consider keeping SIGNALS suppressed and only enabling SIGNALS_Gamma if it is a distinct strategy.

### Medium-Term (Next 2–4 Weeks)

7. **Review stop placement**  
   Losers hit STOP_LOSS with large drawdowns (-50% to -84%). MAE/MFE pipeline (Fix 3) will provide better data once denominator is fixed. Use that to calibrate stops.

8. **Block pre-market entries**  
   If 4:15 AM passed due to `SIM_TRADING_START=04:00`, consider reverting to 09:00 or 09:30 so pre-market options are not traded.

---

## 5. Root Cause Summary

| Issue | Root Cause | Fix Status |
|-------|------------|-----------|
| Losing trades | squeeze_pro + SIGNALS negative expectancy; pre-market entry; wrong direction | Suppress squeeze_pro; full market hours (9:30–16:00); keep SIGNALS suppressed |
| 374 blocked signals | Kill switch (daily loss limit) | Working as designed |
| safety_violation not sub-categorized | Server not restarted after Fix 2 | Restart backend |
| TRADE_ENGINE data rejections | Data-service circuit breaker / stale data | Fix 4 helps; ensure data-service is healthy |
| Regime UNKNOWN | VIX/volatility feed gaps | Fix 1 deployed (NEUTRAL fallback) |

---

## 6. Recommended Action Plan

**Today:**
- [ ] Set `SUPPRESSED_STRATEGIES=SIGNALS,squeeze_pro`
- [ ] Set `ENTRY_SESSION_START=09:30` and `ENTRY_SESSION_END=16:00` (full market hours; remove `ENTRY_SESSION_END=10:00` if previously set)
- [ ] Restart backend
- [ ] Verify data-service health and circuit breaker

**This week:**
- [ ] Confirm ORB_Breakout and SIGNALS_Gamma are not suppressed and can trade in 9:30–16:00
- [ ] Monitor rejection sub-categories after restart (safety_kill_switch, etc.)

**Ongoing:**
- [ ] Use MAE/MFE data (after Fix 3) to tune stops and targets
- [ ] Re-evaluate squeeze_pro after 30 days paper trading if desired
