import type {
  AgentRunResult,
  AgentService,
  SystemRunContextFactory,
} from '#agent/service/index.js';
import Logger from '#infra/logging/Logger.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import {
  type CandidateResults,
  consumeBootstrapCandidateRelations,
  consumeBootstrapDimensionError as consumeBootstrapDimensionErrorSideEffects,
  consumeBootstrapDimensionResult,
  consumeBootstrapSessionResult as consumeBootstrapSessionResultSideEffects,
  consumeBootstrapTierReflection,
  type DimensionCandidateData,
  type DimensionStat,
} from '#workflows/capabilities/execution/internal-agent/BootstrapConsumers.js';
import {
  type BootstrapDimensionPlan,
  createBootstrapDimensionRuntimeInput,
  resolveBootstrapDimensionPlan as resolveBootstrapDimensionPlanData,
} from '#workflows/capabilities/execution/internal-agent/BootstrapDimensionRuntimeBuilder.js';
import {
  projectAgentRunResult,
  projectBootstrapDimensionAgentOutput,
} from '#workflows/capabilities/execution/internal-agent/BootstrapProjections.js';
import { prepareBootstrapRescanState } from '#workflows/capabilities/execution/internal-agent/BootstrapRescanState.js';
import type { initializeBootstrapRuntime } from '#workflows/capabilities/execution/internal-agent/BootstrapRuntimeInitializer.js';
import { buildBootstrapSessionExecutionInput } from '#workflows/capabilities/execution/internal-agent/BootstrapSessionExecutionBuilder.js';
import type { InternalDimensionFillPreparation } from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillPreparation.js';
import {
  applyRestoredDimensionState,
  resolveIncrementalSkippedDimensions,
  restoreCheckpointDimensions,
} from '#workflows/capabilities/persistence/DimensionCheckpoint.js';
import { TierScheduler } from '#workflows/capabilities/planning/dimensions/TierScheduler.js';

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
  enableParallel: boolean;
  concurrency: number;
}

export async function runInternalDimensionAgentSession({
  preparation,
  runtime,
}: {
  preparation: InternalDimensionFillPreparation;
  runtime: InternalDimensionFillRuntime;
}): Promise<InternalDimensionFillSessionResult> {
  const services = resolveInternalDimensionServices(preparation);

  const { enableParallel, concurrency } = resolveInternalDimensionExecutionConcurrency();
  const scheduler = new TierScheduler();
  const activeDimIds = preparation.dimensions.map((dimension: DimensionDef) => dimension.id);
  const incrementalSkippedDims = resolveIncrementalSkippedDimensions({
    isIncremental: preparation.isIncremental,
    incrementalPlan: preparation.incrementalPlan,
    activeDimIds,
    emitter: preparation.emitter,
  });

  logger.info(
    `[Insight-v3] Active dimensions: [${activeDimIds.join(', ')}], concurrency=${enableParallel ? concurrency : 1}${preparation.isIncremental ? `, incremental skip: [${incrementalSkippedDims.join(', ')}]` : ''}`
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
      projectGraph: runtime.projectGraph,
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
    concurrency,
    primaryLang: preparation.primaryLang,
    projectLang: runtime.projectInfo.lang || null,
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
    enableParallel,
    concurrency,
  };
}

export function resolveInternalDimensionExecutionConcurrency(env: NodeJS.ProcessEnv = process.env) {
  const enableParallel = env.ALEMBIC_PARALLEL_BOOTSTRAP !== 'false';
  const rawConcurrency =
    env.ALEMBIC_PARALLEL_CONCURRENCY ?? env.ALEMBIC_BOOTSTRAP_CONCURRENCY ?? '3';
  const parsedConcurrency = Number.parseInt(rawConcurrency, 10);
  const configuredConcurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? Math.floor(parsedConcurrency) : 3;
  return {
    enableParallel,
    concurrency: enableParallel ? configuredConcurrency : 1,
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
