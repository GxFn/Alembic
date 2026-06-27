import { timerRegistry } from '@alembic/core/events';
import Logger from '@alembic/core/logging';

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_SWEEP_CAP = 50;
const TIMER_LABEL = 'EvolutionMaintenanceSweep/tick';

type TimerHandle = ReturnType<typeof setInterval>;
type AppLogger = ReturnType<typeof Logger.getInstance>;

interface ServiceContainerLike {
  get(name: string): unknown;
}

interface StagingManagerLike {
  checkAndPromote(cap?: number): Promise<{
    promoted?: unknown[];
    rolledBack?: unknown[];
    waiting?: unknown[];
  }>;
}

interface LifecycleStateMachineLike {
  checkTimeouts(cap?: number): Promise<{
    checked?: number;
    timedOut?: unknown[];
  }>;
}

interface ProposalExecutorLike {
  checkAndExecute(cap?: number): Promise<{
    executed?: unknown[];
    expired?: unknown[];
    rejected?: unknown[];
    skipped?: unknown[];
  }>;
}

interface DecayDetectorLike {
  scanAll(cap?: number): Promise<unknown[]>;
}

export interface EvolutionMaintenanceSweepOptions {
  cap?: number;
  container: ServiceContainerLike;
  intervalMs?: number;
  logger?: Pick<AppLogger, 'debug' | 'info' | 'warn'>;
}

export interface EvolutionMaintenanceSweepDriverError {
  driver: 'staging' | 'timeouts' | 'proposals' | 'decay';
  message: string;
}

export interface EvolutionMaintenanceSweepResult {
  checkedTimeouts: number;
  decayScannedCount: number;
  driverErrors: EvolutionMaintenanceSweepDriverError[];
  durationMs: number;
  executedCount: number;
  expiredCount: number;
  promotedCount: number;
  rejectedCount: number;
  skipped: boolean;
  reason?: string;
  timedOutCount: number;
  waitingCount: number;
}

/**
 * Daemon-owned evolution maintenance sweep.
 *
 * The sweep only drives Core lifecycle/evolution services on a bounded cadence.
 * It does not alter Core judgments, transition guards, proposal policies, or
 * schema. Reactive file-change handling remains owned by FileChangeHandler.
 */
export class EvolutionMaintenanceSweep {
  readonly #cap: number;
  readonly #container: ServiceContainerLike;
  readonly #intervalMs: number;
  readonly #logger: Pick<AppLogger, 'debug' | 'info' | 'warn'>;

  #inFlight: Promise<EvolutionMaintenanceSweepResult> | null = null;
  #timer: TimerHandle | null = null;

  constructor(options: EvolutionMaintenanceSweepOptions) {
    this.#container = options.container;
    this.#logger = options.logger ?? Logger.getInstance();
    this.#intervalMs = normalizePositiveInt(options.intervalMs, DEFAULT_SWEEP_INTERVAL_MS);
    this.#cap = normalizePositiveInt(options.cap, DEFAULT_SWEEP_CAP);
  }

