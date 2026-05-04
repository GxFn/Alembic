import { describe, expect, test, vi } from 'vitest';
import { createToolPipeline } from '#agent/runtime/ToolExecutionPipeline.js';

function makeRuntime(structuredContent: Record<string, unknown>) {
  return {
    id: 'agent-1',
    presetName: 'test',
    policies: { get: vi.fn(() => null) },
    toolRouter: {
      execute: vi.fn(async () => ({
        ok: true,
        status: 'success',
        text: 'ok',
        structuredContent,
      })),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    dataRoot: '/tmp/project',
    lang: 'typescript',
    fileCache: null,
    aiProvider: null,
  };
}

function makeLoopCtx(sharedState: Record<string, unknown>) {
  return {
    allowedToolIds: ['knowledge'],
    source: 'system',
    context: { pipelinePhase: 'produce' },
    iteration: 1,
    sharedState,
    toolCalls: [],
    memoryCoordinator: null,
    diagnostics: { recordBlockedTool: vi.fn() },
    abortSignal: null,
    tracker: null,
    trace: null,
  };
}

describe('ToolExecutionPipeline knowledge submission tracking', () => {
  test('does not short-circuit duplicate-looking knowledge.submit calls before Gateway', async () => {
    const runtime = makeRuntime({ status: 'created', id: 'r-1', title: 'Existing Title' });
    const sharedState = {
      submittedTitles: new Set(['existing title']),
      submittedTriggers: new Set(['@existing-trigger']),
      submittedPatterns: new Set(),
    };
    const pipeline = createToolPipeline();

    const result = await pipeline.execute(
      {
        name: 'knowledge',
        id: 'call-1',
        args: {
          action: 'submit',
          params: {
            title: 'Existing Title',
            trigger: '@existing-trigger',
            content: { pattern: 'function existingPattern() { return true; }' },
          },
        },
      },
      { runtime, loopCtx: makeLoopCtx(sharedState), iteration: 1 } as never
    );

    expect(runtime.toolRouter.execute).toHaveBeenCalledOnce();
    expect(result.result).toMatchObject({ status: 'created', id: 'r-1' });
  });

  test('records only created submissions in session state', async () => {
    const runtime = makeRuntime({ status: 'duplicate_blocked', similar: [] });
    const sharedState = {
      submittedTitles: new Set<string>(),
      submittedTriggers: new Set<string>(),
      submittedPatterns: new Set<string>(),
    };
    const pipeline = createToolPipeline();

    await pipeline.execute(
      {
        name: 'knowledge',
        id: 'call-1',
        args: {
          action: 'submit',
          params: {
            title: 'Duplicate Title',
            trigger: '@duplicate-title',
            content: { pattern: 'function duplicatePattern() { return true; }' },
          },
        },
      },
      { runtime, loopCtx: makeLoopCtx(sharedState), iteration: 1 } as never
    );

    expect(sharedState.submittedTitles.has('duplicate title')).toBe(false);
    expect(sharedState.submittedTriggers.has('@duplicate-title')).toBe(false);
  });

  test('blocks non-manage knowledge calls during evolution decision-only retry', async () => {
    const runtime = makeRuntime({ status: 'unused' });
    const pipeline = createToolPipeline();

    const result = await pipeline.execute(
      {
        name: 'knowledge',
        id: 'call-1',
        args: {
          action: 'search',
          params: { query: 'recipe-id' },
        },
      },
      {
        runtime,
        loopCtx: makeLoopCtx({ _evolutionDecisionOnly: true }),
        iteration: 1,
      } as never
    );

    expect(runtime.toolRouter.execute).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({
      error: expect.stringContaining('decision-only'),
    });
  });

  test('allows knowledge.manage decisions during evolution decision-only retry', async () => {
    const runtime = makeRuntime({ status: 'evolution_verified' });
    const pipeline = createToolPipeline();

    const result = await pipeline.execute(
      {
        name: 'knowledge',
        id: 'call-1',
        args: {
          action: 'manage',
          params: {
            operation: 'skip_evolution',
            id: 'recipe-1',
            reason: 'verified valid',
          },
        },
      },
      {
        runtime,
        loopCtx: makeLoopCtx({ _evolutionDecisionOnly: true }),
        iteration: 1,
      } as never
    );

    expect(runtime.toolRouter.execute).toHaveBeenCalledOnce();
    expect(result.result).toMatchObject({ status: 'evolution_verified' });
  });
});
