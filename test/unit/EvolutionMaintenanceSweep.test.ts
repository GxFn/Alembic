import { timerRegistry } from '@alembic/core/events';
import { DecayDetector } from '@alembic/core/evolution';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EvolutionMaintenanceSweep,
  resolveEvolutionMaintenanceSweepCap,
  resolveEvolutionMaintenanceSweepIntervalMs,
} from '../../lib/service/evolution/EvolutionMaintenanceSweep.js';

describe('EvolutionMaintenanceSweep', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const previousCap = process.env.ALEMBIC_EVOLUTION_MAINTENANCE_SWEEP_CAP;
  const previousInterval = process.env.ALEMBIC_EVOLUTION_MAINTENANCE_SWEEP_INTERVAL_MS;

  afterEach(() => {
    restoreEnv('ALEMBIC_EVOLUTION_MAINTENANCE_SWEEP_CAP', previousCap);
    restoreEnv('ALEMBIC_EVOLUTION_MAINTENANCE_SWEEP_INTERVAL_MS', previousInterval);
    vi.restoreAllMocks();
  });

  it('runs all bounded drivers and reports real zero-count sweeps', async () => {
    const container = createSweepContainer({
      decayResults: [],
      executionResult: { executed: [], expired: [], rejected: [] },
      stagingResult: { promoted: [], waiting: [] },
      timeoutResult: { checked: 0, timedOut: [] },
    });
    const logger = createLogger();
    const sweep = new EvolutionMaintenanceSweep({
      cap: 7,
      container,
      intervalMs: 10_000,
      logger,
    });

    const result = await sweep.runOnce(1_000);

    expect(result).toMatchObject({
      checkedTimeouts: 0,
      decayScannedCount: 0,
      driverErrors: [],
      executedCount: 0,
      expiredCount: 0,
      promotedCount: 0,
      rejectedCount: 0,
      skipped: false,
      timedOutCount: 0,
      waitingCount: 0,
    });
    expect(container.stagingManager.checkAndPromote).toHaveBeenCalledWith(7);
    expect(container.lifecycleStateMachine.checkTimeouts).toHaveBeenCalledWith(7);
    expect(container.proposalExecutor.checkAndExecute).toHaveBeenCalledWith(7);
    expect(container.decayDetector.scanAll).toHaveBeenCalledWith(7);
    expect(logger.info).toHaveBeenCalledWith(
      '[EvolutionMaintenanceSweep] periodic sweep completed',
      expect.objectContaining({
        decayScannedCount: 0,
        promotedCount: 0,
      })
    );
  });

  it('does not let one driver failure block later drivers', async () => {
    const container = createSweepContainer({
      stagingError: new Error('staging unavailable'),
      timeoutResult: { checked: 2, timedOut: [{ recipeId: 'r-timeout' }] },
      executionResult: {
        executed: [{ id: 'p-executed' }],
        expired: [],
        rejected: [{ id: 'p-rejected' }],
      },
      decayResults: [{ id: 'r-decay' }],
    });
    const logger = createLogger();
    const sweep = new EvolutionMaintenanceSweep({ cap: 5, container, logger });

    const result = await sweep.runOnce();

    expect(result.driverErrors).toEqual([{ driver: 'staging', message: 'staging unavailable' }]);
    expect(result).toMatchObject({
      checkedTimeouts: 2,
      decayScannedCount: 1,
      executedCount: 1,
      rejectedCount: 1,
      timedOutCount: 1,
    });
    expect(container.lifecycleStateMachine.checkTimeouts).toHaveBeenCalledTimes(1);
    expect(container.proposalExecutor.checkAndExecute).toHaveBeenCalledTimes(1);
    expect(container.decayDetector.scanAll).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[EvolutionMaintenanceSweep] periodic sweep completed with errors',
      expect.objectContaining({
        driverErrors: [{ driver: 'staging', message: 'staging unavailable' }],
      })
    );
  });

  it('guards reentry while a sweep is in flight', async () => {
    const deferred = Promise.withResolvers<{ promoted: unknown[]; waiting: unknown[] }>();
    const container = createSweepContainer({
      stagingResult: deferred.promise,
    });
    const sweep = new EvolutionMaintenanceSweep({ cap: 3, container, logger: createLogger() });

    const first = sweep.runOnce();
    const second = await sweep.runOnce();

    expect(second).toMatchObject({ reason: 'in-flight', skipped: true });
    deferred.resolve({ promoted: [], waiting: [] });
    await expect(first).resolves.toMatchObject({ skipped: false });
    expect(container.stagingManager.checkAndPromote).toHaveBeenCalledTimes(1);
  });

  it('registers and clears its timer through the shared timer registry', () => {
    const container = createSweepContainer();
    const sweep = new EvolutionMaintenanceSweep({
      container,
      intervalMs: 30_000,
      logger: createLogger(),
    });

    sweep.start();
    expect(timerLabels()).toContain('EvolutionMaintenanceSweep/tick');

    sweep.stop();
    expect(timerLabels()).not.toContain('EvolutionMaintenanceSweep/tick');
  });

  it('resolves cap and interval from guarded environment values', () => {
    process.env.ALEMBIC_EVOLUTION_MAINTENANCE_SWEEP_CAP = '12.9';
    process.env.ALEMBIC_EVOLUTION_MAINTENANCE_SWEEP_INTERVAL_MS = '-1';

    expect(resolveEvolutionMaintenanceSweepCap()).toBe(12);
    expect(resolveEvolutionMaintenanceSweepIntervalMs()).toBe(60_000);
  });

  it('actual Core DecayDetector drives active recipes to decaying when lifecycle is injected', async () => {
    const now = Date.now();
    const transitions: Array<Record<string, unknown>> = [];
    const knowledgeRepo = {
      findAllByLifecycles: vi.fn(async () => [
        {
          createdAt: null,
          id: 'stale-recipe',
          lifecycle: 'active',
          quality: { overall: 0.2 },
          stats: {
            authority: 1,
            hitsLast90d: 0,
            lastHitAt: now - 200 * dayMs,
          },
          title: 'Stale recipe',
        },
      ]),
    };
    const lifecycleStateMachine = {
      transition: vi.fn(async (request: Record<string, unknown>) => {
        transitions.push(request);
        return { success: true };
      }),
    };
    const detector = new DecayDetector(knowledgeRepo as never, {
      lifecycleStateMachine: lifecycleStateMachine as never,
    });

    const results = await detector.scanAll(1);

    expect(knowledgeRepo.findAllByLifecycles).toHaveBeenCalledWith(['active'], 1);
    expect(results[0]).toMatchObject({ recipeId: 'stale-recipe' });
    expect(transitions).toEqual([
      expect.objectContaining({
        recipeId: 'stale-recipe',
        targetState: 'decaying',
        trigger: 'decay-detection',
      }),
    ]);
  });
});

