import type { AgentRunInput, AgentRunResult } from '#agent/service/index.js';
import Logger from '#infra/logging/Logger.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import type { BootstrapDimensionPlan } from '#workflows/capabilities/execution/internal-agent/agent-runs/BootstrapDimensionRuntimeBuilder.js';
import {
  type BootstrapSessionChildRunPlan,
  buildBootstrapSessionRunInput,
} from '#workflows/capabilities/execution/internal-agent/agent-runs/BootstrapSessionInputBuilder.js';
import type { DimensionStat } from '#workflows/capabilities/execution/internal-agent/consumers/BootstrapDimensionConsumer.js';

const logger = Logger.getInstance();

export interface BootstrapDimensionExecutionState {
  dimStartTime: number;
  analystScopeId: string;
}

export interface BootstrapTaskManagerLike {
  isSessionValid(sessionId: string): boolean;
}

export interface BuildBootstrapSessionExecutionInputOptions {
  sessionId: string;
  activeDimIds: string[];
  skippedDimIds: string[];
  concurrency: number;
  primaryLang?: string | null;
  projectLang?: string | null;
  terminalTest?: boolean;
  terminalToolset?: string;
  allowedTerminalModes?: string[];
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
}

export function buildBootstrapSessionExecutionInput({
  sessionId,
  activeDimIds,
  skippedDimIds,
  concurrency,
  primaryLang,
  projectLang,
  terminalTest,
  terminalToolset,
  allowedTerminalModes,
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
        terminalTest,
        terminalToolset,
        allowedTerminalModes,
        sessionAbortSignal,
        scheduler,
        resolvePlan,
        createDimensionRunInput,
        emitDimensionStart,
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
          if (result.status === 'error' || result.status === 'aborted') {
            consumeDimensionError({ dimId, err: result.reply || 'child-run-error' });
            return;
          }
          const plan = resolvePlan(dimId);
          const state = childExecutionState.get(dimId);
          if (!plan || !state) {
            return;
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
      shouldAbort: () => !!(taskManager && !taskManager.isSessionValid(sessionId)),
    },
    presentation: { responseShape: 'system-task-result' },
  });

  logger.debug?.(
    `[Insight-v3] Prepared bootstrap-session parent input: ${(input.params?.dimensions as unknown[] | undefined)?.length || 0} child runs`
  );

  return { input, childExecutionState };
}

function buildBootstrapDimensionChildPlan({
  dimId,
  sessionId,
  primaryLang,
  projectLang,
  terminalTest,
  terminalToolset,
  allowedTerminalModes,
  sessionAbortSignal,
  scheduler,
  resolvePlan,
  createDimensionRunInput,
  emitDimensionStart,
  childExecutionState,
}: {
  dimId: string;
  sessionId: string;
  primaryLang?: string | null;
  projectLang?: string | null;
  terminalTest?: boolean;
  terminalToolset?: string;
  allowedTerminalModes?: string[];
  sessionAbortSignal?: AbortSignal | null;
  scheduler: { getTierIndex(dimId: string): number };
  resolvePlan(dimId: string): BootstrapDimensionPlan | null;
  createDimensionRunInput(
    dimId: string,
    plan: BootstrapDimensionPlan
  ): { analystScopeId: string; runInput: AgentRunInput };
  emitDimensionStart(dimId: string): void;
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
      terminalTest,
      terminalToolset,
      allowedTerminalModes,
      sessionAbortSignal,
    }),
    lazyInputFactory: () => {
      const dimStartTime = beginBootstrapDimensionExecution({
        dimId,
        dimConfig: plan.dimConfig,
        emitDimensionStart,
      });
      const { analystScopeId, runInput } = createDimensionRunInput(dimId, plan);
      childExecutionState.set(dimId, { dimStartTime, analystScopeId });
      return runInput;
    },
  };
}

function buildBootstrapDimensionPlannedInput({
  dimId,
  plan,
  sessionId,
  primaryLang,
  projectLang,
  terminalTest,
  terminalToolset,
  allowedTerminalModes,
  sessionAbortSignal,
}: {
  dimId: string;
  plan: BootstrapDimensionPlan;
  sessionId: string;
  primaryLang?: string | null;
  projectLang?: string | null;
  terminalTest?: boolean;
  terminalToolset?: string;
  allowedTerminalModes?: string[];
  sessionAbortSignal?: AbortSignal | null;
}): AgentRunInput {
  return {
    profile: { id: 'bootstrap-dimension' },
    params: {
      dimId,
      needsCandidates: plan.needsCandidates,
      hasExistingRecipes: plan.hasExistingRecipes,
      prescreenDone: plan.prescreenDone,
      terminalTest,
      terminalToolset,
      allowedTerminalModes,
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
}: {
  dimId: string;
  dimConfig: { label?: string };
  emitDimensionStart(dimId: string): void;
}) {
  emitDimensionStart(dimId);
  logger.info(`[Insight-v3] ── Dimension "${dimId}" (${dimConfig.label}) ──`);
  return Date.now();
}

export function getBootstrapChildDimensionId(childInput: AgentRunInput) {
  return typeof childInput.params?.dimId === 'string' ? childInput.params.dimId : null;
}
