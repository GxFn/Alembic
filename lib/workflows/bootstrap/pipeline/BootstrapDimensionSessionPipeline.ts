import type {
  AgentRunResult,
  AgentService,
  SystemRunContextFactory,
} from '#agent/service/index.js';
import type { IncrementalPlan } from '#external/mcp/handlers/types.js';
import Logger from '#infra/logging/Logger.js';
import type { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import type {
  AstSummary,
  CallGraphResult,
  DependencyGraph,
  DimensionDef,
  GuardAudit,
} from '#types/project-snapshot.js';
import type { BootstrapFileEntry } from '#workflows/bootstrap/agent-runs/BootstrapDimensionInputBuilder.js';
import {
  type BootstrapDimensionPlan,
  createBootstrapDimensionRuntimeInput,
  resolveBootstrapDimensionPlan as resolveBootstrapDimensionPlanData,
} from '#workflows/bootstrap/agent-runs/BootstrapDimensionRuntimeBuilder.js';
import { buildBootstrapSessionExecutionInput } from '#workflows/bootstrap/agent-runs/BootstrapSessionExecutionBuilder.js';
import {
  applyRestoredDimensionState,
  resolveIncrementalSkippedDimensions,
  restoreCheckpointDimensions,
} from '#workflows/bootstrap/checkpoint/BootstrapRestoreState.js';
import type { BootstrapTerminalToolsetConfig } from '#workflows/bootstrap/config/BootstrapTerminalToolset.js';
import { TierScheduler } from '#workflows/bootstrap/config/TierScheduler.js';
import {
  type CandidateResults,
  consumeBootstrapDimensionError as consumeBootstrapDimensionErrorSideEffects,
  consumeBootstrapDimensionResult,
  type DimensionCandidateData,
  type DimensionStat,
} from '#workflows/bootstrap/consumers/BootstrapDimensionConsumer.js';
import { consumeBootstrapTierReflection } from '#workflows/bootstrap/consumers/BootstrapTierReflectionConsumer.js';
import { prepareBootstrapRescanState } from '#workflows/bootstrap/context/BootstrapRescanState.js';
import type { initializeBootstrapRuntime } from '#workflows/bootstrap/context/BootstrapRuntimeInitializer.js';
import {
  projectAgentRunResult,
  projectBootstrapDimensionAgentOutput,
} from '#workflows/bootstrap/projections/BootstrapDimensionProjection.js';
import type { KnowledgeEvidencePack, ScanPlan } from '#workflows/scan/ScanTypes.js';
import type { BootstrapWorkflowContext } from '../BootstrapWorkflow.js';
import { consumeBootstrapSessionResult as consumeBootstrapSessionResultSideEffects } from '../consumers/BootstrapSessionConsumer.js';

const logger = Logger.getInstance();

type BootstrapRuntime = Awaited<ReturnType<typeof initializeBootstrapRuntime>>;

interface BootstrapTaskManagerLike {
  isSessionValid(sessionId: string): boolean;
}

export interface RunBootstrapDimensionSessionOptions {
  ctx: BootstrapWorkflowContext;
  dataRoot: string;
  dimensions: DimensionDef[];
  runtime: BootstrapRuntime;
  agentService: AgentService;
  systemRunContextFactory: SystemRunContextFactory;
  emitter: BootstrapEventEmitter;
  sessionId: string;
  sessionAbortSignal: AbortSignal | null;
  taskManager: BootstrapTaskManagerLike | null;
  terminalToolsetConfig: BootstrapTerminalToolsetConfig;
  primaryLang: string;
  allFiles: BootstrapFileEntry[] | null;
  scanPlan?: ScanPlan | null;
  scanEvidencePack?: KnowledgeEvidencePack | null;
  targetFileMap?: Record<string, unknown> | null;
  depGraphData?: DependencyGraph | null;
  astProjectSummary?: AstSummary | null;
  guardAudit?: GuardAudit | null;
  panoramaResult?: Record<string, unknown> | null;
  callGraphResult?: CallGraphResult | null;
  isIncremental: boolean | null | undefined;
  incrementalPlan: IncrementalPlan | null;
  existingRecipes: unknown;
  evolutionPrescreen: unknown;
}

export interface BootstrapDimensionSessionPipelineResult {
  activeDimIds: string[];
  skippedDims: string[];
  incrementalSkippedDims: string[];
  candidateResults: CandidateResults;
  dimensionCandidates: Record<string, DimensionCandidateData>;
  dimensionStats: Record<string, DimensionStat>;
  enableParallel: boolean;
  concurrency: number;
  startedAtMs: number;
}

export async function runBootstrapDimensionSession({
  ctx,
  dataRoot,
  dimensions,
  runtime,
  agentService,
  systemRunContextFactory,
  emitter,
  sessionId,
  sessionAbortSignal,
  taskManager,
  terminalToolsetConfig,
  primaryLang,
  allFiles,
  scanPlan,
  scanEvidencePack,
  targetFileMap,
  depGraphData,
  astProjectSummary,
  guardAudit,
  panoramaResult,
  callGraphResult,
  isIncremental,
  incrementalPlan,
  existingRecipes,
  evolutionPrescreen,
}: RunBootstrapDimensionSessionOptions): Promise<BootstrapDimensionSessionPipelineResult> {
  const concurrency = Number.parseInt(process.env.ALEMBIC_PARALLEL_CONCURRENCY || '3', 10);
  const enableParallel = process.env.ALEMBIC_PARALLEL_BOOTSTRAP !== 'false';
  const scheduler = new TierScheduler();
  const activeDimIds = dimensions.map((dimension) => dimension.id);
  const incrementalSkippedDims = resolveIncrementalSkippedDimensions({
    isIncremental,
    incrementalPlan,
    activeDimIds,
    emitter,
  });

  logger.info(
    `[Insight-v3] Active dimensions: [${activeDimIds.join(', ')}], concurrency=${enableParallel ? concurrency : 1}, terminalToolset=${terminalToolsetConfig.terminalToolset}${isIncremental ? `, incremental skip: [${incrementalSkippedDims.join(', ')}]` : ''}`
  );

  const candidateResults: CandidateResults = { created: 0, failed: 0, errors: [] };
  const dimensionCandidates: Record<string, DimensionCandidateData> = {};
  const dimensionStats: Record<string, DimensionStat> = {};

  const { completedCheckpoints, skippedDims } = await restoreCheckpointDimensions({
    dataRoot,
    activeDimIds,
    dimContext: runtime.dimContext,
    sessionStore: runtime.sessionStore,
    emitter,
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
  } = prepareBootstrapRescanState({ existingRecipes, evolutionPrescreen });

  const resolvePlan = (dimId: string) =>
    resolveBootstrapDimensionPlanData({ dimId, dimensions, rescanContext });
  const createDimensionRunInput = (dimId: string, plan: BootstrapDimensionPlan) =>
    createBootstrapDimensionRuntimeInput({
      dimId,
      plan,
      memoryCoordinator: runtime.memoryCoordinator,
      systemRunContextFactory,
      projectInfo: runtime.projectInfo,
      primaryLang,
      dimContext: runtime.dimContext,
      sessionStore: runtime.sessionStore,
      semanticMemory: runtime.semanticMemory,
      codeEntityGraphInst: runtime.codeEntityGraphInst,
      panoramaResult,
      astProjectSummary,
      guardAudit,
      depGraphData,
      callGraphResult,
      rescanContext,
      targetFileMap,
      globalSubmittedTitles,
      globalSubmittedPatterns,
      globalSubmittedTriggers,
      bootstrapDedup,
      sessionId,
      allFiles,
      scanPlan,
      scanEvidencePack,
      sessionAbortSignal,
      terminalTest: terminalToolsetConfig.terminalTest,
      terminalToolset: terminalToolsetConfig.terminalToolset,
      allowedTerminalModes: terminalToolsetConfig.allowedTerminalModes,
    });

  const { input: bootstrapSessionInput } = buildBootstrapSessionExecutionInput({
    sessionId,
    activeDimIds,
    skippedDimIds: [...incrementalSkippedDims, ...skippedDims],
    concurrency: enableParallel ? concurrency : 1,
    primaryLang,
    projectLang: runtime.projectInfo.lang || null,
    terminalTest: terminalToolsetConfig.terminalTest,
    terminalToolset: terminalToolsetConfig.terminalToolset,
    allowedTerminalModes: terminalToolsetConfig.allowedTerminalModes,
    sessionAbortSignal,
    taskManager,
    scheduler,
    dimensionStats,
    resolvePlan,
    createDimensionRunInput,
    emitDimensionStart: (dimId) => emitter.emitDimensionStart(dimId),
    consumeDimensionResult: (args) =>
      consumeBootstrapDimensionAgentResult({
        ...args,
        ctx,
        dataRoot,
        runtime,
        candidateResults,
        dimensionCandidates,
        dimensionStats,
        emitter,
        sessionId,
      }),
    consumeDimensionError: (args) =>
      consumeBootstrapDimensionError({ ...args, candidateResults, dimensionStats, emitter }),
    consumeTierResult: (tierIndex, tierResults) =>
      consumeBootstrapTierReflection({
        tierIndex,
        tierResults,
        sessionStore: runtime.sessionStore,
      }),
  });

  const startedAtMs = Date.now();
  const parentRunResult = await agentService.run(bootstrapSessionInput);
  consumeBootstrapSessionResultSideEffects({
    parentRunResult,
    activeDimIds,
    skippedDimIds: [...incrementalSkippedDims, ...skippedDims],
    durationMs: Date.now() - startedAtMs,
    sessionStore: runtime.sessionStore,
    dimensionStats,
    consumeMissingDimension: (dimId) =>
      consumeBootstrapDimensionError({
        dimId,
        err: 'missing child result',
        candidateResults,
        dimensionStats,
        emitter,
      }),
  });

  if (bootstrapDedup.count > 0) {
    logger.info(
      `[Insight-v3] BootstrapDedup: ${bootstrapDedup.count} entries registered during session`
    );
  }
  bootstrapDedup.clear();

  return {
    activeDimIds,
    skippedDims,
    incrementalSkippedDims,
    candidateResults,
    dimensionCandidates,
    dimensionStats,
    enableParallel,
    concurrency,
    startedAtMs,
  };
}

async function consumeBootstrapDimensionAgentResult({
  ctx,
  dataRoot,
  runtime,
  candidateResults,
  dimensionCandidates,
  dimensionStats,
  emitter,
  sessionId,
  dimId,
  plan,
  agentRunResult,
  dimStartTime,
  analystScopeId,
}: {
  ctx: BootstrapWorkflowContext;
  dataRoot: string;
  runtime: BootstrapRuntime;
  candidateResults: CandidateResults;
  dimensionCandidates: Record<string, DimensionCandidateData>;
  dimensionStats: Record<string, DimensionStat>;
  emitter: BootstrapEventEmitter;
  sessionId: string;
  dimId: string;
  plan: BootstrapDimensionPlan;
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
    ctx,
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
    emitter,
    dataRoot,
    sessionId,
  });
}

function consumeBootstrapDimensionError({
  dimId,
  err,
  candidateResults,
  dimensionStats,
  emitter,
}: {
  dimId: string;
  err: unknown;
  candidateResults: CandidateResults;
  dimensionStats: Record<string, DimensionStat>;
  emitter: BootstrapEventEmitter;
}) {
  return consumeBootstrapDimensionErrorSideEffects({
    dimId,
    err,
    candidateResults,
    dimensionStats,
    emitter,
  });
}
