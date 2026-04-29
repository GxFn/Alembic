import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { runWorkflowCompletionFinalizer } from '#workflows/common-capabilities/completion/WorkflowCompletionFinalizer.js';

describe('WorkflowCompletionFinalizer', () => {
  test('runs delivery and panorama before scheduling wiki and immediate semantic memory', async () => {
    const events: string[] = [];
    const container = createContainer(events);

    const result = await runWorkflowCompletionFinalizer({
      ctx: { container: { get: () => undefined } },
      session: { id: 'session-1' },
      projectRoot: process.cwd(),
      dataRoot: process.cwd(),
      log: { info: vi.fn(), warn: vi.fn() },
      dependencies: {
        getServiceContainer: () => container,
        scheduleTask: () => events.push('schedule'),
      },
      semanticMemory: { mode: 'immediate' },
    });

    expect(events).toEqual(['delivery', 'panorama:rescan', 'panorama:overview', 'schedule']);
    expect(result.semanticMemoryResult).toBeNull();
  });

  test('scheduled semantic memory shares the same scheduler boundary as wiki', async () => {
    const scheduled: Array<() => Promise<void>> = [];

    await runWorkflowCompletionFinalizer({
      ctx: { container: { get: () => undefined } },
      session: { id: 'session-1' },
      projectRoot: process.cwd(),
      dataRoot: process.cwd(),
      log: { info: vi.fn(), warn: vi.fn() },
      dependencies: {
        getServiceContainer: () => ({ services: {}, get: () => undefined }),
        scheduleTask: (task) => scheduled.push(task),
      },
    });

    expect(scheduled).toHaveLength(2);
  });

  test('internal finalizer delegates completion side effects to workflow finalizer', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'lib/workflows/common-capabilities/agent-execution/internal/InternalDimensionFillFinalizer.ts'
      ),
      'utf8'
    );

    expect(source).toContain('runWorkflowCompletionFinalizer');
    expect(source).not.toContain('consumeBootstrapDeliveryAndWiki');
    expect(source).not.toContain('consumeBootstrapSemanticMemory');
  });

  test('keeps completion side effects in dedicated step modules', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'lib/workflows/common-capabilities/completion/WorkflowCompletionFinalizer.ts'
      ),
      'utf8'
    );

    expect(source).toContain('DeliveryCompletionStep.js');
    expect(source).toContain('DeliveryVerificationStep.js');
    expect(source).toContain('PanoramaCompletionStep.js');
    expect(source).toContain('WikiCompletionStep.js');
    expect(source).toContain('SemanticMemoryCompletionStep.js');
  });
});

function createContainer(events: string[]) {
  const pipeline = {
    deliver: vi.fn(async () => {
      events.push('delivery');
      return { channelA: { rulesCount: 1 } };
    }),
  };
  const panoramaService = {
    rescan: vi.fn(async () => {
      events.push('panorama:rescan');
    }),
    getOverview: vi.fn(async () => {
      events.push('panorama:overview');
      return { moduleCount: 1, gapCount: 0 };
    }),
  };
  return {
    services: { cursorDeliveryPipeline: true, panoramaService: true },
    get: (name: string) => {
      if (name === 'cursorDeliveryPipeline') {
        return pipeline;
      }
      if (name === 'panoramaService') {
        return panoramaService;
      }
      return undefined;
    },
  };
}
