import { describe, expect, test } from 'vitest';
import { AgentFactory } from '../../lib/agent/AgentFactory.js';

function createFactoryWithResult(result: Record<string, unknown>) {
  const factory = new AgentFactory({
    container: {},
    toolRegistry: {} as never,
    aiProvider: { model: 'test-model', name: 'test-provider' } as never,
    projectRoot: '/tmp/project',
  });

  factory.createRuntime = (() => ({
    execute: async () => result,
    setFileCache: () => {},
  })) as never;

  return factory;
}

describe('AgentFactory scanKnowledge diagnostics', () => {
  test('should build projected SystemRunContext for system tasks', () => {
    const factory = createFactoryWithResult({});

    const context = factory.buildSystemContext({ label: 'extract:TargetC', lang: 'swift' });
    const systemRunContext = context.systemRunContext as Record<string, unknown>;
    const sharedState = context.sharedState as Record<string, unknown>;

    expect(systemRunContext.scopeId).toBe('scan:extract:TargetC');
    expect(systemRunContext.source).toBe('system');
    expect(systemRunContext.outputType).toBe('candidate');
    expect(systemRunContext.dimId).toBe('extract:TargetC');
    expect(context.trace).toBe(context.activeContext);
    expect(systemRunContext.activeContext).toBe(context.activeContext);
    expect(systemRunContext.trace).toBe(context.trace);
    expect(sharedState._dimensionScopeId).toBe('scan:extract:TargetC');
    expect(sharedState._projectLanguage).toBe('swift');
  });

  test('should report diagnostics when collect_scan_recipe is missing and JSON fallback is used', async () => {
    const factory = createFactoryWithResult({
      reply: 'not json',
      toolCalls: [],
      phases: {
        produce: { reply: 'not json', toolCalls: [] },
      },
      iterations: 3,
      durationMs: 42,
    });

    const result = await factory.scanKnowledge({ label: 'TargetA', task: 'extract' });

    expect(result).toMatchObject({
      targetName: 'TargetA',
      extracted: 0,
      recipes: [],
      diagnostics: {
        label: 'TargetA',
        task: 'extract',
        recipesFound: 0,
        usedFallback: true,
        toolCallCount: 0,
        collectScanRecipeCallCount: 0,
        iterations: 3,
        durationMs: 42,
        phases: {
          produce: { replyLength: 8, toolCallCount: 0 },
        },
      },
    });
    expect((result.diagnostics as { parseError?: string }).parseError).toBeTruthy();
  });

  test('should report diagnostics when recipes are collected from tool calls', async () => {
    const factory = createFactoryWithResult({
      reply: '',
      toolCalls: [
        {
          tool: 'collect_scan_recipe',
          args: {},
          result: {
            status: 'collected',
            recipe: { title: 'Recipe A', description: 'Summary A', trigger: '@recipe-a' },
          },
          durationMs: 5,
        },
      ],
      iterations: 2,
      durationMs: 21,
    });

    const result = await factory.scanKnowledge({ label: 'TargetB', task: 'extract' });

    expect(result).toMatchObject({
      targetName: 'TargetB',
      extracted: 1,
      recipes: [{ title: 'Recipe A' }],
      diagnostics: {
        label: 'TargetB',
        task: 'extract',
        recipesFound: 1,
        usedFallback: false,
        parseError: null,
        toolCallCount: 1,
        collectScanRecipeCallCount: 1,
        iterations: 2,
        durationMs: 21,
      },
    });
  });
});
