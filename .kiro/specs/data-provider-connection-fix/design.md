# Data Provider Connection Fix - Bugfix Design

## Overview

The data-service microservice fails to fetch real-time market data due to provider registration failures when API keys are missing or empty, circuit breaker state getting stuck in OPEN state, and silent fallback to mock pricing instead of proper error handling. This fix addresses the root causes by implementing diagnostic improvements, provider registration validation, circuit breaker recovery mechanisms, and enhanced error responses to ensure the system either returns real market data or fails explicitly with actionable error messages.

The fix strategy involves:
1. Adding validation and diagnostic logging during provider registration
2. Implementing circuit breaker reset/recovery mechanisms
3. Replacing silent fallbacks with explicit error responses
4. Enhancing health checks to surface provider configuration issues
5. Adding deployment verification steps for Fly.io secrets

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug - when API keys are missing/empty, causing provider registration failures and circuit breaker issues
- **Property (P)**: The desired behavior - providers register successfully with valid keys, circuit breakers recover automatically, and configuration errors are surfaced explicitly
- **Preservation**: Existing provider fallback behavior, caching logic, rate limiting, and health check responses that must remain unchanged
- **DataOrchestrator**: The service in `data-service` that manages provider selection and request routing
- **Circuit Breaker**: The fault tolerance mechanism that opens after 3 consecutive failures and blocks requests for 30-60 seconds
- **Provider Registration**: The initialization process where data providers (TwelveData, Unusual Whales, Polygon, FRED) are registered if their API keys are non-empty
- **Fly.io Secrets**: Environment variables stored securely in Fly.io (TWELVE_DATA_API_KEY, UNUSUAL_WHALES_API_KEY, POLYGON_API_KEY, FRED_API_KEY)

## Bug Details

### Fault Condition

The bug manifests when API keys are missing, empty, or invalid during service initialization, or when circuit breakers enter OPEN state due to authentication failures. The system fails silently by not registering providers, throwing "No available providers" errors, and falling back to mock pricing instead of surfacing configuration issues.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type ServiceInitializationContext OR QuoteRequest
  OUTPUT: boolean
  
  RETURN (input.type == "initialization" AND 
          (input.apiKeys.TWELVE_DATA_API_KEY == "" OR 
           input.apiKeys.UNUSUAL_WHALES_API_KEY == "" OR 
           input.apiKeys.POLYGON_API_KEY == ""))
         OR
         (input.type == "quoteRequest" AND 
          registeredProviders.length == 0)
         OR
         (input.type == "quoteRequest" AND 
          circuitBreakerState == "OPEN" AND 
          underlyingIssueResolved == true)
