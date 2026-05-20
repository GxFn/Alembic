import { describe, expect, test, vi } from 'vitest';
import { BootstrapEventEmitter } from '../../lib/service/bootstrap/BootstrapEventEmitter.js';

describe('BootstrapEventEmitter task routing', () => {
  test('routes non-normal dimension completion payloads to failed task tracking', () => {
    const markTaskCompleted = vi.fn();
    const markTaskFailed = vi.fn();
    const emit = vi.fn();
    const emitter = new BootstrapEventEmitter({
      get(name: string) {
        if (name === 'bootstrapTaskManager') {
          return { markTaskCompleted, markTaskFailed };
        }
        if (name === 'eventBus') {
          return { emit };
        }
        return null;
      },
    });

    emitter.emitDimensionComplete('api', {
      type: 'candidate',
      extracted: 0,
      created: 0,
      status: 'degraded_no_findings',
      reason: 'record repair did not produce findings',
      degraded: true,
      durationMs: 1200,
      toolCallCount: 3,
      source: 'enhanced-pipeline-strategy',
    });

    expect(markTaskCompleted).not.toHaveBeenCalled();
    expect(markTaskFailed).toHaveBeenCalledWith(
      'api',
      'record repair did not produce findings',
      expect.objectContaining({
        status: 'degraded_no_findings',
        created: 0,
      })
    );
    expect(emit).toHaveBeenCalledWith(
      'bootstrap:task-completed',
      expect.objectContaining({
        dimensionId: 'api',
        status: 'degraded_no_findings',
      })
    );
  });
});
