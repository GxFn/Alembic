import { describe, expect, test, vi } from 'vitest';
import type { AgentRunInput, AgentRunResult } from '#agent/service/index.js';
import type { BootstrapDimensionPlan } from '#workflows/bootstrap/agent-runs/BootstrapDimensionRuntimeBuilder.js';
import {
  buildBootstrapSessionExecutionInput,
  getBootstrapChildDimensionId,
  resolveBootstrapDimensionTier,
} from '#workflows/bootstrap/agent-runs/BootstrapSessionExecutionBuilder.js';

function createPlan(
  id: string,
  overrides: Partial<BootstrapDimensionPlan> = {}
): BootstrapDimensionPlan {
  return {
    dim: {
      id,
      label: `${id} Label`,
      guide: '',
      tierHint: id === 'tiered' ? 2 : undefined,
    } as BootstrapDimensionPlan['dim'],
    dimConfig: {
      id,
      label: `${id} Config`,
      outputType: 'candidate',
      allowedKnowledgeTypes: [id],
    },
    needsCandidates: true,
    dimExistingRecipes: [],
    hasExistingRecipes: false,
    prescreenDone: false,
    ...overrides,
  };
}

function getCoordination(input: AgentRunInput) {
  return input.context.coordination as {
    onChildResult(args: { childInput: AgentRunInput; result: AgentRunResult }): Promise<void>;
    onTierComplete(args: { tierIndex: number; childInputs: AgentRunInput[] }): void;
  };
}

describe('bootstrap session execution builder', () => {
  test('builds parent input with unskipped child plans and lazy runtime input factories', async () => {
    const planA = createPlan('a');
    const planB = createPlan('b', { hasExistingRecipes: true, prescreenDone: true });
    const resolvePlan = vi.fn((dimId: string) => ({ a: planA, b: planB })[dimId] ?? null);
    const createDimensionRunInput = vi.fn((dimId: string) => ({
      analystScopeId: `${dimId}:analyst`,
      runInput: {
        profile: { id: 'bootstrap-dimension' },
        params: { dimId, runtime: true },
        message: { role: 'internal', content: dimId },
        context: { source: 'bootstrap', runtimeSource: 'system' },
      } as AgentRunInput,
    }));
    const emitDimensionStart = vi.fn();
    const consumeDimensionResult = vi.fn();

    const { input, childExecutionState } = buildBootstrapSessionExecutionInput({
      sessionId: 'session-1',
      activeDimIds: ['a', 'b', 'skipped'],
      skippedDimIds: ['skipped'],
      concurrency: 2,
      primaryLang: 'typescript',
      projectLang: 'javascript',
      scheduler: { getTierIndex: (dimId) => (dimId === 'b' ? 1 : 0) },
      dimensionStats: {},
      resolvePlan,
      createDimensionRunInput,
      emitDimensionStart,
      consumeDimensionResult,
      consumeDimensionError: vi.fn(),
      consumeTierResult: vi.fn(),
    });

    expect(input.profile.id).toBe('bootstrap-session');
    expect(input.params?.concurrency).toBe(2);
    expect(
      (input.params?.dimensions as Array<{ id: string; tier: number }>).map((dim) => dim.id)
    ).toEqual(['a', 'b']);
    expect(input.context.lang).toBe('typescript');

    const factory = (input.context.childInputFactories as Record<string, Function>).b;
    expect(factory).toBeTypeOf('function');
    const runtimeInput = await factory({ plannedInput: {}, parentInput: input });
    expect(runtimeInput.params).toEqual({ dimId: 'b', runtime: true });
    expect(emitDimensionStart).toHaveBeenCalledWith('b');
    expect(childExecutionState.get('b')?.analystScopeId).toBe('b:analyst');
  });

  test('routes child results, errors, and tier completion callbacks', async () => {
    const plan = createPlan('a');
    const consumeDimensionResult = vi.fn();
    const consumeDimensionError = vi.fn();
    const consumeTierResult = vi.fn();
    const dimensionStats = {
      a: { status: 'completed', candidates: 1 } as unknown,
    } as Parameters<typeof buildBootstrapSessionExecutionInput>[0]['dimensionStats'];
    const { input } = buildBootstrapSessionExecutionInput({
      sessionId: 'session-1',
      activeDimIds: ['a'],
      skippedDimIds: [],
      concurrency: 1,
      scheduler: { getTierIndex: () => 0 },
      dimensionStats,
      resolvePlan: () => plan,
      createDimensionRunInput: (dimId) => ({
        analystScopeId: `${dimId}:analyst`,
        runInput: {
          profile: { id: 'bootstrap-dimension' },
          params: { dimId },
          message: { role: 'internal', content: dimId },
          context: { source: 'bootstrap', runtimeSource: 'system' },
        } as AgentRunInput,
      }),
      emitDimensionStart: vi.fn(),
      consumeDimensionResult,
      consumeDimensionError,
      consumeTierResult,
    });

    const factory = (input.context.childInputFactories as Record<string, Function>).a;
    await factory({ plannedInput: {}, parentInput: input });
    const childInput = (input.context.childContexts as Record<string, AgentRunInput['context']>).a;
    const plannedChildInput = {
      profile: { id: 'bootstrap-dimension' },
      params: { dimId: 'a' },
      message: { role: 'internal', content: 'a' },
      context: childInput,
    } as AgentRunInput;
    const coordination = getCoordination(input);

    await coordination.onChildResult({
      childInput: plannedChildInput,
      result: { status: 'ok', reply: 'done' } as AgentRunResult,
    });
    expect(consumeDimensionResult).toHaveBeenCalledWith(
      expect.objectContaining({ dimId: 'a', plan, analystScopeId: 'a:analyst' })
    );

    await coordination.onChildResult({
      childInput: plannedChildInput,
      result: { status: 'error', reply: 'failed' } as AgentRunResult,
    });
    expect(consumeDimensionError).toHaveBeenCalledWith({ dimId: 'a', err: 'failed' });

    coordination.onTierComplete({ tierIndex: 0, childInputs: [plannedChildInput] });
    expect(consumeTierResult).toHaveBeenCalledWith(0, new Map([['a', dimensionStats.a]]));
  });

  test('resolves child dimension ids, tier hints, and session abort checks', () => {
    expect(getBootstrapChildDimensionId({ params: { dimId: 'a' } } as AgentRunInput)).toBe('a');
    expect(
      getBootstrapChildDimensionId({ params: { dimId: 1 } } as unknown as AgentRunInput)
    ).toBeNull();
    expect(
      resolveBootstrapDimensionTier('tiered', createPlan('tiered').dim, { getTierIndex: () => 5 })
    ).toBe(1);
    expect(
      resolveBootstrapDimensionTier('fallback', createPlan('fallback').dim, {
        getTierIndex: () => -1,
      })
    ).toBe(0);

    const { input } = buildBootstrapSessionExecutionInput({
      sessionId: 'session-1',
      activeDimIds: [],
      skippedDimIds: [],
      concurrency: 1,
      scheduler: { getTierIndex: () => 0 },
      dimensionStats: {},
      taskManager: { isSessionValid: () => false },
      resolvePlan: () => null,
      createDimensionRunInput: vi.fn(),
      emitDimensionStart: vi.fn(),
      consumeDimensionResult: vi.fn(),
      consumeDimensionError: vi.fn(),
      consumeTierResult: vi.fn(),
    });
    expect(input.execution?.shouldAbort?.()).toBe(true);
  });
});
