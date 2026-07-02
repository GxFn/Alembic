import type { ProgressEvent } from '@alembic/agent/runtime';
import type { AgentRunInput, AgentRunResult } from '@alembic/agent/service';
import Logger from '@alembic/core/logging';
import type { DimensionDef } from '@alembic/core/types';
import type { GenerateProcessEventsPayload } from '#service/generate/generate-event-types.js';
import {
  buildGenerateSessionRunInput,
  type GenerateSessionChildRunPlan,
} from './AgentRunInputBuilders.js';
import {
  buildGenerateAgentProgressProcessEvents,
  buildGenerateDimensionInputProcessEvents,
} from './AgentRunProcessEvents.js';
import {
  isRecoverableProducerTimeoutIssue,
  projectAgentRunResult,
  projectGenerateDimensionAgentOutput,
  resolveGenerateDimensionRunIssue,
} from './AgentRunProjections.js';
import type { GenerateDimensionPlan } from './DimensionRuntimeBuilder.js';
import type { DimensionStat } from './GenerateConsumers.js';
import {
  buildGeneratePcvStageNodeContext,
  buildPcvN8StageFactoryEvidence,
  buildPcvN9RecordRepairStageMapEvidence,
  mergeGeneratePcvNodeEvidence,
} from './PcvNodeEvidence.js';

const logger = Logger.getInstance();

export interface GenerateDimensionExecutionState {
  dimStartTime: number;
  analystScopeId: string;
}

export interface GenerateTaskManagerLike {
  isSessionValid(sessionId: string): boolean;
  isUserCancelled?(sessionId: string): boolean;
}

export interface BuildGenerateSessionExecutionInputOptions {
  sessionId: string;
  activeDimIds: string[];
  skippedDimIds: string[];
  concurrency: number;
  primaryLang?: string | null;
  projectLang?: string | null;
  sessionAbortSignal?: AbortSignal | null;
  // AP-7：质量验证会话（PCVM/Test）per-invocation 显式开 guard 的 opt-in；未设→不覆盖→默认 observe-only（零行为变更）。
  groundingEnforcement?: 'off' | 'guard';
  taskManager?: GenerateTaskManagerLike | null;
  scheduler: { getTierIndex(dimId: string): number };
  dimensionStats: Record<string, DimensionStat>;
  resolvePlan(dimId: string): GenerateDimensionPlan | null;
  createDimensionRunInput(
    dimId: string,
    plan: GenerateDimensionPlan
  ): { analystScopeId: string; runInput: AgentRunInput };
  emitDimensionStart(dimId: string): void;
  consumeDimensionResult(args: {
    dimId: string;
    plan: GenerateDimensionPlan;
    agentRunResult: AgentRunResult;
    dimStartTime: number;
    analystScopeId: string;
  }): Promise<unknown> | unknown;
  consumeDimensionError(args: { dimId: string; err: unknown }): unknown;
  consumeTierResult(tierIndex: number, tierResults: Map<string, DimensionStat>): unknown;
  emitProcessEvents?(payload: GenerateProcessEventsPayload): void;
}

