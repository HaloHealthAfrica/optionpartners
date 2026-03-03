import { describe, it, expect, beforeEach } from 'vitest';
import { DataOrchestrator } from '../services/data-orchestrator';
import { ServiceUnavailableError } from '../providers/base-provider';

/**
 * Task 3.3 Verification Test
 * 
 * Validates: Requirements 2.3
 * 
 * This test verifies that the system returns explicit 503 errors when no providers
 * are available, instead of falling back to mock pricing.
 */

describe('Task 3.3: Replace silent fallbacks with explicit 503 errors', () => {
  let orchestrator: DataOrchestrator;

  beforeEach(() => {
    orchestrator = new DataOrchestrator();
  });

  it('should throw ServiceUnavailableError when no providers are registered', async () => {
    // Bug Condition: No providers registered (registeredProviders.length == 0)
    // Expected Behavior: System returns 503 Service Unavailable error
    
    try {
      await orchestrator.getQuote('SPY');
      expect.fail('Expected ServiceUnavailableError to be thrown');
    } catch (error) {
      // Verify it's a ServiceUnavailableError
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      
      // Verify the error message is actionable
      expect((error as ServiceUnavailableError).message).toBe(
        'Market data service unavailable - no data providers configured'
      );
      
      // Verify the status code is 503
      expect((error as ServiceUnavailableError).statusCode).toBe(503);
    }
  });

  it('should throw ServiceUnavailableError for candles when no providers are registered', async () => {
    try {
      await orchestrator.getCandles('SPY', '5min', 100);
      expect.fail('Expected ServiceUnavailableError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect((error as ServiceUnavailableError).statusCode).toBe(503);
    }
  });

  it('should throw ServiceUnavailableError for options chain when no providers are registered', async () => {
    try {
      await orchestrator.getOptionsChain('SPY');
      expect.fail('Expected ServiceUnavailableError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect((error as ServiceUnavailableError).statusCode).toBe(503);
    }
  });

  it('should throw ServiceUnavailableError for GEX when no providers are registered', async () => {
    try {
      await orchestrator.getGEX('SPY');
      expect.fail('Expected ServiceUnavailableError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect((error as ServiceUnavailableError).statusCode).toBe(503);
    }
  });

  it('should throw ServiceUnavailableError for flow when no providers are registered', async () => {
    try {
      await orchestrator.getFlow('SPY');
      expect.fail('Expected ServiceUnavailableError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect((error as ServiceUnavailableError).statusCode).toBe(503);
    }
  });

  it('should throw ServiceUnavailableError for IV when no providers are registered', async () => {
    try {
      await orchestrator.getIV('SPY');
      expect.fail('Expected ServiceUnavailableError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect((error as ServiceUnavailableError).statusCode).toBe(503);
    }
  });

  it('error message should be actionable and indicate the root cause', async () => {
    try {
      await orchestrator.getQuote('SPY');
      expect.fail('Expected ServiceUnavailableError to be thrown');
    } catch (error) {
      const message = (error as Error).message;
      
      // Verify the message indicates the service is unavailable
      expect(message).toMatch(/unavailable/i);
      
      // Verify the message indicates no providers are configured
      expect(message).toMatch(/no.*providers.*configured/i);
      
      // Verify the message does NOT suggest mock/fallback data
      expect(message).not.toMatch(/mock|fallback|estimated/i);
    }
  });
});
