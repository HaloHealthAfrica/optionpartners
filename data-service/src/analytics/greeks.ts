/**
 * Greeks calculation utilities using Black-Scholes model
 *
 * This provides consistent Greeks calculations across all providers.
 * All providers should use these functions instead of maintaining their own copies.
 */

export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/**
 * Standard normal cumulative distribution function
 */
function normCdf(x: number): number {
  if (x > 6) return 1;
  if (x < -6) return 0;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-absX * absX);

  return 0.5 * (1 + sign * erf);
}

/**
 * Calculate option Greeks using Black-Scholes model
 *
 * @param type - 'call' or 'put'
 * @param S - Underlying price
 * @param K - Strike price
 * @param T - Time to expiration in years
 * @param sigma - Implied volatility (as decimal, e.g. 0.20 for 20%)
 * @param r - Risk-free rate (default 4.5%)
 * @returns Object with delta, gamma, theta, vega
 */
export function calculateGreeks(
  type: 'call' | 'put',
  S: number,
  K: number,
  T: number,
  sigma: number,
  r = 0.045,
): Greeks {
  // Handle edge cases
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    const intrinsic = type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return { delta: type === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, theta: 0, vega: 0 };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const nd1pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);

  const delta = type === 'call' ? nd1 : nd1 - 1;
  const gamma = nd1pdf / (S * sigma * sqrtT);

  // Theta calculation (daily decay)
  const theta = (-(S * nd1pdf * sigma) / (2 * sqrtT) -
    r * K * Math.exp(-r * T) * normCdf(type === 'call' ? d2 : -d2) * (type === 'call' ? 1 : -1)) / 365;

  // Vega (change per 1% change in volatility)
  const vega = S * nd1pdf * sqrtT / 100;

  return {
    delta: Math.round(delta * 10000) / 10000,
    gamma: Math.round(gamma * 10000) / 10000,
    theta: Math.round(theta * 10000) / 10000,
    vega: Math.round(vega * 10000) / 10000,
  };
}

/**
 * Calculate time to expiration in years
 *
 * @param expiryDate - Expiration date
 * @param now - Current time (default Date.now())
 * @returns Time to expiration in years
 */
export function calculateTimeToExpiration(expiryDate: Date, now = Date.now()): number {
  return Math.max(0, (expiryDate.getTime() - now) / (365.25 * 24 * 60 * 60 * 1000));
}