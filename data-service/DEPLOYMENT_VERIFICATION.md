# Data Service Deployment Verification Guide

## Overview

This guide provides steps to verify that the data-service is properly configured and operational after deployment to Fly.io.

## Prerequisites

- Fly.io CLI installed (`flyctl`)
- Access to the Trade Partners Fly.io organization
- Appropriate permissions to view secrets and logs

## Verification Steps

### 1. Verify Fly.io Secrets Configuration

Check that all required API keys are set in Fly.io secrets:

```bash
flyctl secrets list -a data-service
```

**Expected secrets:**
- `TWELVE_DATA_API_KEY` - TwelveData API key (primary stock/candles provider)
- `UNUSUAL_WHALES_API_KEY` - Unusual Whales API key (primary options/GEX/flow provider)
- `POLYGON_API_KEY` - Polygon API key (tertiary fallback provider)
- `FRED_API_KEY` - FRED API key (macro economic data)
- `MARKETDATA_API_TOKEN` - MarketData.app token (options chain authority)
- `API_KEY` - Service authentication key
- `REDIS_URL` - Redis connection URL
- `DATABASE_URL` - PostgreSQL connection URL

**Minimum requirement:** At least one of `TWELVE_DATA_API_KEY`, `UNUSUAL_WHALES_API_KEY`, or `POLYGON_API_KEY` must be set.

### 2. Set Missing Secrets

If any required secrets are missing, set them using:

```bash
flyctl secrets set TWELVE_DATA_API_KEY="your-api-key-here" -a data-service
flyctl secrets set UNUSUAL_WHALES_API_KEY="your-api-key-here" -a data-service
flyctl secrets set POLYGON_API_KEY="your-api-key-here" -a data-service
```

**Note:** Setting secrets will trigger an automatic deployment.

### 3. Check Service Startup Logs

After deployment, verify that providers registered successfully:

```bash
flyctl logs -a data-service
```

**Look for these log messages:**

✅ **Success indicators:**
```
Configuration valid: 3 provider API key(s) configured (twelveData, unusualWhales, polygon)
TwelveData provider registered successfully (primary stock/candles) - API key present
Unusual Whales provider registered successfully (primary options/GEX/flow) - API key present
Polygon provider registered successfully (tertiary fallback) - API key present
Provider registration complete: 3 provider(s) registered successfully
```

⚠️ **Warning indicators:**
```
TwelveData provider failed to register - API key missing or empty
Unusual Whales provider failed to register - API key missing or empty
Configuration valid: 1 provider API key(s) configured (polygon). Missing: twelveData, unusualWhales
```

❌ **Critical error indicators:**
```
CRITICAL: No provider API keys configured. Service will not be able to fetch real market data
CRITICAL: Zero data providers registered - service will not be able to fetch real market data
Configuration validation failed: No provider API keys configured
```

### 4. Verify Health Check Endpoint

Check the service health endpoint to confirm provider registration:

```bash
curl https://data-service.fly.dev/api/health
```

**Expected response (healthy):**
```json
{
  "status": "ok",
  "ready": true,
  "providers": {
    "twelvedata": {
      "healthy": true,
      "circuitState": "CLOSED",
      "successRate": 1.0
    },
    "unusual_whales": {
      "healthy": true,
      "circuitState": "CLOSED",
      "successRate": 1.0
    },
    "polygon": {
      "healthy": true,
      "circuitState": "CLOSED",
      "successRate": 1.0
    }
  },
  "configuration": {
    "apiKeysConfigured": 3,
    "providersRegistered": 3,
    "apiKeys": {
      "twelveData": true,
      "unusualWhales": true,
      "polygon": true,
      "fred": true
    }
  }
}
```

**Degraded response (no providers):**
```json
{
  "status": "degraded",
  "ready": false,
  "providers": {},
  "configuration": {
    "apiKeysConfigured": 0,
    "providersRegistered": 0,
    "apiKeys": {
      "twelveData": false,
      "unusualWhales": false,
      "polygon": false,
      "fred": false
    }
  }
}
```

### 5. Test Real Market Data Retrieval

Verify that the service can fetch real market data:

```bash
curl -H "X-API-Key: your-api-key" https://data-service.fly.dev/api/quote/SPY
```

**Expected response:**
```json
{
  "symbol": "SPY",
  "price": 450.25,
  "timestamp": "2024-01-15T14:30:00Z",
  "source": "twelvedata"
}
```

**Error response (no providers):**
```json
{
  "error": "Market data service unavailable - no data providers configured",
  "statusCode": 503
}
```

### 6. Monitor Circuit Breaker State

If providers are failing, check circuit breaker state:

```bash
curl https://data-service.fly.dev/api/health | jq '.providers'
```

**Circuit breaker states:**
- `CLOSED` - Normal operation, requests are allowed
- `OPEN` - Circuit breaker tripped, requests are blocked (30-60 seconds)
- `HALF_OPEN` - Testing if service recovered, limited requests allowed

If circuit breakers are stuck in `OPEN` state, you can reset them:

```bash
curl -X POST -H "X-API-Key: your-api-key" https://data-service.fly.dev/api/admin/circuit-breaker/reset
```

## Troubleshooting

### No Providers Registered

**Symptoms:**
- Health check shows `"providersRegistered": 0`
- Logs show "CRITICAL: Zero data providers registered"
- Quote requests return 503 errors

**Solution:**
1. Verify secrets are set: `flyctl secrets list -a data-service`
2. Set missing API keys using `flyctl secrets set`
3. Wait for automatic redeployment
4. Check logs to confirm provider registration

### Circuit Breaker Stuck Open

**Symptoms:**
- Health check shows `"circuitState": "OPEN"`
- Quote requests fail with "Circuit breaker OPEN" error
- Logs show authentication failures

**Solution:**
1. Verify API keys are valid (not expired or revoked)
2. Reset circuit breaker: `POST /api/admin/circuit-breaker/reset`
3. If issue persists, check provider API status pages
4. Consider rotating API keys if authentication continues to fail

### Partial Provider Registration

**Symptoms:**
- Some providers registered, others missing
- Logs show warnings about missing API keys
- Service works but has limited fallback options

**Solution:**
1. Review which providers are missing from health check
2. Set missing API keys: `flyctl secrets set PROVIDER_API_KEY="key"`
3. Monitor logs to confirm additional providers register
4. Verify all providers show `"healthy": true` in health check

## Monitoring Checklist

After deployment, verify:

- [ ] All required secrets are set in Fly.io
- [ ] At least one provider API key is configured
- [ ] Service startup logs show successful provider registration
- [ ] Health check endpoint returns `"ready": true`
- [ ] Health check shows expected number of providers registered
- [ ] Circuit breakers are in `CLOSED` state
- [ ] Test quote request returns real market data (not mock data)
- [ ] No critical errors in logs

## Additional Resources

- [Fly.io Secrets Documentation](https://fly.io/docs/reference/secrets/)
- [TwelveData API Documentation](https://twelvedata.com/docs)
- [Unusual Whales API Documentation](https://unusualwhales.com/api)
- [Polygon API Documentation](https://polygon.io/docs)
- [FRED API Documentation](https://fred.stlouisfed.org/docs/api/)
