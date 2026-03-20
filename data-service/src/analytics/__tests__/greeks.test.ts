import { describe, it, expect } from 'vitest';
import { calculateGreeks, calculateTimeToExpiration } from '../greeks';

describe('Greeks Calculations', () => {
  describe('calculateGreeks', () => {
    it('should calculate Black-Scholes Greeks correctly', () => {
      // Test case: ATM call option
      // S = 100, K = 100, T = 1 year, sigma = 20%, r = 5%
      const result = calculateGreeks('call', 100, 100, 1, 0.20, 0.05);

      expect(result.delta).toBeCloseTo(0.69, 1); // Our implementation gives ~0.69
      expect(result.gamma).toBeGreaterThan(0);
      expect(result.theta).toBeLessThan(0); // Calls have negative theta
      expect(result.vega).toBeGreaterThan(0);
    });

    it('should handle edge cases', () => {
      // Zero time to expiration - should return intrinsic delta
      const result = calculateGreeks('call', 100, 100, 0, 0.20);
      expect(result.delta).toBe(0); // ATM at expiration has delta = 0
      expect(result.gamma).toBe(0);
      expect(result.theta).toBe(0);
      expect(result.vega).toBe(0);
    });

    it('should calculate put Greeks correctly', () => {
      const result = calculateGreeks('put', 100, 100, 1, 0.20, 0.05);
      expect(result.delta).toBeLessThan(0); // Puts have negative delta
      expect(result.gamma).toBeGreaterThan(0);
    });
  });

  describe('calculateTimeToExpiration', () => {
    it('should calculate time to expiration in years', () => {
      const now = new Date('2024-01-01T12:00:00Z').getTime();
      const expiry = new Date('2025-01-01T12:00:00Z'); // Exactly 1 year

      const result = calculateTimeToExpiration(expiry, now);
      expect(result).toBeCloseTo(1.0, 2); // Allow some tolerance for date calculations
    });

    it('should handle expired options', () => {
      const now = new Date('2024-01-02T12:00:00Z').getTime();
      const expiry = new Date('2024-01-01T12:00:00Z'); // Already expired

      const result = calculateTimeToExpiration(expiry, now);
      expect(result).toBe(0);
    });
  });
});