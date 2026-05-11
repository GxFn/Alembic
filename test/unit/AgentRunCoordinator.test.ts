import { describe, expect, test, vi } from 'vitest';
import {
  AgentProfileCompiler,
  AgentProfileRegistry,
  AgentRunCoordinator,
  type AgentRunInput,
  AgentStageFactoryRegistry,
} from '../../lib/agent/service/index.js';

function createCompiler() {
  return new AgentProfileCompiler({
    profileRegistry: new AgentProfileRegistry(),
    stageFactoryRegistry: new AgentStageFactoryRegistry(),
  });
}

function makeBootstrapSessionInput(): AgentRunInput {
  return {
    profile: { id: 'bootstrap-session' },
    params: {
      sharedParam: 'kept',
      dimensions: [
        {
          id: 'overview',
          label: 'Overview',
          tier: 0,
          params: { needsCandidates: true, hasExistingRecipes: false, prescreenDone: false },
        },
        {
          id: 'api',
          label: 'API',
          tier: 1,
          params: { needsCandidates: false, hasExistingRecipes: false, prescreenDone: false },
        },
      ],
    },
    message: {
      role: 'internal',
      content: 'Bootstrap session',
      sessionId: 'session-1',
      metadata: { sessionId: 'session-1' },
    },
    context: {
      source: 'bootstrap',
      runtimeSource: 'system',
      lang: 'ts',
      promptContext: { project: 'Alembic' },
      childContexts: {
        overview: {
          fileCache: [{ name: 'a.ts', relativePath: 'a.ts', content: 'export {}' }],
          promptContext: { dimensionScopeId: 'overview:analyst' },
        },
        api: {
          promptContext: { dimensionScopeId: 'api:analyst' },
        },
      },
    },
    presentation: { responseShape: 'system-task-result' },
  };
}

