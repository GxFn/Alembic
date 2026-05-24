import type { AgentRunInput, AgentRunResult } from '@alembic/agent/service';
import Logger from '@alembic/core/logging';
import type { DimensionDef } from '@alembic/core/project-intelligence';
import type { BootstrapProcessEventsPayload } from '#service/bootstrap/bootstrap-event-types.js';
import type { DimensionStat } from '#workflows/capabilities/execution/internal-agent/BootstrapConsumers.js';
import type { BootstrapDimensionPlan } from '#workflows/capabilities/execution/internal-agent/BootstrapDimensionRuntimeBuilder.js';
import {
  type BootstrapSessionChildRunPlan,
  buildBootstrapSessionRunInput,
} from '#workflows/capabilities/execution/internal-agent/BootstrapInputBuilders.js';
import { buildBootstrapDimensionInputProcessEvents } from '#workflows/capabilities/execution/internal-agent/BootstrapProcessEvents.js';
import {
  isRecoverableProducerTimeoutIssue,
  projectAgentRunResult,
  projectBootstrapDimensionAgentOutput,
  resolveBootstrapDimensionRunIssue,
} from '#workflows/capabilities/execution/internal-agent/BootstrapProjections.js';

const logger = Logger.getInstance();

export interface BootstrapDimensionExecutionState {
  dimStartTime: number;
  analystScopeId: string;
}

export interface BootstrapTaskManagerLike {
  isSessionValid(sessionId: string): boolean;
  isUserCancelled?(sessionId: string): boolean;
}

export interface BuildBootstrapSessionExecutionInputOptions {
  sessionId: string;
  activeDimIds: string[];
  skippedDimIds: string[];
  concurrency: number;
  primaryLang?: string | null;
  projectLang?: string | null;
  sessionAbortSignal?: AbortSignal | null;
  taskManager?: BootstrapTaskManagerLike | null;
  scheduler: { getTierIndex(dimId: string): number };
  dimensionStats: Record<string, DimensionStat>;
  resolvePlan(dimId: string): BootstrapDimensionPlan | null;
  createDimensionRunInput(
    dimId: string,
    plan: BootstrapDimensionPlan
  ): { analystScopeId: string; runInput: AgentRunInput };
  emitDimensionStart(dimId: string): void;
  consumeDimensionResult(args: {
    dimId: string;
    plan: BootstrapDimensionPlan;
    agentRunResult: AgentRunResult;
    dimStartTime: number;
    analystScopeId: string;
  }): Promise<unknown> | unknown;
  consumeDimensionError(args: { dimId: string; err: unknown }): unknown;
  consumeTierResult(tierIndex: number, tierResults: Map<string, DimensionStat>): unknown;
  emitProcessEvents?(payload: BootstrapProcessEventsPayload): void;
}

export function buildBootstrapSessionExecutionInput({
  sessionId,
  activeDimIds,
  skippedDimIds,
  concurrency,
  primaryLang,
  projectLang,
  sessionAbortSignal,
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
}: BuildBootstrapSessionExecutionInputOptions) {
  const childExecutionState = new Map<string, BootstrapDimensionExecutionState>();
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
        childExecutionState,
      })
    )
    .filter((plan): plan is BootstrapSessionChildRunPlan => !!plan);

  const input = buildBootstrapSessionRunInput({
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
          const dimId = getBootstrapChildDimensionId(childInput);
          if (!dimId) {
            return;
          }
          const runIssue = resolveBootstrapDimensionRunIssue(result, { includeDegraded: false });
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
            const projection = projectBootstrapDimensionAgentOutput({
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
            dimensions: childInputs.map((childInput) => getBootstrapChildDimensionId(childInput)),
          });
          const tierResults = new Map<string, DimensionStat>();
          for (const childInput of childInputs) {
            const dimId = getBootstrapChildDimensionId(childInput);
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
  childExecutionState,
}: {
  dimId: string;
  sessionId: string;
  primaryLang?: string | null;
  projectLang?: string | null;
  sessionAbortSignal?: AbortSignal | null;
  taskManager?: BootstrapTaskManagerLike | null;
  scheduler: { getTierIndex(dimId: string): number };
  resolvePlan(dimId: string): BootstrapDimensionPlan | null;
  createDimensionRunInput(
    dimId: string,
    plan: BootstrapDimensionPlan
  ): { analystScopeId: string; runInput: AgentRunInput };
  emitDimensionStart(dimId: string): void;
  emitProcessEvents?(payload: BootstrapProcessEventsPayload): void;
  childExecutionState: Map<string, BootstrapDimensionExecutionState>;
}): BootstrapSessionChildRunPlan | null {
  const plan = resolvePlan(dimId);
  if (!plan) {
    return null;
  }
  return {
    id: dimId,
    label: plan.dimConfig.label || plan.dim.label || dimId,
    tier: resolveBootstrapDimensionTier(dimId, plan.dim, scheduler),
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
      childExecutionState.set(dimId, { dimStartTime, analystScopeId });
      emitProcessEvents?.({
        dimensionId: dimId,
        events: buildBootstrapDimensionInputProcessEvents({
          dimId,
          label: plan.dimConfig.label || plan.dim.label || dimId,
          plan,
          runInput,
          sessionId,
        }),
        sessionId,
        source: 'bootstrap-dimension-input',
        targetName: plan.dimConfig.label || plan.dim.label || dimId,
        taskId: dimId,
      });
      return runInput;
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
  taskManager?: BootstrapTaskManagerLike | null;
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
  plan: BootstrapDimensionPlan;
  sessionId: string;
  primaryLang?: string | null;
  projectLang?: string | null;
  sessionAbortSignal?: AbortSignal | null;
}): AgentRunInput {
  return {
    profile: { id: 'bootstrap-dimension' },
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
      },
    },
    context: {
      source: 'bootstrap',
      runtimeSource: 'system',
      lang: primaryLang || projectLang || null,
      promptContext: {
        dimId,
        dimensionId: dimId,
      },
    },
    execution: {
      abortSignal: sessionAbortSignal || undefined,
    },
    presentation: { responseShape: 'system-task-result' },
  };
}

export function resolveBootstrapDimensionTier(
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

export function getBootstrapChildDimensionId(childInput: AgentRunInput) {
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
