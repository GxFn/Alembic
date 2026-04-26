import type {
  AgentRunResult,
  AgentService,
  SystemRunContextFactory,
} from '#agent/service/index.js';
import type { IncrementalPlan } from '#external/mcp/handlers/types.js';
import Logger from '#infra/logging/Logger.js';
import { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import { resolveDataRoot } from '#shared/resolveProjectRoot.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
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
import { TierScheduler } from '#workflows/bootstrap/config/TierScheduler.js';
import { consumeBootstrapCandidateRelations } from '#workflows/bootstrap/consumers/BootstrapCandidateRelationConsumer.js';
import {
  type CandidateResults,
  consumeBootstrapDimensionError as consumeBootstrapDimensionErrorSideEffects,
  consumeBootstrapDimensionResult,
  type DimensionCandidateData,
  type DimensionStat,
} from '#workflows/bootstrap/consumers/BootstrapDimensionConsumer.js';
import {
  type ConsolidationResult,
  consumeBootstrapSemanticMemory,
} from '#workflows/bootstrap/consumers/BootstrapSemanticMemoryConsumer.js';
import { consumeBootstrapSessionResult as consumeBootstrapSessionResultSideEffects } from '#workflows/bootstrap/consumers/BootstrapSessionConsumer.js';
import {
  consumeBootstrapSkills,
  type SkillResults,
} from '#workflows/bootstrap/consumers/BootstrapSkillConsumer.js';
import { consumeBootstrapTierReflection } from '#workflows/bootstrap/consumers/BootstrapTierReflectionConsumer.js';
import { prepareBootstrapRescanState } from '#workflows/bootstrap/context/BootstrapRescanState.js';
import {
  type BootstrapProjectGraphLike,
  initializeBootstrapRuntime,
} from '#workflows/bootstrap/context/BootstrapRuntimeInitializer.js';
import { consumeBootstrapDeliveryAndWiki } from '#workflows/bootstrap/delivery/BootstrapDeliveryConsumer.js';
import { fillDimensionsMock } from '#workflows/bootstrap/mock/MockBootstrapPipeline.js';
import {
  projectAgentRunResult,
  projectBootstrapDimensionAgentOutput,
} from '#workflows/bootstrap/projections/BootstrapDimensionProjection.js';
import { consumeBootstrapReportAndSnapshot } from '#workflows/bootstrap/reports/BootstrapReportSnapshotConsumer.js';

const logger = Logger.getInstance();

interface BootstrapWorkflowSingletons {
  aiProvider?: {
    name?: string;
    model?: string;
    supportsEmbedding?: () => boolean;
    [key: string]: unknown;
  } | null;
  _embedProvider?: { embed?: (text: string) => Promise<number[]>; [key: string]: unknown } | null;
  _fileCache?: BootstrapFileEntry[] | null;
  _projectRoot?: string;
  _config?: Record<string, unknown>;
  _lang?: string | null;
  [key: string]: unknown;
}

interface BootstrapWorkflowServiceKeys {
  agentService: AgentService;
  systemRunContextFactory: SystemRunContextFactory;
  bootstrapTaskManager: BootstrapTaskManagerLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DB type varies (SqliteDatabase|DbWrapper|CeDbLike) across consumers
  database: any;
}

export interface BootstrapWorkflowContainer {
  get<K extends keyof BootstrapWorkflowServiceKeys>(name: K): BootstrapWorkflowServiceKeys[K];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fallback for services not in BootstrapWorkflowServiceKeys
  get(name: string): any;
  singletons: BootstrapWorkflowSingletons;
  buildProjectGraph?(
    projectRoot: string,
    options?: Record<string, unknown>
  ): Promise<BootstrapProjectGraphLike | null>;
  [key: string]: unknown;
}

export interface BootstrapWorkflowContext {
  container: BootstrapWorkflowContainer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ctx shape from various McpContext subtypes
  [key: string]: any;
}

interface BootstrapTaskManagerLike {
  isSessionValid(sessionId: string): boolean;
  getSessionAbortSignal?(): AbortSignal | null;
  emitProgress?(event: string, data: Record<string, unknown>): void;
  [key: string]: unknown;
}

export async function fillDimensionsV3(view: PipelineFillView, dimensions: DimensionDef[]) {
  const { snapshot, projectRoot } = view;
  const ctx = view.ctx as BootstrapWorkflowContext;
  const dataRoot =
    resolveDataRoot(ctx.container as { singletons?: Record<string, unknown> }) || projectRoot;

  const depGraphData = snapshot.dependencyGraph;
  const guardAudit = snapshot.guardAudit;
  const primaryLang = snapshot.language.primaryLang ?? 'unknown';
  const astProjectSummary = snapshot.ast;
  const incrementalPlan = snapshot.incrementalPlan as IncrementalPlan | null;
  const panoramaResult = snapshot.panorama as Record<string, unknown> | null;
  const callGraphResult = snapshot.callGraph;
  const existingRecipes = view.existingRecipes ?? null;
  const evolutionPrescreen = view.evolutionPrescreen ?? null;
  const targetFileMap = view.targetFileMap;

  let taskManager: BootstrapTaskManagerLike | null = null;
  try {
    taskManager = ctx.container.get('bootstrapTaskManager') as BootstrapTaskManagerLike;
  } catch {
    /* not available */
  }
  const sessionId = view.bootstrapSession?.id ?? '';
  const sessionAbortSignal = taskManager?.getSessionAbortSignal?.() ?? null;

  const isIncremental = incrementalPlan?.canIncremental && incrementalPlan?.mode === 'incremental';
  const emitter = new BootstrapEventEmitter(ctx.container);
  logger.info(
    `[Insight-v3] ═══ fillDimensionsV3 entered — ${isIncremental ? 'INCREMENTAL' : 'FULL'} pipeline`
  );

  let allFiles: BootstrapFileEntry[] | null = snapshot.allFiles as unknown as
    | BootstrapFileEntry[]
    | null;

  let agentService: AgentService | null = null;
  let systemRunContextFactory: SystemRunContextFactory | null = null;
  let isMockMode = false;
  try {
    const manager = ctx.container.singletons?._aiProviderManager as { isMock: boolean } | undefined;
    isMockMode = manager?.isMock ?? false;
    if (!isMockMode) {
      agentService = ctx.container.get('agentService');
      systemRunContextFactory = ctx.container.get('systemRunContextFactory');
    }
  } catch {
    /* not available */
  }

  if ((!agentService || !systemRunContextFactory) && !isMockMode) {
    logger.error('[Insight-v3] AI Provider not available — bootstrap requires AI');
    emitter.emitProgress('bootstrap:ai-unavailable', {
      message:
        'AI Provider 不可用，Bootstrap 需要 AI 才能运行。请先配置 AI Provider（如 OpenAI、Anthropic 等）后重试。',
    });
    for (const dim of dimensions) {
      emitter.emitDimensionComplete(dim.id, { type: 'skipped', reason: 'ai-unavailable' });
    }
    return;
  }

  if (isMockMode) {
    logger.info('[Insight-v3] Mock AI detected — routing to mock-pipeline');
    await fillDimensionsMock(view, dimensions);
    return;
  }

  const {
    projectGraph,
    projectInfo,
    dimContext,
    sessionStore,
    semanticMemory,
    codeEntityGraphInst,
    memoryCoordinator,
  } = await initializeBootstrapRuntime({
    container: ctx.container,
    projectRoot,
    dataRoot,
    primaryLang,
    allFiles,
    targetFileMap,
    depGraphData,
    astProjectSummary: astProjectSummary as Record<string, unknown> | null,
    guardAudit: guardAudit as Record<string, unknown> | null,
    isIncremental,
    incrementalPlan,
  });

  const concurrency = parseInt(process.env.ALEMBIC_PARALLEL_CONCURRENCY || '3', 10);
  const enableParallel = process.env.ALEMBIC_PARALLEL_BOOTSTRAP !== 'false';
  const scheduler = new TierScheduler();
  const activeDimIds = dimensions.map((d: DimensionDef) => d.id);
  const incrementalSkippedDims = resolveIncrementalSkippedDimensions({
    isIncremental,
    incrementalPlan,
    activeDimIds,
    emitter,
  });

  logger.info(
    `[Insight-v3] Active dimensions: [${activeDimIds.join(', ')}], concurrency=${enableParallel ? concurrency : 1}${isIncremental ? `, incremental skip: [${incrementalSkippedDims.join(', ')}]` : ''}`
  );

  const candidateResults: CandidateResults = { created: 0, failed: 0, errors: [] };
  const dimensionCandidates: Record<string, DimensionCandidateData> = {};
  const dimensionStats: Record<string, DimensionStat> = {};

  const { completedCheckpoints, skippedDims } = await restoreCheckpointDimensions({
    dataRoot,
    activeDimIds,
    dimContext,
    sessionStore,
    emitter,
  });
  applyRestoredDimensionState({
    incrementalSkippedDims,
    checkpointSkippedDims: skippedDims,
    completedCheckpoints,
    sessionStore,
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

  function resolveBootstrapDimensionPlan(dimId: string) {
    return resolveBootstrapDimensionPlanData({ dimId, dimensions, rescanContext });
  }

  function createBootstrapDimensionRunInput(dimId: string, plan: BootstrapDimensionPlan) {
    return createBootstrapDimensionRuntimeInput({
      dimId,
      plan,
      memoryCoordinator,
      systemRunContextFactory: systemRunContextFactory!,
      projectInfo,
      primaryLang,
      dimContext,
      sessionStore,
      semanticMemory,
      codeEntityGraphInst,
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
      sessionAbortSignal,
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
      ctx,
      dimId,
      dimConfig: plan.dimConfig,
      needsCandidates: plan.needsCandidates,
      projection,
      runResult,
      dimStartTime,
      analystScopeId,
      memoryCoordinator,
      sessionStore,
      dimContext,
      candidateResults,
      dimensionCandidates,
      dimensionStats,
      emitter,
      dataRoot,
      sessionId,
    });
  }

  function consumeBootstrapDimensionError({ dimId, err }: { dimId: string; err: unknown }) {
    return consumeBootstrapDimensionErrorSideEffects({
      dimId,
      err,
      candidateResults,
      dimensionStats,
      emitter,
    });
  }

  function consumeBootstrapSessionTierResult(
    tierIndex: number,
    tierResults: Map<string, DimensionStat>
  ) {
    return consumeBootstrapTierReflection({
      tierIndex,
      tierResults,
      sessionStore,
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
      sessionStore,
      dimensionStats,
      consumeMissingDimension: (dimId) =>
        consumeBootstrapDimensionError({ dimId, err: 'missing child result' }),
    });
  }

  const { input: bootstrapSessionInput } = buildBootstrapSessionExecutionInput({
    sessionId,
    activeDimIds,
    skippedDimIds: [...incrementalSkippedDims, ...skippedDims],
    concurrency: enableParallel ? concurrency : 1,
    primaryLang,
    projectLang: projectInfo.lang || null,
    sessionAbortSignal,
    taskManager,
    scheduler,
    dimensionStats,
    resolvePlan: resolveBootstrapDimensionPlan,
    createDimensionRunInput: createBootstrapDimensionRunInput,
    emitDimensionStart: (dimId) => emitter.emitDimensionStart(dimId),
    consumeDimensionResult: consumeBootstrapDimensionAgentResult,
    consumeDimensionError: consumeBootstrapDimensionError,
    consumeTierResult: consumeBootstrapSessionTierResult,
  });

  const t0 = Date.now();
  const parentRunResult = await agentService!.run(bootstrapSessionInput);
  consumeBootstrapSessionResult({ parentRunResult, durationMs: Date.now() - t0 });

  if (bootstrapDedup.count > 0) {
    logger.info(
      `[Insight-v3] BootstrapDedup: ${bootstrapDedup.count} entries registered during session`
    );
  }
  bootstrapDedup.clear();

  const skillResults: SkillResults = await consumeBootstrapSkills({
    ctx,
    dimensions,
    dimensionCandidates,
    sessionStore,
    emitter,
    shouldAbort: () => !!(taskManager && !taskManager.isSessionValid(sessionId)),
  });

  await consumeBootstrapCandidateRelations({ ctx, projectRoot, dimensionCandidates });

  const consolidationResult: ConsolidationResult | null = consumeBootstrapSemanticMemory({
    ctx,
    dataRoot,
    sessionId,
    sessionStore,
  });

  const { totalTimeMs } = await consumeBootstrapReportAndSnapshot({
    ctx,
    dataRoot,
    projectRoot,
    projectInfo,
    sessionId,
    allFiles,
    sessionStore,
    dimensionStats,
    candidateResults,
    skillResults,
    consolidationResult,
    skippedDims,
    incrementalSkippedDims,
    isIncremental,
    incrementalPlan,
    enableParallel,
    concurrency,
    startedAtMs: t0,
  });

  allFiles = null;
  ctx.container.singletons._fileCache = null;

  await consumeBootstrapDeliveryAndWiki({ projectRoot, dataRoot, projectGraph });
}

export async function clearSnapshots(
  projectRoot: string,
  ctx: {
    container: BootstrapWorkflowContainer;
    logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  }
) {
  try {
    const db = ctx.container.get('database');
    if (db) {
      const { BootstrapSnapshot } = await import(
        '#workflows/bootstrap/incremental/BootstrapSnapshot.js'
      );
      const snap = new BootstrapSnapshot(db, { logger: ctx.logger });
      snap.clearProject(projectRoot);
      ctx.logger.info('[Bootstrap] Cleared incremental snapshots — forcing full rebuild');
    }
  } catch (err: unknown) {
    ctx.logger.warn(
      `[Bootstrap] clearSnapshots failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export { clearCheckpoints } from '#workflows/bootstrap/checkpoint/BootstrapCheckpointStore.js';
export default fillDimensionsV3;