function createSweepContainer(
  options: {
    decayResults?: unknown[];
    executionResult?: {
      executed?: unknown[];
      expired?: unknown[];
      rejected?: unknown[];
    };
    stagingError?: Error;
    stagingResult?:
      | Promise<{ promoted?: unknown[]; waiting?: unknown[] }>
      | {
          promoted?: unknown[];
          waiting?: unknown[];
        };
    timeoutResult?: { checked?: number; timedOut?: unknown[] };
  } = {}
) {
  const stagingManager = {
    checkAndPromote: vi.fn(async () => {
      if (options.stagingError) {
        throw options.stagingError;
      }
      return options.stagingResult ?? { promoted: [{ id: 'staged' }], waiting: [] };
    }),
  };
  const lifecycleStateMachine = {
    checkTimeouts: vi.fn(async () => options.timeoutResult ?? { checked: 1, timedOut: [] }),
  };
  const proposalExecutor = {
    checkAndExecute: vi.fn(
      async () => options.executionResult ?? { executed: [], expired: [], rejected: [] }
    ),
  };
  const decayDetector = {
    scanAll: vi.fn(async () => options.decayResults ?? []),
  };
  const services: Record<string, unknown> = {
    decayDetector,
    lifecycleStateMachine,
    proposalExecutor,
    stagingManager,
  };
  return {
    decayDetector,
    get: vi.fn((name: string) => services[name]),
    lifecycleStateMachine,
    proposalExecutor,
    stagingManager,
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function timerLabels(): string[] {
  return timerRegistry.diagnostics().timers.map((timer) => timer.label);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