export function buildGenerateSessionExecutionInput({
  sessionId,
  activeDimIds,
  skippedDimIds,
  concurrency,
  primaryLang,
  projectLang,
  sessionAbortSignal,
  groundingEnforcement,
  taskManager,
  scheduler,
  dimensionStats,
  resolvePlan,
  createDimensionRunInput,
  emitDimensionStart,
  consumeDimensionResult,
  consumeDimensionError,
  consumeTierResult,
  emitProcessEvents,
}: BuildGenerateSessionExecutionInputOptions) {
  const childExecutionState = new Map<string, GenerateDimensionExecutionState>();
  const children = activeDimIds
    .filter((dimId) => !skippedDimIds.includes(dimId))
    .map((dimId) =>
      buildBootstrapDimensionChildPlan({
        dimId,
        sessionId,
        primaryLang,
        projectLang,
        sessionAbortSignal,
        taskManager,
        scheduler,
        resolvePlan,
        createDimensionRunInput,
        emitDimensionStart,
        emitProcessEvents,
        dimensionStats,
        childExecutionState,
      })
    )
    .filter((plan): plan is GenerateSessionChildRunPlan => !!plan);

  const input = buildGenerateSessionRunInput({
    sessionId,
    children,
    params: {
      concurrency,
    },
    message: {
      content: 'Bootstrap session',
      metadata: { sessionId },
    },
    context: {
      lang: primaryLang || projectLang || null,
      coordination: {
        onChildResult: async ({
          childInput,
          result,
        }: {
          childInput: AgentRunInput;
          result: AgentRunResult;
        }) => {
          const dimId = getGenerateChildDimensionId(childInput);
          if (!dimId) {
            return;
          }
          const runIssue = resolveGenerateDimensionRunIssue(result, { includeDegraded: false });
          logger.info('[Insight-v3] Dimension child result received', {
            sessionId,
            dimension: dimId,
            status: result.status,
            profileId: result.profileId,
            toolCallCount: getAgentRunToolCallCount(result),
            durationMs: result.usage?.durationMs ?? null,
            iterations: result.usage?.iterations ?? null,
            runIssue: runIssue || null,
            diagnostics: summarizeDiagnostics(result.diagnostics),
          });
          const plan = resolvePlan(dimId);
          const state = childExecutionState.get(dimId);
          if (!plan || !state) {
            if (runIssue) {
              logger.warn('[Insight-v3] Dimension child result missing local plan/state', {
                sessionId,
                dimension: dimId,
                runIssue,
                hasPlan: Boolean(plan),
                hasState: Boolean(state),
              });
              consumeDimensionError({ dimId, err: runIssue });
            }
            return;
          }
          if (runIssue) {
            const projectedRun = projectAgentRunResult(result);
            const projection = projectGenerateDimensionAgentOutput({
              dimId,
              needsCandidates: plan.needsCandidates,
              runResult: projectedRun,
            });
            const recoveredProducerTimeout = isRecoverableProducerTimeoutIssue({
              issue: runIssue,
              needsCandidates: plan.needsCandidates,
              produceResult: projection.produceResult,
              successCount: projection.successCount,
            });
            if (!recoveredProducerTimeout) {
              logger.warn('[Insight-v3] Dimension child result failed', {
                sessionId,
                dimension: dimId,
                runIssue,
                status: result.status,
                toolCallCount: getAgentRunToolCallCount(result),
                diagnostics: summarizeDiagnostics(result.diagnostics),
              });
              consumeDimensionError({ dimId, err: runIssue });
              return;
            }
            logger.warn(
              `[Insight-v3] Dimension "${dimId}" producer summary timed out after successful candidate submit(s); continuing to consume produced candidates.`
            );
          }
          await consumeDimensionResult({
            dimId,
            plan,
            agentRunResult: result,
            dimStartTime: state.dimStartTime,
            analystScopeId: state.analystScopeId,
          });
        },
        onTierComplete: ({
          tierIndex,
          childInputs,
        }: {
          tierIndex: number;
          childInputs: AgentRunInput[];
        }) => {
          logger.info('[Insight-v3] Bootstrap tier complete', {
            sessionId,
            tierIndex,
            dimensions: childInputs.map((childInput) => getGenerateChildDimensionId(childInput)),
          });
          const tierResults = new Map<string, DimensionStat>();
          for (const childInput of childInputs) {
            const dimId = getGenerateChildDimensionId(childInput);
            if (!dimId || !dimensionStats[dimId]) {
              continue;
            }
            tierResults.set(dimId, dimensionStats[dimId]);
          }
          consumeTierResult(tierIndex, tierResults);
        },
      },
    },
    execution: {
      abortSignal: sessionAbortSignal || undefined,
      shouldAbort: () =>
        !!(
          taskManager &&
          (!taskManager.isSessionValid(sessionId) || taskManager.isUserCancelled?.(sessionId))
        ),
      // AP-7：仅当质量验证会话显式 opt-in 时附加 per-run guard；经 coordinator 均匀传播全子维度 → AgentRuntime
      // → analyze grounding guard。未设则字段省略，子运行回退 runtime 全局默认 observe-only（零行为变更）。
      ...(groundingEnforcement ? { groundingEnforcement } : {}),
    },
    presentation: { responseShape: 'system-task-result' },
  });

  logger.info('[Insight-v3] Prepared bootstrap-session parent input', {
    sessionId,
    childRunCount: (input.params?.dimensions as unknown[] | undefined)?.length || 0,
    concurrency,
    activeDimIds,
    skippedDimIds,
  });

  return { input, childExecutionState };
}

