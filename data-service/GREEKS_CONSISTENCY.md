# Greeks Consistency Implementation

## Overview
Block 4 of the data-service remediation plan addresses Greeks consistency across providers. Previously, different providers calculated option Greeks using different methods and assumptions, leading to inconsistent results.

## Changes Made

### 1. Created Shared Greeks Calculation Utility
- **File**: `src/analytics/greeks.ts`
- **Functions**:
  - `calculateGreeks()`: Black-Scholes model implementation for delta, gamma, theta, vega
  - `calculateTimeToExpiration()`: Consistent time-to-expiration calculation
  - `normCdf()`: Standard normal cumulative distribution function

### 2. Standardized Provider Implementations
Updated all providers to use the shared utility:

#### TwelveData Client (`src/providers/twelvedata-client.ts`)
- Removed duplicate `normCdf()` and `estimateGreeks()` functions
- Now uses `calculateGreeks()` and `calculateTimeToExpiration()`
- Maintains existing fallback logic for underlying price

#### Unusual Whales Client (`src/providers/unusual-whales-client.ts`)
- Removed duplicate `normCdf()` and `estimateDelta()` functions
- Now uses `calculateGreeks()` and `calculateTimeToExpiration()`
- Maintains existing fallback logic for underlying price

#### Polygon Client (`src/providers/polygon-client.ts`)
- Uses real Greeks from API (no change needed)
- Maintains existing fallback logic for underlying price

### 3. Added Comprehensive Tests
- **File**: `src/analytics/__tests__/greeks.test.ts`
- Tests Black-Scholes calculations
- Tests edge cases (expired options, invalid inputs)
- Tests time-to-expiration calculations

## Greeks Calculation Details

### Model Used
- **Black-Scholes Model**: Industry standard for European options
- **Risk-free rate**: 4.5% (default, configurable)
- **Dividend yield**: 0% (assumed)

### Parameters
- **S**: Underlying price
- **K**: Strike price
- **T**: Time to expiration (years)
- **σ (sigma)**: Implied volatility
- **r**: Risk-free rate

### Greeks Calculated
- **Delta**: Rate of change of option price with respect to underlying price
- **Gamma**: Rate of change of delta with respect to underlying price
- **Theta**: Rate of change of option price with respect to time (daily decay)
- **Vega**: Rate of change of option price with respect to volatility

### Edge Cases
- T ≤ 0: Returns intrinsic value for delta, 0 for other Greeks
- Invalid inputs (σ ≤ 0, S ≤ 0, K ≤ 0): Returns 0 for all Greeks

## Provider Comparison

| Provider | Greeks Source | Consistency |
|----------|---------------|-------------|
| TwelveData | Black-Scholes calculation | ✅ Standardized |
| Unusual Whales | Black-Scholes calculation | ✅ Standardized |
| Polygon | API-provided | ⚠️ May differ from Black-Scholes |

## Benefits

1. **Consistency**: All providers using TwelveData/Unusual Whales now calculate Greeks identically
2. **Maintainability**: Single source of truth for Greeks calculations
3. **Accuracy**: Proper Black-Scholes implementation with correct edge case handling
4. **Performance**: Eliminates code duplication

## Future Considerations

- **Polygon Greeks**: Consider whether to normalize Polygon to use Black-Scholes for consistency
- **Advanced Models**: Could extend to support more sophisticated models (e.g., with dividends)
- **Calibration**: Greeks could be calibrated against market data for improved accuracy

## Testing

All changes include comprehensive tests ensuring:
- Correct Black-Scholes calculations
- Proper edge case handling
- Consistent time calculations
- No regressions in existing functionality