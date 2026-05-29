import type { AgentRunInput, AgentRunResult } from '@alembic/agent/service';
import { describe, expect, test, vi } from 'vitest';
import type { BootstrapDimensionPlan } from '../../lib/workflows/capabilities/execution/internal-agent/BootstrapDimensionRuntimeBuilder.js';
import {
  attachBootstrapAgentProgressBridge,
  buildBootstrapSessionExecutionInput,
  getBootstrapChildDimensionId,
  resolveBootstrapDimensionTier,
} from '../../lib/workflows/capabilities/execution/internal-agent/BootstrapSessionExecutionBuilder.js';

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

type ChildInputFactory = (args: {
  plannedInput: Record<string, unknown>;
  parentInput: AgentRunInput;
}) => AgentRunInput | Promise<AgentRunInput>;

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
    const dimensionStats: Parameters<
      typeof buildBootstrapSessionExecutionInput
    >[0]['dimensionStats'] = {};

    const { input, childExecutionState } = buildBootstrapSessionExecutionInput({
      sessionId: 'session-1',
      activeDimIds: ['a', 'b', 'skipped'],
      skippedDimIds: ['skipped'],
      concurrency: 2,
      primaryLang: 'typescript',
      projectLang: 'javascript',
      scheduler: { getTierIndex: (dimId) => (dimId === 'b' ? 1 : 0) },
      dimensionStats,
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
    expect(
      (input.params?.dimensions as Array<{ promptContext: Record<string, unknown> }>)[0]
    ).toMatchObject({
      promptContext: {
        pcvStageNodeMap: {
          analyze: {
            pcvNodeId: 'pcvm:n9:analyze',
            chainNodeId: 'pcvm:cold-start:n9',
          },
        },
        pcvChainNodes: {
          produce: {
            pcvNodeId: 'pcvm:n11:produce',
            chainNodeId: 'pcvm:cold-start:n11',
          },
        },
      },
    });
    expect(
      (input.context.childContexts as Record<string, Record<string, unknown>>).b
    ).toMatchObject({
      pcvStageNodeMap: {
        quality_gate: {
          pcvNodeId: 'pcvm:n9:quality_gate',
          chainNodeId: 'pcvm:cold-start:n9:quality',
        },
      },
      pcvChainNodes: {
        record_repair: {
          pcvNodeId: 'pcvm:n9:record_repair',
          chainNodeId: 'pcvm:cold-start:n9:repair',
        },
      },
    });

    const factory = (input.context.childInputFactories as Record<string, ChildInputFactory>).b;
    expect(factory).toBeTypeOf('function');
    const runtimeInput = await factory({ plannedInput: {}, parentInput: input });
    expect(runtimeInput.params).toEqual({ dimId: 'b', runtime: true });
    expect(runtimeInput.message.metadata?.context).toMatchObject({
      pcvStageNodeMap: {
        analyze: { pcvNodeId: 'pcvm:n9:analyze' },
        produce: { chainNodeId: 'pcvm:cold-start:n11' },
      },
      pcvChainNodes: {
        quality_gate: { pcvNodeId: 'pcvm:n9:quality_gate' },
        record_repair: { chainNodeId: 'pcvm:cold-start:n9:repair' },
      },
    });
    expect(runtimeInput.context.strategyContext).toMatchObject({
      pcvStageNodeMap: {
        analyze: { chainNodeId: 'pcvm:cold-start:n9' },
      },
      pcvChainNodes: {
        produce: { pcvNodeId: 'pcvm:n11:produce' },
      },
      sharedState: {
        _pcvStageNodeMap: {
          record_repair: { pcvNodeId: 'pcvm:n9:record_repair' },
        },
        _pcvChainNodes: {
          quality_gate: { chainNodeId: 'pcvm:cold-start:n9:quality' },
        },
      },
    });
    expect(emitDimensionStart).toHaveBeenCalledWith('b');
    expect(childExecutionState.get('b')?.analystScopeId).toBe('b:analyst');
    expect(dimensionStats.b).toMatchObject({
      pcvNodeEvidence: {
        n8: {
          nodeId: 'N8-stage-factory-tool-policy',
          producerToolRestriction: { noTerminalProof: true },
          stageOrder: ['analyze', 'quality_gate', 'produce', 'rejection_gate'],
          status: 'linked',
        },
      },
    });
  });

  test('bridges developer-safe Agent progress through shared dimension child input path', async () => {
    const plan = createPlan('a');
    const emitProcessEvents = vi.fn();
    const previousOnProgress = vi.fn();
    const { input } = buildBootstrapSessionExecutionInput({
      sessionId: 'session-1',
      activeDimIds: ['a'],
      skippedDimIds: [],
      concurrency: 1,
      scheduler: { getTierIndex: () => 0 },
      dimensionStats: {},
      resolvePlan: () => plan,
      createDimensionRunInput: (dimId) => ({
        analystScopeId: `${dimId}:analyst`,
        runInput: {
          profile: { id: 'bootstrap-dimension' },
          params: { dimId },
          message: { role: 'internal', content: dimId },
          context: { source: 'bootstrap', runtimeSource: 'system' },
          execution: { onProgress: previousOnProgress },
        } as AgentRunInput,
      }),
      emitDimensionStart: vi.fn(),
      consumeDimensionResult: vi.fn(),
      consumeDimensionError: vi.fn(),
      consumeTierResult: vi.fn(),
      emitProcessEvents,
    });

    const factory = (input.context.childInputFactories as Record<string, ChildInputFactory>).a;
    const runtimeInput = await factory({ plannedInput: {}, parentInput: input });
    emitProcessEvents.mockClear();
    runtimeInput.execution?.onProgress?.({
      type: 'agent_process_event',
      agentId: 'agent_1',
      preset: 'insight',
      timestamp: 1,
      processEvent: {
        content: { role: 'developer', text: '阶段转换到 VERIFY' },
        createdAt: '2026-05-24T10:00:00.000Z',
        dimensionId: 'a',
        displayPolicy: 'full',
        kind: 'llm.reflection',
        metadata: { semanticKind: 'transition-nudge' },
        phase: 'VERIFY',
        retention: 'job-retained',
        severity: 'info',
        sourceClass: 'developer-facing',
        summary: '阶段机切换后注入 VERIFY 阶段指令。',
        targetName: 'a Config',
        title: 'Agent 阶段转换 Nudge: VERIFY',
      },
    });

    expect(previousOnProgress).toHaveBeenCalled();
    expect(emitProcessEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensionId: 'a',
        sessionId: 'session-1',
        source: 'bootstrap-agent-progress',
        targetName: 'a Config',
        taskId: 'a',
        events: [
          expect.objectContaining({
            kind: 'llm.reflection',
            metadata: expect.objectContaining({
              semanticKind: 'transition-nudge',
              sessionId: 'session-1',
            }),
            phase: 'VERIFY',
            title: 'Agent 阶段转换 Nudge: VERIFY',
          }),
        ],
      })
    );
  });

  test('agent progress bridge is a no-op when process event emission is unavailable', () => {
    const runInput = {
      profile: { id: 'bootstrap-dimension' },
      message: { role: 'internal', content: 'a' },
      context: { source: 'bootstrap', runtimeSource: 'system' },
    } as AgentRunInput;

    expect(
      attachBootstrapAgentProgressBridge({
        dimId: 'a',
        runInput,
        sessionId: 'session-1',
      })
    ).toBe(runInput);
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

    const factory = (input.context.childInputFactories as Record<string, ChildInputFactory>).a;
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
    expect(consumeDimensionError).toHaveBeenCalledWith({
      dimId: 'a',
      err: expect.objectContaining({ status: 'error', reason: 'failed' }),
    });

    await coordination.onChildResult({
      childInput: plannedChildInput,
      result: { status: 'timeout', reply: 'stage_timeout' } as AgentRunResult,
    });
    expect(consumeDimensionError).toHaveBeenCalledWith({
      dimId: 'a',
      err: expect.objectContaining({ status: 'timeout', reason: 'stage_timeout' }),
    });

    const successfulSubmit = {
      tool: 'knowledge',
      args: {
        action: 'submit',
        params: { title: 'Accepted candidate' },
      },
      result: { status: 'created' },
    };
    await coordination.onChildResult({
      childInput: plannedChildInput,
      result: {
        status: 'success',
        reply: '[run stopped: stage_timeout]',
        phases: {
          quality_gate: {
            artifact: {
              analysisText: 'analysis with enough content for a produced candidate',
              referencedFiles: ['src/a.ts'],
              findings: ['finding'],
            },
          },
          produce: {
            reply: '[run stopped: stage_timeout]',
            toolCalls: [successfulSubmit],
          },
        },
        toolCalls: [successfulSubmit],
        usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
        diagnostics: {
          degraded: false,
          fallbackUsed: false,
          warnings: [],
          timedOutStages: ['produce'],
          blockedTools: [],
          truncatedToolCalls: 0,
          emptyResponses: 0,
          aiErrorCount: 0,
          gateFailures: [],
        },
      } as AgentRunResult,
    });
    expect(consumeDimensionResult).toHaveBeenCalledTimes(2);
    expect(consumeDimensionError).toHaveBeenCalledTimes(2);

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

  test('does not start a lazy child input after the bootstrap session is cancelled', () => {
    const plan = createPlan('a');
    const createDimensionRunInput = vi.fn();
    const emitDimensionStart = vi.fn();
    const { input } = buildBootstrapSessionExecutionInput({
      sessionId: 'session-1',
      activeDimIds: ['a'],
      skippedDimIds: [],
      concurrency: 1,
      scheduler: { getTierIndex: () => 0 },
      dimensionStats: {},
      taskManager: {
        isSessionValid: () => true,
        isUserCancelled: () => true,
      },
      resolvePlan: () => plan,
      createDimensionRunInput,
      emitDimensionStart,
      consumeDimensionResult: vi.fn(),
      consumeDimensionError: vi.fn(),
      consumeTierResult: vi.fn(),
    });

    const factory = (input.context.childInputFactories as Record<string, ChildInputFactory>).a;

    expect(() => factory({ plannedInput: {}, parentInput: input })).toThrow(
      'Bootstrap session cancelled'
    );
    expect(emitDimensionStart).not.toHaveBeenCalled();
    expect(createDimensionRunInput).not.toHaveBeenCalled();
  });

  test('resolveBootstrapDimensionTier maps tierHint to 0-based tier index', () => {
    const makeTestDim = (tierHint?: number) =>
      ({ id: 'test', label: 'Test', tierHint }) as BootstrapDimensionPlan['dim'];

    expect(resolveBootstrapDimensionTier('arch', makeTestDim(1), { getTierIndex: () => 0 })).toBe(
      0
    );
    expect(resolveBootstrapDimensionTier('code', makeTestDim(2), { getTierIndex: () => 0 })).toBe(
      1
    );
    expect(resolveBootstrapDimensionTier('err', makeTestDim(3), { getTierIndex: () => 0 })).toBe(2);
    expect(
      resolveBootstrapDimensionTier('no-hint', makeTestDim(undefined), { getTierIndex: () => 2 })
    ).toBe(2);
    expect(
      resolveBootstrapDimensionTier('neg', makeTestDim(undefined), { getTierIndex: () => -1 })
    ).toBe(0);
  });
});
