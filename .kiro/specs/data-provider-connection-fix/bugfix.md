# Bugfix Requirements Document

## Introduction

The data-service microservice is unable to fetch real-time market data from external providers (TwelveData, Unusual Whales, Polygon, FRED), causing the system to return guessed/fallback prices for equity symbols (SPY, IWM, QQQ) instead of live market data. This affects the accuracy of options contract pricing and trade simulations displayed at https://optionpartners.fly.dev/sim/trades.

The root cause is that data providers only register if their API keys are non-empty strings. When API keys are missing, not set in Fly.io secrets, or are empty strings, no providers register. When a quote request is made, the DataOrchestrator finds no eligible providers and throws a "No available providers for capability" error, causing downstream systems to fall back to estimated pricing.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN API keys for data providers (TWELVE_DATA_API_KEY, UNUSUAL_WHALES_API_KEY, POLYGON_API_KEY) are not set or are empty strings in Fly.io secrets THEN the system does not register any providers during service initialization

1.2 WHEN a quote request is made for symbols (SPY, IWM, QQQ) and no providers are registered THEN the DataOrchestrator throws "No available providers for capability: quotes" error

1.3 WHEN the DataOrchestrator throws "No available providers" error THEN the backend proxy or frontend falls back to guessed/mock pricing instead of returning an error or real data

1.4 WHEN providers fail to authenticate with external APIs due to invalid or missing API keys THEN the circuit breaker opens after 3 consecutive failures, blocking all subsequent requests for 30-60 seconds

1.5 WHEN the circuit breaker is in OPEN state THEN all quote requests fail with "Circuit breaker OPEN" error even if API keys are later corrected

### Expected Behavior (Correct)

2.1 WHEN API keys for data providers are properly set in Fly.io secrets and the data-service starts THEN the system SHALL register all providers with valid API keys and log successful registration

2.2 WHEN a quote request is made for symbols (SPY, IWM, QQQ) and at least one provider is registered THEN the DataOrchestrator SHALL successfully fetch real-time market data from the registered provider

2.3 WHEN a quote request is made and providers are unavailable or fail THEN the system SHALL return a clear error response (503 Service Unavailable) instead of falling back to guessed pricing

2.4 WHEN API keys are missing or empty during service initialization THEN the system SHALL log clear warning messages indicating which providers failed to register and why

2.5 WHEN providers fail authentication with external APIs THEN the system SHALL log the authentication failure with actionable error messages (e.g., "Invalid API key", "API key not set")

2.6 WHEN the circuit breaker opens due to provider failures THEN the system SHALL provide a way to reset the circuit breaker state or automatically recover when the underlying issue is resolved

### Unchanged Behavior (Regression Prevention)

3.1 WHEN API keys are correctly configured and providers are healthy THEN the system SHALL CONTINUE TO fetch and cache market data with the existing fallback priority (TwelveData → Unusual Whales → Polygon)

3.2 WHEN cached data is available and fresh THEN the system SHALL CONTINUE TO return cached data without making external API calls

3.3 WHEN multiple providers are registered and the primary provider fails THEN the system SHALL CONTINUE TO automatically fall back to secondary providers in priority order

3.4 WHEN the circuit breaker is in CLOSED state and providers are healthy THEN the system SHALL CONTINUE TO process quote requests with normal latency and success rates

3.5 WHEN rate limits are reached for a provider THEN the system SHALL CONTINUE TO respect rate limits and fall back to alternative providers

3.6 WHEN the database or Redis is unavailable THEN the system SHALL CONTINUE TO operate with in-memory caching and without snapshot persistence

3.7 WHEN health check requests are made to /api/health THEN the system SHALL CONTINUE TO return provider health status including circuit breaker state, success rates, and rate limit information