describe('AgentRunCoordinator', () => {
  test('partitions bootstrap-session into isolated bootstrap-dimension child runs', async () => {
    const coordinator = new AgentRunCoordinator();
    const profile = createCompiler().compile({ id: 'bootstrap-session' });
    const runChild = vi.fn(async (input: AgentRunInput) => ({
      runId: `${input.params?.dimId}:run`,
      profileId: input.profile.id || 'unknown',
      reply: String(input.params?.dimId),
      status: 'success' as const,
      phases: { dimId: input.params?.dimId },
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2, iterations: 3, durationMs: 4 },
      diagnostics: null,
    }));

    const result = await coordinator.run(makeBootstrapSessionInput(), profile, runChild);

    expect(runChild).toHaveBeenCalledTimes(2);
    expect(runChild.mock.calls[0][0]).toMatchObject({
      profile: { id: 'bootstrap-dimension' },
      params: {
        sharedParam: 'kept',
        dimId: 'overview',
        tier: 0,
        needsCandidates: true,
      },
      context: {
        source: 'bootstrap',
        fileCache: [{ name: 'a.ts', relativePath: 'a.ts', content: 'export {}' }],
        promptContext: {
          project: 'Alembic',
          dimensionScopeId: 'overview:analyst',
          dimId: 'overview',
          dimensionId: 'overview',
        },
      },
    });
    expect(result).toMatchObject({
      profileId: 'bootstrap-session',
      reply: 'overview\n\napi',
      status: 'success',
      usage: { inputTokens: 2, outputTokens: 4, iterations: 6, durationMs: 8 },
      phases: {
        dimensionResults: {
          overview: { runId: 'overview:run' },
          api: { runId: 'api:run' },
        },
      },
    });
  });

  test('runs bootstrap-session children tier by tier', async () => {
    const coordinator = new AgentRunCoordinator();
    const profile = createCompiler().compile({ id: 'bootstrap-session' });
    const active: string[] = [];
    const completed: string[] = [];
    const runChild = vi.fn(async (input: AgentRunInput) => {
      const dimId = String(input.params?.dimId);
      active.push(dimId);
      if (dimId === 'api') {
        expect(completed).toContain('overview');
      }
      completed.push(dimId);
      return {
        runId: `${dimId}:run`,
        profileId: 'bootstrap-dimension',
        reply: dimId,
        status: 'success' as const,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, iterations: 0, durationMs: 0 },
        diagnostics: null,
      };
    });

    await coordinator.run(makeBootstrapSessionInput(), profile, runChild);

    expect(active).toEqual(['overview', 'api']);
  });

  test('calls runtime coordination hooks after child and tier completion', async () => {
    const coordinator = new AgentRunCoordinator();
    const profile = createCompiler().compile({ id: 'bootstrap-session' });
    const events: string[] = [];
    const input = makeBootstrapSessionInput();
    input.context.coordination = {
      onChildResult: ({ childInput, result }) => {
        events.push(`child:${childInput.params?.dimId}:${result.runId}`);
      },
      onTierComplete: ({ tierIndex, results }) => {
        events.push(`tier:${tierIndex}:${results.map((result) => result.runId).join(',')}`);
      },
    };
    const runChild = vi.fn(async (childInput: AgentRunInput) => {
      const dimId = String(childInput.params?.dimId);
      return {
        runId: `${dimId}:run`,
        profileId: 'bootstrap-dimension',
        reply: dimId,
        status: 'success' as const,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, iterations: 0, durationMs: 0 },
        diagnostics: null,
      };
    });

    await coordinator.run(input, profile, runChild);

    expect(events).toEqual([
      'child:overview:overview:run',
      'tier:0:overview:run',
      'child:api:api:run',
      'tier:1:api:run',
    ]);
  });

  test('resolves lazy child input factory only when the child executes', async () => {
    const coordinator = new AgentRunCoordinator();
    const profile = createCompiler().compile({ id: 'bootstrap-session' });
    const input = makeBootstrapSessionInput();
    const factory = vi.fn(({ plannedInput }: { plannedInput: AgentRunInput }) => ({
      ...plannedInput,
      context: {
        ...plannedInput.context,
        promptContext: {
          ...(plannedInput.context.promptContext || {}),
          createdLazily: true,
        },
      },
    }));
    input.context.childInputFactories = { overview: factory };
    const runChild = vi.fn(async (childInput: AgentRunInput) => ({
      runId: `${childInput.params?.dimId}:run`,
      profileId: 'bootstrap-dimension',
      reply: String(childInput.context.promptContext?.createdLazily || false),
      status: 'success' as const,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, iterations: 0, durationMs: 0 },
      diagnostics: null,
    }));

    expect(factory).not.toHaveBeenCalled();

    await coordinator.run(input, profile, runChild);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(runChild.mock.calls[0][0].context.promptContext).toMatchObject({
      createdLazily: true,
    });
    expect(runChild.mock.calls[1][0].context.promptContext).not.toHaveProperty('createdLazily');
  });

  test('stops before the next tier when execution shouldAbort becomes true', async () => {
    const coordinator = new AgentRunCoordinator();
    const profile = createCompiler().compile({ id: 'bootstrap-session' });
    const input = makeBootstrapSessionInput();
    let stopAfterFirstTier = false;
    input.execution = {
      shouldAbort: () => stopAfterFirstTier,
    };
    input.context.coordination = {
      onTierComplete: () => {
        stopAfterFirstTier = true;
      },
    };
    const runChild = vi.fn(async (childInput: AgentRunInput) => ({
      runId: `${childInput.params?.dimId}:run`,
      profileId: 'bootstrap-dimension',
      reply: String(childInput.params?.dimId),
      status: 'success' as const,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, iterations: 0, durationMs: 0 },
      diagnostics: null,
    }));

    const result = await coordinator.run(input, profile, runChild);

    expect(runChild).toHaveBeenCalledTimes(1);
    expect(runChild.mock.calls[0][0].params?.dimId).toBe('overview');
    expect(result?.phases?.dimensionResults).toEqual({
      overview: expect.objectContaining({ runId: 'overview:run' }),
      api: expect.objectContaining({ runId: 'api:aborted', status: 'aborted' }),
    });
    expect(result?.status).toBe('aborted');
  });

  test('stops after lazy child input resolution when execution shouldAbort becomes true', async () => {
    const coordinator = new AgentRunCoordinator();
    const profile = createCompiler().compile({ id: 'bootstrap-session' });
    const input = makeBootstrapSessionInput();
    let lazyResolved = false;
    input.params = {
      dimensions: [
        {
          id: 'overview',
          label: 'Overview',
          tier: 0,
          params: { needsCandidates: true, hasExistingRecipes: false, prescreenDone: false },
        },
      ],
    };
    input.execution = {
      shouldAbort: () => lazyResolved,
    };
    input.context.childInputFactories = {
      overview: ({ plannedInput }) => {
        lazyResolved = true;
        return plannedInput;
      },
    };
    const runChild = vi.fn(async (childInput: AgentRunInput) => ({
      runId: `${childInput.params?.dimId}:run`,
      profileId: 'bootstrap-dimension',
      reply: String(childInput.params?.dimId),
      status: 'success' as const,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, iterations: 0, durationMs: 0 },
      diagnostics: null,
    }));

    const result = await coordinator.run(input, profile, runChild);

    expect(input.context.childInputFactories.overview).toBeDefined();
    expect(runChild).not.toHaveBeenCalled();
    expect(result?.phases?.dimensionResults).toEqual({
      overview: expect.objectContaining({ runId: 'overview:aborted', status: 'aborted' }),
    });
    expect(result?.status).toBe('aborted');
  });

  test('converts child input factory errors into child error results', async () => {
    const coordinator = new AgentRunCoordinator();
    const profile = createCompiler().compile({ id: 'bootstrap-session' });
    const input = makeBootstrapSessionInput();
    const events: string[] = [];
    input.params = {
      dimensions: [
        {
          id: 'overview',
          label: 'Overview',
          tier: 0,
          params: { needsCandidates: true, hasExistingRecipes: false, prescreenDone: false },
        },
      ],
    };
    input.context.childInputFactories = {
      overview: () => {
        throw new Error('scope failed');
      },
    };
    input.context.coordination = {
      onChildResult: ({ childInput, result }) => {
        events.push(`${childInput.params?.dimId}:${result.status}:${result.reply}`);
      },
    };
    const runChild = vi.fn();

    const result = await coordinator.run(input, profile, runChild);

    expect(runChild).not.toHaveBeenCalled();
    expect(events).toEqual(['overview:error:scope failed']);
    expect(result).toMatchObject({
      status: 'error',
      phases: {
        dimensionResults: {
          overview: { status: 'error', reply: 'scope failed' },
        },
      },
    });
  });
});
