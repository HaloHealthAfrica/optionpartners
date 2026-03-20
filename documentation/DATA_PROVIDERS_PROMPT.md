# Data Providers — TradePartners / Clean E2E Build

This document details which data providers exist in the TradePartners project and how they can be used for the clean single-strategy E2E build (webhooks → sim trades).

---

## 1. Overview

TradePartners uses **two separate data stacks**:

| Stack | Location | Purpose |
|-------|----------|---------|
| **Data-service** | `data-service/` (port 4000) | Sim engine: quotes, options chains, VIX, macro regime, GEX, flow, IV. Used by backend via `dataServiceProxy`. |
| **Backend direct** | `backend/src/utils/`, `backend/src/services/` | Journal/analytics: Finnhub, Alpha Vantage for charts, CUSIP, news, dividends, watchlists. **Not used by sim/webhook flow.** |

**For the clean E2E build:** Only the **data-service** providers matter. The backend calls data-service; data-service calls its providers.

---

## 2. Data-Service Providers

### 2.1 Provider Summary

| Provider | API Key | Priority | Capabilities | Used For Sim? |
|----------|---------|----------|--------------|---------------|
| **TwelveData** | `TWELVE_DATA_API_KEY` | primary | quotes, candles, market hours, (options chain*) | ✅ Yes — quotes, candles, trend |
| **Unusual Whales** | `UNUSUAL_WHALES_API_KEY` | primary | options chain, GEX, flow, IV | ✅ Yes — chain, GEX, flow, IV |
| **MarketData.app** | `MARKETDATA_API_TOKEN` | primary | options chain only | ✅ Yes — chain fallback |
| **Polygon** | `POLYGON_API_KEY` | tertiary | quotes, candles, options chain** | ✅ Yes — chain/quote fallback |
| **CBOE** | None (free) | — | VIX spot + futures | ✅ Yes — regime, macro |
| **FRED** | `FRED_API_KEY` | — | Fed funds, yield curve, FOMC | ✅ Yes — macro regime |
| **Computed GEX** | None | tertiary | GEX (derived from chain) | ✅ Yes — GEX fallback |

\* TwelveData options chain: set `TD_OPTIONS_ENABLED=true` (default: false)  
\** Polygon options chain: set `POLYGON_OPTIONS_ENABLED=false` to disable (default: true)

### 2.2 Capability Matrix (Data-Service)

| Capability | TwelveData | Unusual Whales | MarketData.app | Polygon | CBOE | FRED | Computed |
|------------|------------|----------------|----------------|---------|------|------|----------|
| **Quotes** | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| **Candles** | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| **Options chain** | ⚠️* | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **GEX** | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Flow** | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **IV** | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **VIX** | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| **Market hours** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Macro (Fed, yields)** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |

---

## 3. What the Sim Engine Needs

For webhook → trade flow, the backend (via data-service) needs:

| Data Type | Backend Use | Provider(s) | Minimum for E2E |
|-----------|-------------|-------------|------------------|
| **Quote** | Price for symbol_state, fill model, exit monitor | TwelveData, Polygon | TwelveData (primary) |
| **Options chain** | Strike selection, liquidity, bid/ask | Unusual Whales, MarketData.app, Polygon | At least one chain provider |
| **VIX / regime** | Macro bias, MTF_BIAS, fail-closed checks | CBOE | CBOE (free, no key) |
| **Macro** | Fed funds, yield curve, FOMC | FRED | FRED (optional for minimal) |
| **Candles** | Trend data, local bias | TwelveData, Polygon | TwelveData |
| **GEX / flow / IV** | Optional context; not required for basic entry | Unusual Whales, computed | Can defer |

### 3.1 Minimal Provider Set for Clean E2E

**Required:**
- **TwelveData** — quotes, candles, market hours. Primary for price and trend.
- **One options chain provider** — Unusual Whales, MarketData.app, or Polygon.
- **CBOE** — VIX/regime. No key; always available if data-service runs.

**Optional (can start without):**
- **FRED** — Macro data. If missing, macro regime falls back to neutral.
- **Unusual Whales** — If you have it, use it for chain + GEX + IV. Best chain quality.
- **MarketData.app** — 100K daily credits; good chain fallback.
- **Polygon** — 15-min delayed; tertiary fallback.

---

## 4. Environment Variables (Data-Service)

