import { RECIPE_PIPELINE_EVENTS } from '@alembic/core/knowledge';
import { describe, expect, test, vi } from 'vitest';
import { registerSourceRefSyncOnGenerateCompletion } from '../../lib/recipe-pipeline/generate/execution/consumers/SourceRefSyncConsumer.js';

/** 最小 EventBus 假件：记录 on/off 并支持手动触发。 */
function makeEventBus() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  return {
    on: vi.fn((eventName: string, listener: (payload: unknown) => void) => {
      const list = listeners.get(eventName) ?? [];
      list.push(listener);
      listeners.set(eventName, list);
    }),
    off: vi.fn((eventName: string, listener: (payload: unknown) => void) => {
      const list = listeners.get(eventName) ?? [];
      listeners.set(
        eventName,
        list.filter((l) => l !== listener)
      );
    }),
    emit(eventName: string, payload: unknown) {
      for (const listener of [...(listeners.get(eventName) ?? [])]) {
        listener(payload);
      }
    },
    count(eventName: string) {
      return (listeners.get(eventName) ?? []).length;
    },
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function makeContainer(services: Record<string, unknown>) {
  return {
    get(name: string): unknown {
      if (!(name in services)) {
        // 对齐真实 ServiceContainer：未注册服务抛错，消费方必须防御式取用。
        throw new Error(`Service not registered: ${name}`);
      }
      return services[name];
    },
  };
}

const REPORT = {
  inserted: 42,
  active: 40,
  stale: 2,
  skipped: 0,
  recipesProcessed: 75,
  failed: 0,
  blockers: [],
};

describe('registerSourceRefSyncOnGenerateCompletion', () => {
  test('runs reconcile(force) once for the matching session and detaches', async () => {
    const eventBus = makeEventBus();
    const reconcile = vi.fn().mockResolvedValue(REPORT);
    const logger = makeLogger();
    const detach = registerSourceRefSyncOnGenerateCompletion({
      bootstrapSessionId: 'bs_match',
      container: makeContainer({ eventBus, sourceRefReconciler: { reconcile } }),
      logger,
    });

    expect(detach).toBeTypeOf('function');
    expect(eventBus.count(RECIPE_PIPELINE_EVENTS.allCompleted)).toBe(1);

    // 不同 session 的完成事件不触发，也不解除监听。
    eventBus.emit(RECIPE_PIPELINE_EVENTS.allCompleted, { sessionId: 'bs_other' });
    expect(reconcile).not.toHaveBeenCalled();
    expect(eventBus.count(RECIPE_PIPELINE_EVENTS.allCompleted)).toBe(1);

    eventBus.emit(RECIPE_PIPELINE_EVENTS.allCompleted, {
      sessionId: 'bs_match',
      status: 'completed',
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith({ force: true });
    // 命中后一次性解除，重复完成事件不再触发。
    expect(eventBus.count(RECIPE_PIPELINE_EVENTS.allCompleted)).toBe(0);

    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith(
        '[Bootstrap] SourceRef sync complete after bootstrap',
        expect.objectContaining({ inserted: 42, recipesProcessed: 75, status: 'completed' })
      );
    });
  });

  test('completed_with_errors still triggers reconcile (partial entries need refs)', () => {
    const eventBus = makeEventBus();
    const reconcile = vi.fn().mockResolvedValue(REPORT);
    registerSourceRefSyncOnGenerateCompletion({
      bootstrapSessionId: 'bs_partial',
      container: makeContainer({ eventBus, sourceRefReconciler: { reconcile } }),
      logger: makeLogger(),
    });

    eventBus.emit(RECIPE_PIPELINE_EVENTS.allCompleted, {
      sessionId: 'bs_partial',
      status: 'completed_with_errors',
    });
    expect(reconcile).toHaveBeenCalledWith({ force: true });
  });

  test('missing session id / event bus skips with warn and returns null', () => {
    const logger1 = makeLogger();
    expect(
      registerSourceRefSyncOnGenerateCompletion({
        container: makeContainer({ eventBus: makeEventBus() }),
        logger: logger1,
      })
    ).toBeNull();
    expect(logger1.warn).toHaveBeenCalledWith(
      '[Bootstrap] SourceRef sync hook skipped',
      expect.objectContaining({ reason: 'missing-bootstrap-session' })
    );

    const logger2 = makeLogger();
    expect(
      registerSourceRefSyncOnGenerateCompletion({
        bootstrapSessionId: 'bs_x',
        container: makeContainer({}),
        logger: logger2,
      })
    ).toBeNull();
    expect(logger2.warn).toHaveBeenCalledWith(
      '[Bootstrap] SourceRef sync hook skipped',
      expect.objectContaining({ reason: 'missing-event-bus' })
    );
  });

  test('missing reconciler at completion warns without throwing', () => {
    const eventBus = makeEventBus();
    const logger = makeLogger();
    registerSourceRefSyncOnGenerateCompletion({
      bootstrapSessionId: 'bs_norecon',
      container: makeContainer({ eventBus }),
      logger,
    });

    expect(() =>
      eventBus.emit(RECIPE_PIPELINE_EVENTS.allCompleted, { sessionId: 'bs_norecon' })
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      '[Bootstrap] SourceRef sync skipped after completion',
      expect.objectContaining({ reason: 'missing-source-ref-reconciler' })
    );
  });

  test('reconcile rejection is captured as non-blocking warn', async () => {
    const eventBus = makeEventBus();
    const logger = makeLogger();
    registerSourceRefSyncOnGenerateCompletion({
      bootstrapSessionId: 'bs_fail',
      container: makeContainer({
        eventBus,
        sourceRefReconciler: { reconcile: vi.fn().mockRejectedValue(new Error('db locked')) },
      }),
      logger,
    });

    eventBus.emit(RECIPE_PIPELINE_EVENTS.allCompleted, { sessionId: 'bs_fail' });
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        '[Bootstrap] SourceRef sync failed after bootstrap (non-blocking)',
        expect.objectContaining({ error: 'db locked' })
      );
    });
  });
});