function buildBootstrapDimensionChildPlan({
  dimId,
  sessionId,
  primaryLang,
  projectLang,
  sessionAbortSignal,
  taskManager,
  scheduler,
  resolvePlan,
  createDimensionRunInput,
  emitDimensionStart,
  emitProcessEvents,
  dimensionStats,
  childExecutionState,
}: {
  dimId: string;
  sessionId: string;
  primaryLang?: string | null;
  projectLang?: string | null;
  sessionAbortSignal?: AbortSignal | null;
  taskManager?: GenerateTaskManagerLike | null;
  scheduler: { getTierIndex(dimId: string): number };
  resolvePlan(dimId: string): GenerateDimensionPlan | null;
  createDimensionRunInput(
    dimId: string,
    plan: GenerateDimensionPlan
  ): { analystScopeId: string; runInput: AgentRunInput };
  emitDimensionStart(dimId: string): void;
  emitProcessEvents?(payload: GenerateProcessEventsPayload): void;
  dimensionStats: Record<string, DimensionStat>;
  childExecutionState: Map<string, GenerateDimensionExecutionState>;
}): GenerateSessionChildRunPlan | null {
  const plan = resolvePlan(dimId);
  if (!plan) {
    return null;
  }
  return {
    id: dimId,
    label: plan.dimConfig.label || plan.dim.label || dimId,
    tier: resolveGenerateDimensionTier(dimId, plan.dim, scheduler),
    input: buildBootstrapDimensionPlannedInput({
      dimId,
      plan,
      sessionId,
      primaryLang,
      projectLang,
      sessionAbortSignal,
    }),
    lazyInputFactory: () => {
      assertBootstrapSessionStillActive({
        sessionAbortSignal,
        sessionId,
        taskManager,
      });
      const dimStartTime = beginBootstrapDimensionExecution({
        dimId,
        dimConfig: plan.dimConfig,
        emitDimensionStart,
        sessionId,
      });
      const { analystScopeId, runInput } = createDimensionRunInput(dimId, plan);
      const bridgedRunInput = attachGenerateAgentProgressBridge({
        dimId,
        emitProcessEvents,
        label: plan.dimConfig.label || plan.dim.label || dimId,
        runInput: injectBootstrapPcvStageNodeContext(runInput),
        sessionId,
      });
      const pcvN8Evidence = buildPcvN8StageFactoryEvidence({
        dimId,
        label: plan.dimConfig.label || plan.dim.label || dimId,
        plan,
        runInput: bridgedRunInput,
      });
      const pcvN9RecordRepairMapEvidence = buildPcvN9RecordRepairStageMapEvidence({
        dimId,
        label: plan.dimConfig.label || plan.dim.label || dimId,
      });
      dimensionStats[dimId] = {
        ...(dimensionStats[dimId] || {
          candidateCount: 0,
          durationMs: 0,
        }),
        pcvNodeEvidence: mergeGeneratePcvNodeEvidence(dimensionStats[dimId]?.pcvNodeEvidence, {
          n8: pcvN8Evidence,
          n9RecordRepair: pcvN9RecordRepairMapEvidence,
        }),
      };
      childExecutionState.set(dimId, { dimStartTime, analystScopeId });
      emitProcessEvents?.({
        dimensionId: dimId,
        events: buildGenerateDimensionInputProcessEvents({
          dimId,
          label: plan.dimConfig.label || plan.dim.label || dimId,
          plan,
          runInput: bridgedRunInput,
          sessionId,
        }),
        sessionId,
        source: 'bootstrap-dimension-input',
        targetName: plan.dimConfig.label || plan.dim.label || dimId,
        taskId: dimId,
      });
      return bridgedRunInput;
    },
  };
}

export function attachGenerateAgentProgressBridge({
  dimId,
  emitProcessEvents,
  label,
  runInput,
  sessionId,
}: {
  dimId: string;
  emitProcessEvents?(payload: GenerateProcessEventsPayload): void;
  label?: string | null;
  runInput: AgentRunInput;
  sessionId: string;
}): AgentRunInput {
  if (!emitProcessEvents) {
    return runInput;
  }
  const previousOnProgress = runInput.execution?.onProgress || null;
  return {
    ...runInput,
    execution: {
      ...(runInput.execution || {}),
      onProgress: (event: ProgressEvent) => {
        try {
          previousOnProgress?.(event);
        } catch {
          /* progress observers are non-blocking */
        }
        const events = buildGenerateAgentProgressProcessEvents({
          dimId,
          event,
          label,
          sessionId,
        });
        if (events.length === 0) {
          return;
        }
        emitProcessEvents({
          dimensionId: dimId,
          events,
          sessionId,
          source: 'bootstrap-agent-progress',
          targetName: label || dimId,
          taskId: dimId,
        });
      },
    },
  };
}

function assertBootstrapSessionStillActive({
  sessionAbortSignal,
  sessionId,
  taskManager,
}: {
  sessionAbortSignal?: AbortSignal | null;
  sessionId: string;
  taskManager?: GenerateTaskManagerLike | null;
}) {
  if (sessionAbortSignal?.aborted) {
    const reason = typeof sessionAbortSignal.reason === 'string' ? sessionAbortSignal.reason : null;
    throw new Error(reason || 'Bootstrap session cancelled');
  }
  if (
    taskManager &&
    (!taskManager.isSessionValid(sessionId) || taskManager.isUserCancelled?.(sessionId))
  ) {
    throw new Error('Bootstrap session cancelled');
  }
}

