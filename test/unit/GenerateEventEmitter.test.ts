import { describe, expect, test, vi } from 'vitest';
import { GenerateEventEmitter } from '../../lib/service/generate/GenerateEventEmitter.js';

describe('GenerateEventEmitter task routing', () => {
  test('routes non-normal dimension completion payloads to failed task tracking', () => {
    const markTaskCompleted = vi.fn();
    const markTaskFailed = vi.fn();
    const emit = vi.fn();
    const emitter = new GenerateEventEmitter({
      get(name: string) {
        if (name === 'generateTaskManager') {
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

  test('routes process event drafts through task manager once when available', () => {
    const emitProgress = vi.fn();
    const emit = vi.fn();
    const emitter = new GenerateEventEmitter({
      get(name: string) {
        if (name === 'generateTaskManager') {
          return { emitProgress };
        }
        if (name === 'eventBus') {
          return { emit };
        }
        return null;
      },
    });

    emitter.emitProcessEvents({
      sessionId: 'bs_1',
      dimensionId: 'api',
      events: [{ kind: 'llm.input', title: 'Input' }],
    });

    expect(emitProgress).toHaveBeenCalledWith(
      'bootstrap:process-events',
      expect.objectContaining({ sessionId: 'bs_1' })
    );
    expect(emit).not.toHaveBeenCalledWith('bootstrap:process-events', expect.anything());
  });
});