```bash
# Required for minimal E2E
TWELVE_DATA_API_KEY=your-twelve-data-key
UNUSUAL_WHALES_API_KEY=your-uw-key   # OR MARKETDATA_API_TOKEN OR POLYGON_API_KEY

# Optional
POLYGON_API_KEY=your-polygon-key
MARKETDATA_API_TOKEN=your-marketdata-token
FRED_API_KEY=your-fred-key

# TwelveData options (default: disabled)
TD_OPTIONS_ENABLED=true   # Only if TwelveData plan includes options

# Polygon options (default: enabled)
POLYGON_OPTIONS_ENABLED=false   # Set to disable Polygon chain

# Rate limits (defaults usually fine)
TWELVE_DATA_RATE_LIMIT=800
UNUSUAL_WHALES_RATE_LIMIT=120
POLYGON_RATE_LIMIT=5
CBOE_RATE_LIMIT=10
```

---

## 5. Provider Details

### 5.1 TwelveData

- **Role:** Primary stock/candle provider.
- **Provides:** Real-time/delayed quotes, OHLCV candles, market hours.
- **Options chain:** Only if `TD_OPTIONS_ENABLED=true` and plan supports it.
- **Rate limit:** 800/min default (configurable).
- **Get key:** https://twelvedata.com
- **Used by sim:** `symbol_state` price, trend (candles), warmup.

### 5.2 Unusual Whales

- **Role:** Primary options intelligence.
- **Provides:** Options chain, GEX, options flow, IV.
- **Rate limit:** 120/min default.
- **Get key:** https://unusualwhales.com
- **Used by sim:** Chain for options constructor, GEX/flow/IV for context.

### 5.3 MarketData.app

- **Role:** Fallback options chain.
- **Provides:** Options chain only. Real-time, 100K daily credits.
- **Rate limit:** 100/min default.
- **Get key:** https://marketdata.app
- **Used by sim:** Chain when Unusual Whales/Polygon fail.

### 5.4 Polygon

- **Role:** Tertiary fallback.
- **Provides:** Quotes, candles, options chain (15-min delayed). Real Greeks.
- **Rate limit:** 5/min default (free tier).
- **Get key:** https://polygon.io
- **Used by sim:** Chain/quote fallback when primary providers fail.

### 5.5 CBOE

- **Role:** VIX and volatility regime.
- **Provides:** VIX spot, VIX futures term structure. Free CDN, no API key.
- **Used by sim:** Macro regime (VIX-based), MTF_BIAS, fail-closed checks.

### 5.6 FRED

- **Role:** Macro economic data.
- **Provides:** Fed funds rate, 2Y/10Y yields, yield spread, FOMC dates.
- **Get key:** https://fred.stlouisfed.org
- **Used by sim:** Macro regime context. If missing, regime uses neutral/VIX-only.

### 5.7 Computed GEX

- **Role:** GEX fallback.
- **Provides:** GEX derived from options chain. No API calls.
- **Used by sim:** GEX when no real-API provider returns GEX.

---

## 6. Backend Direct Providers (Not for Sim)

These are used by the **journal/analytics** features, not by the sim/webhook flow:

| Provider | Env Var | Use |
|----------|---------|-----|
| **Finnhub** | `FINNHUB_API_KEY` | Quotes, candles, charts, CUSIP, news, dividends, watchlists, price alerts |
| **Alpha Vantage** | `ALPHA_VANTAGE_API_KEY` | Chart fallback, dividends |

For a **sim-only** clean build, Finnhub and Alpha Vantage are **not required**. The sim engine gets all market data from the data-service.

---

## 7. Fallback Order (Data-Service)

The data orchestrator tries providers in priority order with automatic fallback:

- **Quotes:** TwelveData → Polygon
- **Candles:** TwelveData → Polygon
- **Options chain:** Unusual Whales → MarketData.app → Polygon (TwelveData if `TD_OPTIONS_ENABLED`)
- **GEX:** Unusual Whales → Computed (from chain)
- **Flow:** Unusual Whales only
- **IV:** Unusual Whales → computed from chain
- **VIX:** CBOE only
- **Macro:** FRED only

---

## 8. Recommendations for Clean E2E Build

1. **Start with:** TwelveData + Unusual Whales (or MarketData.app if UW unavailable).
2. **CBOE/FRED:** CBOE is free; FRED is free with key. Configure both for full regime.
3. **Add Polygon** as tertiary fallback if you have a key.
4. **Validate at startup:** `validateProviderConfiguration()` in data-service logs which keys are present. At least one of TwelveData, Unusual Whales, Polygon must be configured.
5. **Warmup before RTH:** Call `POST /api/sim/warmup/:symbol` so symbol_state gets fresh quote + chain + macro from data-service.
