import { performanceTracker } from './provider-performance-tracker';
import type { ProviderName } from '../types';

export type LoadBalancingStrategy = 'none' | 'round_robin' | 'weighted' | 'random';

type CapabilityKey = keyof import('../types').ProviderCapabilities;

/**
 * Simple load balancer that can rotate or weight provider selection.  Used by
 * DataOrchestrator to choose the *starting* provider for each invocation.
 *
 * Strategies:
 *  - none: always use the first provider in the supplied list
 *  - round_robin: cycle providers in order for each capability
 *  - weighted: pick a provider at random using performance-based scores as
 *    weights.  Scores are fetched from `ProviderPerformanceTracker`.
 *  - random: pick a provider uniformly at random.
 *
 * The load balancer keeps minimal state (indices for round-robin).  It does
 * not make any network requests; it simply returns a name.  If the chosen
 * provider later fails the caller will fall back to the remaining list as
 * usual.
 */
export class LoadBalancer {
  private strategy: LoadBalancingStrategy = 'none';
  private rrIndices = new Map<CapabilityKey, number>();

  setStrategy(strategy: LoadBalancingStrategy): void {
    this.strategy = strategy;
  }

  getStrategy(): LoadBalancingStrategy {
    return this.strategy;
  }

  choose(providers: ProviderName[], capability: CapabilityKey): ProviderName {
    if (providers.length === 0) {
      throw new Error('No providers available for load balancer');
    }

    switch (this.strategy) {
      case 'none':
        return providers[0];
      case 'round_robin': {
        const idx = this.rrIndices.get(capability) ?? 0;
        const choice = providers[idx % providers.length];
        this.rrIndices.set(capability, idx + 1);
        return choice;
      }
      case 'weighted':
        return this.weightedChoice(providers);
      case 'random': {
        const i = Math.floor(Math.random() * providers.length);
        return providers[i];
      }
      default:
        return providers[0];
    }
  }

  private weightedChoice(providers: ProviderName[]): ProviderName {
    // calculate weights using performance scores
    const scores = providers.map((name) => performanceTracker.calculateProviderScore(name));
    const total = scores.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      // fallback to uniform random if scoring returns zero
      const idx = Math.floor(Math.random() * providers.length);
      return providers[idx];
    }
    let r = Math.random() * total;
    for (let i = 0; i < providers.length; i++) {
      if (r < scores[i]) {
        return providers[i];
      }
      r -= scores[i];
    }
    // should not happen, but return last as a guard
    return providers[providers.length - 1];
  }
}

export const loadBalancer = new LoadBalancer();
