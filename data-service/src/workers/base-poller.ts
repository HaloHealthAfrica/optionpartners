import { createChildLogger } from '../utils/logger';

export interface PollerConfig {
  name: string;
  intervalMs: number;
  enabled?: boolean;
}

export abstract class BasePoller {
  protected log;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickInProgress = false;

  constructor(protected config: PollerConfig) {
    this.log = createChildLogger(`poller:${config.name}`);
  }

  start(): void {
    if (this.running) return;
    if (this.config.enabled === false) {
      this.log.info('Poller disabled by config');
      return;
    }

    this.running = true;
    this.log.info({ intervalMs: this.config.intervalMs }, 'Poller started');

    // Run immediately, then on interval
    this.executeTick();
    this.timer = setInterval(() => this.executeTick(), this.config.intervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info('Poller stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  updateInterval(intervalMs: number): void {
    this.config.intervalMs = intervalMs;
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  private async executeTick(): Promise<void> {
    if (this.tickInProgress) {
      this.log.debug('Tick skipped — previous tick still running');
      return;
    }

    this.tickInProgress = true;
    const start = Date.now();

    try {
      await this.tick();
      this.log.debug({ durationMs: Date.now() - start }, 'Tick completed');
    } catch (err) {
      this.log.error(
        { error: err instanceof Error ? err.message : err, durationMs: Date.now() - start },
        'Tick failed',
      );
    } finally {
      this.tickInProgress = false;
    }
  }

  protected abstract tick(): Promise<void>;
}
