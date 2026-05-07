import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { runWorkflowCompletionFinalizer } from '#workflows/capabilities/completion/WorkflowCompletionFinalizer.js';
import { buildInternalDimensionCompletionSummary } from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillFinalizer.js';

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

  test('can skip target delivery and wiki while keeping scheduled semantic memory', async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];

    const result = await runWorkflowCompletionFinalizer({
      ctx: { container: { get: () => undefined } },
      session: { id: 'session-1' },
      projectRoot: process.cwd(),
      dataRoot: process.cwd(),
      log: { info: vi.fn(), warn: vi.fn() },
      dependencies: {
        getServiceContainer: () => createContainer(events),
        scheduleTask: (task) => scheduled.push(task),
      },
      steps: { delivery: 'skip', wiki: 'skip' },
    });

    expect(events).toEqual(['panorama:rescan', 'panorama:overview']);
    expect(scheduled).toHaveLength(1);
    expect(result).toMatchObject({
      deliveryVerification: null,
      deliveryStatus: 'skipped',
      wikiStatus: 'skipped',
      panoramaStatus: 'completed',
    });
  });

  test('internal finalizer delegates completion side effects to workflow finalizer', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'lib/workflows/capabilities/execution/internal-agent/InternalDimensionFillFinalizer.ts'
      ),
      'utf8'
    );

    expect(source).toContain('runWorkflowCompletionFinalizer');
    expect(source).not.toContain('consumeBootstrapDeliveryAndWiki');
    expect(source).not.toContain('consumeBootstrapSemanticMemory');
  });

  test('summarizes rescan finalizer as pipeline isolation', () => {
    expect(
      buildInternalDimensionCompletionSummary({
        pipelineMode: 'rescan',
        workflowCompletion: { deliveryVerification: null, semanticMemoryResult: null },
      })
    ).toMatchObject({
      mode: 'rescan',
      isolation: 'pipeline-isolation',
      delivery: { status: 'skipped' },
      wiki: { status: 'skipped' },
      semanticMemory: { status: 'skipped' },
    });
  });

  test('summarizes bootstrap finalizer as full completion', () => {
    expect(
      buildInternalDimensionCompletionSummary({
        pipelineMode: 'bootstrap',
        workflowCompletion: {
          deliveryVerification: { ok: true } as never,
          semanticMemoryResult: {
            total: { added: 1, updated: 0, merged: 0, skipped: 0 },
            durationMs: 10,
          },
        },
      })
    ).toMatchObject({
      mode: 'bootstrap',
      isolation: 'full-completion',
      delivery: { status: 'completed' },
      wiki: { status: 'scheduled' },
      semanticMemory: { status: 'completed' },
    });
  });

  test('summarizes skipped bootstrap delivery and wiki from finalizer result', () => {
    expect(
      buildInternalDimensionCompletionSummary({
        pipelineMode: 'bootstrap',
        workflowCompletion: {
          deliveryVerification: null,
          semanticMemoryResult: null,
          deliveryStatus: 'skipped',
          wikiStatus: 'skipped',
        },
      })
    ).toMatchObject({
      mode: 'bootstrap',
      isolation: 'full-completion',
      delivery: { status: 'skipped' },
      wiki: { status: 'skipped' },
      semanticMemory: { status: 'skipped' },
    });
  });

  test('keeps completion side effects in dedicated step modules', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib/workflows/capabilities/completion/WorkflowCompletionFinalizer.ts'),
      'utf8'
    );

    expect(source).toContain('CompletionSteps.js');
    expect(source).toContain('runCursorDelivery');
    expect(source).toContain('verifyDelivery');
    expect(source).toContain('refreshPanorama');
    expect(source).toContain('generateWiki');
    expect(source).toContain('consolidateSemanticMemory');
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