  start(): void {
    if (this.#timer) {
      return;
    }
    this.#timer = timerRegistry.setInterval(
      () => {
        void this.runOnce();
      },
      this.#intervalMs,
      TIMER_LABEL
    );
    this.#logger.info('[EvolutionMaintenanceSweep] periodic sweep started', {
      cap: this.#cap,
      intervalMs: this.#intervalMs,
    });
  }

  stop(): void {
    if (!this.#timer) {
      return;
    }
    timerRegistry.clear(this.#timer);
    this.#timer = null;
    this.#logger.info('[EvolutionMaintenanceSweep] periodic sweep stopped');
  }

  async runOnce(now = Date.now()): Promise<EvolutionMaintenanceSweepResult> {
    if (this.#inFlight) {
      return skipped('in-flight');
    }

    const sweep = this.#runDrivers(now).finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = sweep;
    return sweep;
  }

  async #runDrivers(startedAt: number): Promise<EvolutionMaintenanceSweepResult> {
    const errors: EvolutionMaintenanceSweepDriverError[] = [];
    const result: EvolutionMaintenanceSweepResult = {
      checkedTimeouts: 0,
      decayScannedCount: 0,
      driverErrors: errors,
      durationMs: 0,
      executedCount: 0,
      expiredCount: 0,
      promotedCount: 0,
      rejectedCount: 0,
      skipped: false,
      timedOutCount: 0,
      waitingCount: 0,
    };

    await this.#runDriver('staging', errors, async () => {
      const stagingManager = this.#container.get('stagingManager') as StagingManagerLike;
      const staging = await stagingManager.checkAndPromote(this.#cap);
      result.promotedCount = arrayLength(staging.promoted);
      result.waitingCount = arrayLength(staging.waiting);
    });

    await this.#runDriver('timeouts', errors, async () => {
      const lifecycle = this.#container.get('lifecycleStateMachine') as LifecycleStateMachineLike;
      const timeoutResult = await lifecycle.checkTimeouts(this.#cap);
      result.checkedTimeouts =
        typeof timeoutResult.checked === 'number' ? timeoutResult.checked : 0;
      result.timedOutCount = arrayLength(timeoutResult.timedOut);
    });

    await this.#runDriver('proposals', errors, async () => {
      const proposalExecutor = this.#container.get('proposalExecutor') as ProposalExecutorLike;
      const execution = await proposalExecutor.checkAndExecute(this.#cap);
      result.executedCount = arrayLength(execution.executed);
      result.expiredCount = arrayLength(execution.expired);
      result.rejectedCount = arrayLength(execution.rejected);
    });

    await this.#runDriver('decay', errors, async () => {
      const decayDetector = this.#container.get('decayDetector') as DecayDetectorLike;
      const decay = await decayDetector.scanAll(this.#cap);
      result.decayScannedCount = arrayLength(decay);
    });

    result.durationMs = Date.now() - startedAt;
    this.#logResult(result);
    return result;
  }

  async #runDriver(
    driver: EvolutionMaintenanceSweepDriverError['driver'],
    errors: EvolutionMaintenanceSweepDriverError[],
    fn: () => Promise<void>
  ): Promise<void> {
    try {
      await fn();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ driver, message });
      this.#logger.warn('[EvolutionMaintenanceSweep] driver failed', {
        driver,
        error: message,
      });
    }
  }

  #logResult(result: EvolutionMaintenanceSweepResult): void {
    const meta = {
      checkedTimeouts: result.checkedTimeouts,
      decayScannedCount: result.decayScannedCount,
      driverErrors: result.driverErrors,
      durationMs: result.durationMs,
      executedCount: result.executedCount,
      expiredCount: result.expiredCount,
      promotedCount: result.promotedCount,
      rejectedCount: result.rejectedCount,
      timedOutCount: result.timedOutCount,
      waitingCount: result.waitingCount,
    };
    if (result.driverErrors.length > 0) {
      this.#logger.warn('[EvolutionMaintenanceSweep] periodic sweep completed with errors', meta);
      return;
    }
    this.#logger.info('[EvolutionMaintenanceSweep] periodic sweep completed', meta);
  }
}

export function resolveEvolutionMaintenanceSweepCap(): number {
  return readPositiveIntEnv('ALEMBIC_EVOLUTION_MAINTENANCE_SWEEP_CAP', DEFAULT_SWEEP_CAP);
}

export function resolveEvolutionMaintenanceSweepIntervalMs(): number {
  return readPositiveIntEnv(
    'ALEMBIC_EVOLUTION_MAINTENANCE_SWEEP_INTERVAL_MS',
    DEFAULT_SWEEP_INTERVAL_MS
  );
}

function skipped(reason: string): EvolutionMaintenanceSweepResult {
  return {
    checkedTimeouts: 0,
    decayScannedCount: 0,
    driverErrors: [],
    durationMs: 0,
    executedCount: 0,
    expiredCount: 0,
    promotedCount: 0,
    reason,
    rejectedCount: 0,
    skipped: true,
    timedOutCount: 0,
    waitingCount: 0,
  };
}

function readPositiveIntEnv(envName: string, fallback: number): number {
  return normalizePositiveInt(Number.parseInt(process.env[envName] ?? '', 10), fallback);
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function arrayLength(value: unknown[] | undefined): number {
  return Array.isArray(value) ? value.length : 0;
}
