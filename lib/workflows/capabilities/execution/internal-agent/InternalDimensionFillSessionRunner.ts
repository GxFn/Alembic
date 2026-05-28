import type { AgentRunResult, AgentService, SystemRunContextFactory } from '@alembic/agent/service';
import { TierScheduler } from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import type { DimensionDef } from '@alembic/core/project-intelligence';
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
  applyBootstrapDimensionAdmissions,
  type BootstrapDimensionAdmissionResult,
  resolveBootstrapDimensionAdmissions,
} from '#workflows/capabilities/execution/internal-agent/BootstrapDimensionAdmission.js';
import {
  type BootstrapDimensionPlan,
  createBootstrapDimensionRuntimeInput,
  resolveBootstrapDimensionPlan as resolveBootstrapDimensionPlanData,
} from '#workflows/capabilities/execution/internal-agent/BootstrapDimensionRuntimeBuilder.js';
import {
  buildBootstrapDimensionResultProcessEvents,
  buildBootstrapTierReflectionProcessEvents,
} from '#workflows/capabilities/execution/internal-agent/BootstrapProcessEvents.js';
import {
  projectAgentRunResult,
  projectBootstrapDimensionAgentOutput,
} from '#workflows/capabilities/execution/internal-agent/BootstrapProjections.js';
import { prepareBootstrapRescanState } from '#workflows/capabilities/execution/internal-agent/BootstrapRescanState.js';
import type { initializeBootstrapRuntime } from '#workflows/capabilities/execution/internal-agent/BootstrapRuntimeInitializer.js';
import { buildBootstrapSessionExecutionInput } from '#workflows/capabilities/execution/internal-agent/BootstrapSessionExecutionBuilder.js';
import type { InternalDimensionFillPreparation } from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillPreparation.js';

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
  admissions: BootstrapDimensionAdmissionResult;
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
  const {
    globalSubmittedTitles,
    globalSubmittedPatterns,
    globalSubmittedTriggers,
    bootstrapDedup,
    rescanContext,
  } = prepareBootstrapRescanState({
    existingRecipes: preparation.existingRecipes,
    evolutionPrescreen: preparation.evolutionPrescreen,
    executionDecisions: preparation.rescanExecutionDecisions,
  });
  const candidateResults: CandidateResults = { created: 0, failed: 0, errors: [] };
  const dimensionCandidates: Record<string, DimensionCandidateData> = {};
  const dimensionStats: Record<string, DimensionStat> = {};
  const sourceRefValidation = {
    allFiles: preparation.allFiles,
    projectRoot: preparation.projectRoot,
    targetFileMap: preparation.targetFileMap,
  };

  const admissions = await resolveBootstrapDimensionAdmissions({
    dataRoot: preparation.dataRoot,
    activeDimIds,
    isIncremental: preparation.isIncremental,
    incrementalPlan: preparation.incrementalPlan,
    rescanContext,
    dimContext: runtime.dimContext,
    sessionStore: runtime.sessionStore,
    emitter: preparation.emitter,
  });
  logger.info(
    `[Insight-v3] Active dimensions: [${activeDimIds.join(', ')}], concurrency=${enableParallel ? concurrency : 1}${preparation.isIncremental ? `, incremental skip: [${admissions.incrementalSkippedDims.join(', ')}]` : ''}`
  );
  applyBootstrapDimensionAdmissions({
    admissions,
    sessionStore: runtime.sessionStore,
    dimensionStats,
    candidateResults,
    dimensionCandidates,
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
    const processEvents = buildBootstrapDimensionResultProcessEvents({
      dimId,
      label: plan.dimConfig.label || plan.dim.label || dimId,
      needsCandidates: plan.needsCandidates,
      projection,
      runResult,
      sessionId: preparation.sessionId,
      sourceRefValidation,
    });
    if (processEvents.length > 0) {
      preparation.emitter.emitProcessEvents({
        dimensionId: dimId,
        events: processEvents,
        sessionId: preparation.sessionId,
        source: 'bootstrap-dimension-result',
        targetName: plan.dimConfig.label || plan.dim.label || dimId,
        taskId: dimId,
      });
    }
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
      sourceRefValidation,
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
    const reflection = consumeBootstrapTierReflection({
      tierIndex,
      tierResults,
      sessionStore: runtime.sessionStore,
    });
    if (reflection) {
      preparation.emitter.emitProcessEvents({
        events: buildBootstrapTierReflectionProcessEvents({
          reflection,
          sessionId: preparation.sessionId,
        }),
        sessionId: preparation.sessionId,
        source: 'bootstrap-tier-reflection',
        targetName: `Tier ${tierIndex + 1}`,
      });
    }
    return reflection;
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
      skippedDimIds: admissions.skippedDimIds,
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
    skippedDimIds: admissions.skippedDimIds,
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
    emitProcessEvents: (payload) => preparation.emitter.emitProcessEvents(payload),
  });

  const startedAtMs = Date.now();
  logger.info('[Insight-v3] Bootstrap agent session run start', {
    sessionId: preparation.sessionId,
    activeDimIds,
    skippedDimIds: admissions.skippedDimIds,
    concurrency: enableParallel ? concurrency : 1,
    incremental: preparation.isIncremental,
  });
  let parentRunResult: AgentRunResult;
  try {
    parentRunResult = await services.agentService.run(bootstrapSessionInput);
    logger.info('[Insight-v3] Bootstrap agent session run complete', {
      sessionId: preparation.sessionId,
      durationMs: Date.now() - startedAtMs,
      status: parentRunResult.status,
      profileId: parentRunResult.profileId,
      childResultCount: Object.keys(
        (parentRunResult.phases?.dimensionResults as Record<string, unknown> | undefined) || {}
      ).length,
      toolCallCount: parentRunResult.toolCalls.length,
      usage: parentRunResult.usage,
    });
  } catch (err: unknown) {
    logger.warn('[Insight-v3] Bootstrap agent session run failed', {
      sessionId: preparation.sessionId,
      durationMs: Date.now() - startedAtMs,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  consumeBootstrapSessionResult({ parentRunResult, durationMs: Date.now() - startedAtMs });

  if (bootstrapDedup.count > 0) {
    logger.info(
      `[Insight-v3] BootstrapDedup: ${bootstrapDedup.count} entries registered during session`
    );
  }

  return {
    activeDimIds,
    incrementalSkippedDims: admissions.incrementalSkippedDims,
    skippedDims: admissions.checkpointSkippedDims,
    candidateResults,
    dimensionCandidates,
    dimensionStats,
    bootstrapDedup,
    admissions,
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