function buildBootstrapDimensionPlannedInput({
  dimId,
  plan,
  sessionId,
  primaryLang,
  projectLang,
  sessionAbortSignal,
}: {
  dimId: string;
  plan: GenerateDimensionPlan;
  sessionId: string;
  primaryLang?: string | null;
  projectLang?: string | null;
  sessionAbortSignal?: AbortSignal | null;
}): AgentRunInput {
  const pcvStageNodeContext = buildGeneratePcvStageNodeContext();
  const sharedState = {
    _pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
    _pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
    pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
    pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
  };
  return {
    profile: { id: 'generate-dimension' },
    params: {
      dimId,
      needsCandidates: plan.needsCandidates,
      hasExistingRecipes: plan.hasExistingRecipes,
      prescreenDone: plan.prescreenDone,
    },
    message: {
      role: 'internal',
      content: `Bootstrap dimension: ${plan.dimConfig.label || dimId}`,
      sessionId,
      metadata: {
        sessionId,
        dimension: dimId,
        phase: 'bootstrap',
        context: {
          pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
          pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
        },
      },
    },
    context: {
      source: 'bootstrap',
      runtimeSource: 'system',
      lang: primaryLang || projectLang || null,
      pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
      pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
      strategyContext: {
        pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
        pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
        pcvStageNodeMapContract: {
          contract: pcvStageNodeContext.contract,
          contractVersion: pcvStageNodeContext.contractVersion,
        },
        sharedState,
      },
      sharedState,
      promptContext: {
        dimId,
        dimensionId: dimId,
        pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
        pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
      },
    } as unknown as AgentRunInput['context'],
    execution: {
      abortSignal: sessionAbortSignal || undefined,
    },
    presentation: { responseShape: 'system-task-result' },
  };
}

function injectBootstrapPcvStageNodeContext(runInput: AgentRunInput): AgentRunInput {
  const pcvStageNodeContext = buildGeneratePcvStageNodeContext();
  const context = runInput.context || {};
  const messageMetadata = asRecord(runInput.message.metadata);
  const sharedState = {
    ...asRecord(context.sharedState),
    _pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
    _pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
    pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
    pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
  };

  return {
    ...runInput,
    message: {
      ...runInput.message,
      metadata: {
        ...messageMetadata,
        context: {
          ...asRecord(messageMetadata.context),
          pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
          pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
        },
      },
    },
    context: {
      ...context,
      pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
      pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
      strategyContext: {
        ...asRecord(context.strategyContext),
        pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
        pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
        pcvStageNodeMapContract: {
          contract: pcvStageNodeContext.contract,
          contractVersion: pcvStageNodeContext.contractVersion,
        },
        sharedState: {
          ...asRecord(asRecord(context.strategyContext).sharedState),
          ...sharedState,
        },
      },
      sharedState,
      promptContext: {
        ...asRecord(context.promptContext),
        pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
        pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
      },
    } as unknown as AgentRunInput['context'],
  };
}

export function resolveGenerateDimensionTier(
  dimId: string,
  dim: DimensionDef,
  scheduler: { getTierIndex(dimId: string): number }
) {
  if (typeof dim.tierHint === 'number') {
    return Math.max(0, dim.tierHint - 1);
  }
  const tierIndex = scheduler.getTierIndex(dimId);
  return tierIndex >= 0 ? tierIndex : 0;
}

function beginBootstrapDimensionExecution({
  dimId,
  dimConfig,
  emitDimensionStart,
  sessionId,
}: {
  dimId: string;
  dimConfig: { label?: string };
  emitDimensionStart(dimId: string): void;
  sessionId: string;
}) {
  emitDimensionStart(dimId);
  logger.info(`[Insight-v3] Dimension "${dimId}" started`, {
    sessionId,
    dimension: dimId,
    label: dimConfig.label || null,
    stage: 'dimension-start',
  });
  return Date.now();
}

export function getGenerateChildDimensionId(childInput: AgentRunInput) {
  return typeof childInput.params?.dimId === 'string' ? childInput.params.dimId : null;
}

function summarizeDiagnostics(diagnostics: AgentRunResult['diagnostics']) {
  if (!diagnostics) {
    return null;
  }
  return {
    aiErrorCount: diagnostics.aiErrorCount ?? null,
    cancelReason: diagnostics.efficiency?.cancelReason ?? null,
    degraded: diagnostics.degraded === true,
    emptyResponses: diagnostics.emptyResponses ?? null,
    timedOutStages: diagnostics.timedOutStages || [],
    gateFailures: diagnostics.gateFailures || [],
  };
}

function getAgentRunToolCallCount(result: AgentRunResult): number {
  return Array.isArray(result.toolCalls) ? result.toolCalls.length : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
