import type {
  AgentRunResult,
  AgentService,
  SystemRunContextFactory,
} from '#agent/service/index.js';
import Logger from '#infra/logging/Logger.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import {
  type BootstrapDimensionPlan,
  createBootstrapDimensionRuntimeInput,
  resolveBootstrapDimensionPlan as resolveBootstrapDimensionPlanData,
} from '#workflows/common-capabilities/agent-execution/internal/agent-runs/BootstrapDimensionRuntimeBuilder.js';
import { buildBootstrapSessionExecutionInput } from '#workflows/common-capabilities/agent-execution/internal/agent-runs/BootstrapSessionExecutionBuilder.js';
import { consumeBootstrapCandidateRelations } from '#workflows/common-capabilities/agent-execution/internal/consumers/BootstrapCandidateRelationConsumer.js';
import {
  type CandidateResults,
  consumeBootstrapDimensionError as consumeBootstrapDimensionErrorSideEffects,
  consumeBootstrapDimensionResult,
  type DimensionCandidateData,
  type DimensionStat,
} from '#workflows/common-capabilities/agent-execution/internal/consumers/BootstrapDimensionConsumer.js';
import { consumeBootstrapSessionResult as consumeBootstrapSessionResultSideEffects } from '#workflows/common-capabilities/agent-execution/internal/consumers/BootstrapSessionConsumer.js';
import { consumeBootstrapTierReflection } from '#workflows/common-capabilities/agent-execution/internal/consumers/BootstrapTierReflectionConsumer.js';
import { prepareBootstrapRescanState } from '#workflows/common-capabilities/agent-execution/internal/context/BootstrapRescanState.js';
import type { initializeBootstrapRuntime } from '#workflows/common-capabilities/agent-execution/internal/context/BootstrapRuntimeInitializer.js';
import type { InternalDimensionFillPreparation } from '#workflows/common-capabilities/agent-execution/internal/InternalDimensionFillPreparation.js';
import {
  projectAgentRunResult,
  projectBootstrapDimensionAgentOutput,
} from '#workflows/common-capabilities/agent-execution/internal/projections/BootstrapDimensionProjection.js';
import { TierScheduler } from '#workflows/common-capabilities/dimension-planning/TierScheduler.js';
import {
  applyRestoredDimensionState,
  resolveIncrementalSkippedDimensions,
  restoreCheckpointDimensions,
} from '#workflows/common-capabilities/progress/checkpoint/DimensionRestoreState.js';

const logger = Logger.getInstance();

type InternalDimensionFillRuntime = Awaited<ReturnType<typeof initializeBootstrapRuntime>>;

export interface InternalDimensionFillSessionResult {
  activeDimIds: string[];
  incrementalSkippedDims: string[];
  skippedDims: string[];
  candidateResults: CandidateResults;
  dimensionCandidates: Record<string, DimensionCandidateData>;
  dimensionStats: Record<string, DimensionStat>;
  bootstrapDedup: { count: number; clear(): void };
}