END FUNCTION
```

### Examples

- **Provider Registration Failure**: Service starts with TWELVE_DATA_API_KEY="" → TwelveData provider not registered → Quote request for SPY fails with "No available providers for capability: quotes" → Backend falls back to mock price $450.00 instead of real market price
- **Circuit Breaker Stuck**: Invalid API key causes 3 authentication failures → Circuit breaker opens → API key is corrected in Fly.io secrets → Service restarted → Circuit breaker remains OPEN for 30-60 seconds → All quote requests fail even though configuration is now correct
- **Silent Fallback**: All providers fail to register → Health check shows 0 providers → Quote request returns guessed price without error → User sees inaccurate options pricing on /sim/trades
- **Edge Case - Partial Registration**: TWELVE_DATA_API_KEY is valid but UNUSUAL_WHALES_API_KEY is empty → Only TwelveData registers → If TwelveData rate limit is reached, no fallback available → Expected behavior: should log warning about missing Unusual Whales configuration

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Provider fallback priority (TwelveData → Unusual Whales → Polygon) must continue to work when multiple providers are registered
- Cache-first behavior must remain unchanged - fresh cached data should be returned without external API calls
- Rate limiting respect and automatic fallback to alternative providers must continue working
- In-memory caching when database/Redis is unavailable must continue working
- Health check endpoint /api/health must continue returning provider status, circuit breaker state, success rates, and rate limit information

**Scope:**
All inputs that do NOT involve missing/empty API keys or stuck circuit breakers should be completely unaffected by this fix. This includes:
- Normal quote requests when providers are healthy and properly configured
- Cache hits that don't require external API calls
- Provider fallback when primary provider fails but secondary providers are available
- Rate limit handling and provider rotation
- Database/Redis unavailability scenarios

## Hypothesized Root Cause

Based on the bug description, the most likely issues are:

1. **Missing Provider Registration Validation**: The provider registration logic only checks if API keys are non-empty strings but doesn't log warnings or errors when keys are missing
   - No diagnostic output during initialization to indicate which providers registered successfully
   - No validation that at least one provider registered before accepting quote requests

2. **Circuit Breaker State Persistence**: The circuit breaker state may persist across service restarts or lack an automatic recovery mechanism
   - Circuit breaker opens after 3 failures and stays OPEN for 30-60 seconds
   - No mechanism to reset circuit breaker when underlying issue (API key) is fixed
   - Circuit breaker state may be stored in memory and not cleared on restart

3. **Silent Error Handling**: The backend proxy or frontend catches "No available providers" errors and falls back to mock pricing instead of propagating the error
   - DataOrchestrator throws error but downstream systems suppress it
   - No 503 Service Unavailable response to indicate service degradation
   - Users see inaccurate data without knowing the system is degraded

4. **Insufficient Health Check Diagnostics**: The health check endpoint may not surface provider registration status or configuration issues
   - Health check shows circuit breaker state but not why providers failed to register
   - No indication that API keys are missing or empty
   - No actionable error messages for operators to diagnose issues

## Correctness Properties

Property 1: Fault Condition - Provider Registration and Error Surfacing

_For any_ service initialization where API keys are missing or empty (isBugCondition returns true for initialization), the fixed system SHALL log clear warning messages indicating which providers failed to register and why, AND for any quote request where no providers are registered, the system SHALL return a 503 Service Unavailable error with an actionable message instead of falling back to mock pricing.

**Validates: Requirements 2.1, 2.3, 2.4, 2.5**

Property 2: Preservation - Healthy Provider Behavior

_For any_ service initialization where API keys are properly configured and for any quote request where providers are healthy and registered (isBugCondition returns false), the fixed system SHALL produce exactly the same behavior as the original system, preserving provider fallback priority, caching logic, rate limiting, and health check responses.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `data-service/src/services/DataOrchestrator.ts` (or equivalent provider registration module)

**Function**: Provider registration initialization logic

**Specific Changes**:
1. **Add Provider Registration Validation**:
   - Log INFO message for each provider that registers successfully with API key present
   - Log WARN message for each provider that fails to register due to missing/empty API key
   - Log ERROR message if zero providers register, indicating service will not be able to fetch real data
   - Add startup validation that fails fast if no providers are registered

2. **Implement Circuit Breaker Recovery**:
   - Add manual circuit breaker reset endpoint (e.g., POST /api/admin/circuit-breaker/reset)
   - Implement automatic circuit breaker recovery when underlying issue is resolved (e.g., half-open state testing)
   - Clear circuit breaker state on service restart to allow fresh attempts with corrected configuration
   - Add circuit breaker state logging to track transitions (CLOSED → OPEN → HALF_OPEN → CLOSED)

3. **Replace Silent Fallbacks with Explicit Errors**:
   - Modify DataOrchestrator to throw ServiceUnavailableError when no providers are available
   - Update backend proxy to return 503 status code instead of falling back to mock pricing
   - Add error response body with actionable message: "Market data service unavailable - no data providers configured"
   - Ensure frontend displays error message to users instead of showing mock data

4. **Enhance Health Check Diagnostics**:
   - Add provider registration status to /api/health response (registered: true/false, reason: "API key missing")
   - Include API key configuration status (present/missing) without exposing actual key values
   - Add circuit breaker state and reason for OPEN state (e.g., "3 consecutive authentication failures")
   - Include last error message for each provider to aid debugging

5. **Add Deployment Verification**:
   - Create deployment checklist for verifying Fly.io secrets are set
   - Add startup health check that validates provider registration before marking service as ready
   - Include provider registration status in startup logs for easy verification
   - Document Fly.io secrets verification commands (flyctl secrets list)

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code by simulating missing API keys and circuit breaker failures, then verify the fix works correctly by validating diagnostic logging, error responses, and circuit breaker recovery while preserving existing healthy-path behavior.

### Exploratory Fault Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that simulate service initialization with missing/empty API keys and quote requests with no registered providers. Mock the circuit breaker to enter OPEN state and verify it stays stuck. Run these tests on the UNFIXED code to observe failures and understand the root cause.

**Test Cases**:
1. **Missing API Keys Test**: Start service with all API keys empty → Verify no providers register → Make quote request → Observe "No available providers" error and mock pricing fallback (will fail on unfixed code - no diagnostic logging)
2. **Circuit Breaker Stuck Test**: Simulate 3 authentication failures → Verify circuit breaker opens → Correct API key → Restart service → Observe circuit breaker still OPEN (will fail on unfixed code - no recovery mechanism)
3. **Silent Fallback Test**: Start service with no providers → Make quote request → Observe 200 OK response with mock data instead of 503 error (will fail on unfixed code - silent fallback)
4. **Partial Registration Test**: Set only TWELVE_DATA_API_KEY → Verify only TwelveData registers → Check logs for warnings about missing other providers (will fail on unfixed code - no diagnostic logging)

**Expected Counterexamples**:
- No diagnostic logging during provider registration indicating which providers failed and why
- Circuit breaker state persists across restarts or lacks recovery mechanism
- Backend returns 200 OK with mock data instead of 503 Service Unavailable
- Health check doesn't surface provider registration failures or configuration issues

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  IF input.type == "initialization" THEN
    result := initializeProviders_fixed(input.apiKeys)
    ASSERT result.logs CONTAINS "WARN: Provider X failed to register - API key missing"
    ASSERT result.registeredProviders.length >= 0
  ELSE IF input.type == "quoteRequest" AND registeredProviders.length == 0 THEN
    result := handleQuoteRequest_fixed(input)
    ASSERT result.statusCode == 503
    ASSERT result.body CONTAINS "no data providers configured"
  ELSE IF input.type == "quoteRequest" AND circuitBreakerState == "OPEN" THEN
    resetCircuitBreaker_fixed()
    result := handleQuoteRequest_fixed(input)
    ASSERT result.statusCode != "Circuit breaker OPEN"
  END IF
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT handleQuoteRequest_original(input) = handleQuoteRequest_fixed(input)
  ASSERT providerFallback_original(input) = providerFallback_fixed(input)
  ASSERT cacheLogic_original(input) = cacheLogic_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain (different symbols, cache states, provider health states)
- It catches edge cases that manual unit tests might miss (e.g., race conditions, cache expiry edge cases)
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs (healthy providers, valid API keys)

**Test Plan**: Observe behavior on UNFIXED code first for healthy provider scenarios, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Provider Fallback Preservation**: Observe that TwelveData → Unusual Whales → Polygon fallback works on unfixed code when all providers are registered, then write test to verify this continues after fix
2. **Cache Behavior Preservation**: Observe that cached data is returned without external API calls on unfixed code, then write test to verify this continues after fix
3. **Rate Limiting Preservation**: Observe that rate limit handling and provider rotation work on unfixed code, then write test to verify this continues after fix
4. **Health Check Preservation**: Observe that /api/health returns provider status on unfixed code, then write test to verify enhanced health check includes all original fields plus new diagnostic fields

### Unit Tests

- Test provider registration with various API key configurations (all present, some missing, all missing)
- Test circuit breaker state transitions (CLOSED → OPEN → HALF_OPEN → CLOSED)
- Test error response generation when no providers are available
- Test health check response includes provider registration status and configuration diagnostics
- Test circuit breaker reset endpoint functionality

### Property-Based Tests

- Generate random API key configurations and verify diagnostic logging is correct for each scenario
- Generate random quote requests with various provider health states and verify correct error responses or data returns
- Generate random sequences of provider failures and verify circuit breaker recovery works correctly
- Test that all healthy-path scenarios (valid keys, registered providers, cache hits) produce identical behavior before and after fix

### Integration Tests

- Test full deployment flow: set Fly.io secrets → deploy service → verify providers register → make quote request → verify real data returned
- Test circuit breaker recovery: simulate failures → verify circuit breaker opens → correct configuration → verify circuit breaker recovers → verify quote requests succeed
- Test error propagation: start service with no API keys → make quote request → verify 503 error reaches frontend → verify error message displayed to user
- Test health check diagnostics: query /api/health with various provider states → verify actionable diagnostic information is present