export async function runInternalDimensionAgentSession({
  preparation,
  runtime,
}: {
  preparation: InternalDimensionFillPreparation;
  runtime: InternalDimensionFillRuntime;
}): Promise<InternalDimensionFillSessionResult> {
  const services = resolveInternalDimensionServices(preparation);

  const concurrency = parseInt(process.env.ALEMBIC_PARALLEL_CONCURRENCY || '3', 10);
  const enableParallel = process.env.ALEMBIC_PARALLEL_BOOTSTRAP !== 'false';
  const scheduler = new TierScheduler();
  const activeDimIds = preparation.dimensions.map((dimension: DimensionDef) => dimension.id);
  const incrementalSkippedDims = resolveIncrementalSkippedDimensions({
    isIncremental: preparation.isIncremental,
    incrementalPlan: preparation.incrementalPlan,
    activeDimIds,
    emitter: preparation.emitter,
  });

  logger.info(
    `[Insight-v3] Active dimensions: [${activeDimIds.join(', ')}], concurrency=${enableParallel ? concurrency : 1}, terminalToolset=${preparation.terminalToolsetConfig.terminalToolset}${preparation.isIncremental ? `, incremental skip: [${incrementalSkippedDims.join(', ')}]` : ''}`
  );

  const candidateResults: CandidateResults = { created: 0, failed: 0, errors: [] };
  const dimensionCandidates: Record<string, DimensionCandidateData> = {};
  const dimensionStats: Record<string, DimensionStat> = {};

  const { completedCheckpoints, skippedDims } = await restoreCheckpointDimensions({
    dataRoot: preparation.dataRoot,
    activeDimIds,
    dimContext: runtime.dimContext,
    sessionStore: runtime.sessionStore,
    emitter: preparation.emitter,
  });
  applyRestoredDimensionState({
    incrementalSkippedDims,
    checkpointSkippedDims: skippedDims,
    completedCheckpoints,
    sessionStore: runtime.sessionStore,
    dimensionStats,
    candidateResults,
    dimensionCandidates,
  });

  const {
    globalSubmittedTitles,
    globalSubmittedPatterns,
    globalSubmittedTriggers,
    bootstrapDedup,
    rescanContext,
  } = prepareBootstrapRescanState({
    existingRecipes: preparation.existingRecipes,
    evolutionPrescreen: preparation.evolutionPrescreen,
  });

  function resolveBootstrapDimensionPlan(dimId: string) {
    return resolveBootstrapDimensionPlanData({
      dimId,
      dimensions: preparation.dimensions,
      rescanContext,
    });
  }

  function createBootstrapDimensionRunInput(dimId: string, plan: BootstrapDimensionPlan) {
    return createBootstrapDimensionRuntimeInput({
      dimId,
      plan,
      memoryCoordinator: runtime.memoryCoordinator,
      systemRunContextFactory: services.systemRunContextFactory,
      projectInfo: runtime.projectInfo,
      primaryLang: preparation.primaryLang,
      dimContext: runtime.dimContext,
      sessionStore: runtime.sessionStore,
      semanticMemory: runtime.semanticMemory,
      codeEntityGraphInst: runtime.codeEntityGraphInst,
      panoramaResult: preparation.panoramaResult,
      astProjectSummary: preparation.astProjectSummary,
      guardAudit: preparation.guardAudit,
      depGraphData: preparation.depGraphData,
      callGraphResult: preparation.callGraphResult,
      rescanContext,
      targetFileMap: preparation.targetFileMap,
      globalSubmittedTitles,
      globalSubmittedPatterns,
      globalSubmittedTriggers,
      bootstrapDedup,
      sessionId: preparation.sessionId,
      allFiles: preparation.allFiles,
      sessionAbortSignal: preparation.sessionAbortSignal,
      terminalTest: preparation.terminalToolsetConfig.terminalTest,
      terminalToolset: preparation.terminalToolsetConfig.terminalToolset,
      allowedTerminalModes: preparation.terminalToolsetConfig.allowedTerminalModes,
    });
  }

  async function consumeBootstrapDimensionAgentResult({
    dimId,
    plan,
    agentRunResult,
    dimStartTime,
    analystScopeId,
  }: {
    dimId: string;
    plan: NonNullable<ReturnType<typeof resolveBootstrapDimensionPlan>>;
    agentRunResult: AgentRunResult;
    dimStartTime: number;
    analystScopeId: string;
  }) {
    const runResult = projectAgentRunResult(agentRunResult);
    const projection = projectBootstrapDimensionAgentOutput({
      dimId,
      needsCandidates: plan.needsCandidates,
      runResult,
    });
    return consumeBootstrapDimensionResult({
      ctx: preparation.ctx,
      dimId,
      dimConfig: plan.dimConfig,
      needsCandidates: plan.needsCandidates,
      projection,
      runResult,
      dimStartTime,
      analystScopeId,
      memoryCoordinator: runtime.memoryCoordinator,
      sessionStore: runtime.sessionStore,
      dimContext: runtime.dimContext,
      candidateResults,
      dimensionCandidates,
      dimensionStats,
      emitter: preparation.emitter,
      dataRoot: preparation.dataRoot,
      sessionId: preparation.sessionId,
    });
  }

  function consumeBootstrapDimensionError({ dimId, err }: { dimId: string; err: unknown }) {
    return consumeBootstrapDimensionErrorSideEffects({
      dimId,
      err,
      candidateResults,
      dimensionStats,
      emitter: preparation.emitter,
    });
  }

  function consumeBootstrapSessionTierResult(
    tierIndex: number,
    tierResults: Map<string, DimensionStat>
  ) {
    return consumeBootstrapTierReflection({
      tierIndex,
      tierResults,
      sessionStore: runtime.sessionStore,
    });
  }

  function consumeBootstrapSessionResult({
    parentRunResult,
    durationMs,
  }: {
    parentRunResult: AgentRunResult;
    durationMs: number;
  }) {
    return consumeBootstrapSessionResultSideEffects({
      parentRunResult,
      activeDimIds,
      skippedDimIds: [...incrementalSkippedDims, ...skippedDims],
      durationMs,
      sessionStore: runtime.sessionStore,
      dimensionStats,
      consumeMissingDimension: (dimId) =>
        consumeBootstrapDimensionError({ dimId, err: 'missing child result' }),
    });
  }

  const { input: bootstrapSessionInput } = buildBootstrapSessionExecutionInput({
    sessionId: preparation.sessionId,
    activeDimIds,
    skippedDimIds: [...incrementalSkippedDims, ...skippedDims],
    concurrency: enableParallel ? concurrency : 1,
    primaryLang: preparation.primaryLang,
    projectLang: runtime.projectInfo.lang || null,
    terminalTest: preparation.terminalToolsetConfig.terminalTest,
    terminalToolset: preparation.terminalToolsetConfig.terminalToolset,
    allowedTerminalModes: preparation.terminalToolsetConfig.allowedTerminalModes,
    sessionAbortSignal: preparation.sessionAbortSignal,
    taskManager: preparation.taskManager,
    scheduler,
    dimensionStats,
    resolvePlan: resolveBootstrapDimensionPlan,
    createDimensionRunInput: createBootstrapDimensionRunInput,
    emitDimensionStart: (dimId) => preparation.emitter.emitDimensionStart(dimId),
    consumeDimensionResult: consumeBootstrapDimensionAgentResult,
    consumeDimensionError: consumeBootstrapDimensionError,
    consumeTierResult: consumeBootstrapSessionTierResult,
  });

  const startedAtMs = Date.now();
  const parentRunResult = await services.agentService.run(bootstrapSessionInput);
  consumeBootstrapSessionResult({ parentRunResult, durationMs: Date.now() - startedAtMs });

  if (bootstrapDedup.count > 0) {
    logger.info(
      `[Insight-v3] BootstrapDedup: ${bootstrapDedup.count} entries registered during session`
    );
  }

  return {
    activeDimIds,
    incrementalSkippedDims,
    skippedDims,
    candidateResults,
    dimensionCandidates,
    dimensionStats,
    bootstrapDedup,
  };
}

function resolveInternalDimensionServices(preparation: InternalDimensionFillPreparation): {
  agentService: AgentService;
  systemRunContextFactory: SystemRunContextFactory;
} {
  if (!preparation.agentService || !preparation.systemRunContextFactory) {
    throw new Error('Internal dimension fill requires AgentService and SystemRunContextFactory');
  }
  return {
    agentService: preparation.agentService,
    systemRunContextFactory: preparation.systemRunContextFactory,
  };
}

export async function consumeInternalDimensionCandidateRelations({
  preparation,
  sessionResult,
}: {
  preparation: InternalDimensionFillPreparation;
  sessionResult: InternalDimensionFillSessionResult;
}) {
  return consumeBootstrapCandidateRelations({
    ctx: preparation.ctx,
    projectRoot: preparation.projectRoot,
    dimensionCandidates: sessionResult.dimensionCandidates,
  });
}
