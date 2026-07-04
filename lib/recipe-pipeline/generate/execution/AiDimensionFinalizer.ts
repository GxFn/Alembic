import type { WorkflowSnapshotSummary } from '@alembic/core/host-agent-workflows';
import { persistWorkflowResult } from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import {
  runWorkflowCompletionFinalizer,
  type WorkflowCompletionFinalizerResult,
  type WorkflowCompletionSummary,
  type WorkflowSemanticMemoryConsolidationResult,
} from '../completion/CompletionFinalizer.js';
import type { AiDimensionPreparation } from './AiDimensionPreparation.js';
import type { AiDimensionSessionResult } from './AiDimensionSessionRunner.js';
import { consumeGenerateSkills, type SkillResults } from './GenerateConsumers.js';
import {
  type AiDimensionReportAugmentationResult,
  persistEfficiencyAugmentedWorkflowReport,
} from './ReportAugmenters.js';
import type { initializeGenerateRuntime } from './RuntimeInitializer.js';

// 结构清洗 W4——报告增强器（efficiency / PCV 节点基线 / skill 交付回执 / 历史重写）迁至
// ReportAugmenters.ts；本文件保留终态七步编排。以下兼容 re-export 保证旧导入（单测等）零断裂。
export {
  type AiDimensionReportAugmentationResult,
  augmentAiDimensionWorkflowReport,
  augmentWorkflowReportWithEfficiency,
  augmentWorkflowReportWithPcvNodeLocalBaseline,
  augmentWorkflowReportWithSkillDeliveryReceipts,
} from './ReportAugmenters.js';

type AiDimensionRuntime = Awaited<ReturnType<typeof initializeGenerateRuntime>>;

type WorkflowResultPersistenceInput = Parameters<typeof persistWorkflowResult>[0];

export interface AiDimensionFinalizerStepMap {
  cacheWarmupCleanup: 'clearAiDimensionSessionDedupCache';
  skillConsumption: 'consumeAiDimensionSkillsStep';
  completion: 'runAiDimensionCompletionStep';
  persistence: 'buildAiDimensionPersistenceInput';
  reportAugmentation: 'augmentAiDimensionWorkflowReport';
  historyRewrite: 'persistEfficiencyAugmentedWorkflowReport';
  runtimeCacheCleanup: 'cleanupAiDimensionRuntimeCaches';
}

export interface AiDimensionCompletionStepResult {
  completionSummary: WorkflowCompletionSummary;
  consolidationResult: WorkflowSemanticMemoryConsolidationResult | null;
  pipelineMode: 'bootstrap' | 'rescan';
  workflowCompletion: WorkflowCompletionFinalizerResult;
}

export interface AiDimensionRuntimeCacheCleanupResult {
  bootstrapDedupCleared?: boolean;
  fileCacheCleared?: boolean;
}

export interface AiDimensionFinalizationResult {
  skillResults: SkillResults;
  consolidationResult: WorkflowSemanticMemoryConsolidationResult | null;
  completionSummary: WorkflowCompletionSummary;
  finalizerStepMap: AiDimensionFinalizerStepMap;
  reportAugmentation: AiDimensionReportAugmentationResult;
  runtimeCacheCleanup: AiDimensionRuntimeCacheCleanupResult;
  snapshotId: string | null;
  snapshot: WorkflowSnapshotSummary;
  totalTimeMs: number;
}

export function buildAiDimensionFinalizerStepMap(): AiDimensionFinalizerStepMap {
  return {
    cacheWarmupCleanup: 'clearAiDimensionSessionDedupCache',
    skillConsumption: 'consumeAiDimensionSkillsStep',
    completion: 'runAiDimensionCompletionStep',
    persistence: 'buildAiDimensionPersistenceInput',
    reportAugmentation: 'augmentAiDimensionWorkflowReport',
    historyRewrite: 'persistEfficiencyAugmentedWorkflowReport',
    runtimeCacheCleanup: 'cleanupAiDimensionRuntimeCaches',
  };
}

export async function finalizeAiDimensionPipeline({
  preparation,
  runtime,
  sessionResult,
  startedAtMs,
}: {
  preparation: AiDimensionPreparation;
  runtime: AiDimensionRuntime;
  sessionResult: AiDimensionSessionResult;
  startedAtMs: number;
}): Promise<AiDimensionFinalizationResult> {
  const finalizerStepMap = buildAiDimensionFinalizerStepMap();
  const dedupCleanup = clearAiDimensionSessionDedupCache(sessionResult);
  const shouldAbort = createAiDimensionAbortGuard(preparation);

  const skillResults = await consumeAiDimensionSkillsStep({
    preparation,
    runtime,
    sessionResult,
    shouldAbort,
  });

  const { completionSummary, consolidationResult } = await runAiDimensionCompletionStep({
    preparation,
    runtime,
    shouldAbort,
  });

  const persistenceInput = buildAiDimensionPersistenceInput({
    completionSummary,
    consolidationResult,
    preparation,
    runtime,
    sessionResult,
    skillResults,
    startedAtMs,
  });

  const persistenceResult = await persistWorkflowResult(persistenceInput);
  const reportAugmentation = await persistEfficiencyAugmentedWorkflowReport({
    ctx: preparation.ctx,
    dataRoot: preparation.dataRoot,
    dimensionStats: sessionResult.dimensionStats,
    report: persistenceResult.report,
    skillResults,
  });
  const { totalTimeMs, snapshotId, snapshot } = persistenceResult;

  const runtimeCacheCleanup = {
    ...dedupCleanup,
    ...cleanupAiDimensionRuntimeCaches(preparation),
  };

  return {
    skillResults,
    consolidationResult,
    completionSummary,
    finalizerStepMap,
    reportAugmentation,
    runtimeCacheCleanup,
    snapshotId,
    snapshot,
    totalTimeMs,
  };
}

export function clearAiDimensionSessionDedupCache(
  sessionResult: Pick<AiDimensionSessionResult, 'bootstrapDedup'>
): AiDimensionRuntimeCacheCleanupResult {
  sessionResult.bootstrapDedup.clear();
  return { bootstrapDedupCleared: true };
}

export function createAiDimensionAbortGuard(
  preparation: Pick<AiDimensionPreparation, 'sessionId' | 'taskManager'>
): () => boolean {
  return () =>
    !!(
      preparation.taskManager &&
      (!preparation.taskManager.isSessionValid(preparation.sessionId) ||
        preparation.taskManager.isUserCancelled?.(preparation.sessionId))
    );
}

export async function consumeAiDimensionSkillsStep({
  preparation,
  runtime,
  sessionResult,
  shouldAbort,
}: {
  preparation: AiDimensionPreparation;
  runtime: AiDimensionRuntime;
  sessionResult: AiDimensionSessionResult;
  shouldAbort: () => boolean;
}): Promise<SkillResults> {
  return consumeGenerateSkills({
    ctx: preparation.ctx,
    dimensions: preparation.dimensions,
    dimensionCandidates: sessionResult.dimensionCandidates,
    sessionStore: runtime.sessionStore,
    emitter: preparation.emitter,
    sessionId: preparation.sessionId,
    shouldAbort,
  });
}

export async function runAiDimensionCompletionStep({
  preparation,
  runtime,
  shouldAbort,
}: {
  preparation: AiDimensionPreparation;
  runtime: AiDimensionRuntime;
  shouldAbort: () => boolean;
}): Promise<AiDimensionCompletionStepResult> {
  const pipelineMode = preparation.view.mode ?? 'bootstrap';
  let workflowCompletion: WorkflowCompletionFinalizerResult;

  if (pipelineMode === 'rescan') {
    Logger.info('[AiDimension] rescan mode — skipping delivery/wiki/memory (pipeline isolation)');
    workflowCompletion = { deliveryVerification: null, semanticMemoryResult: null };
  } else {
    workflowCompletion = await runWorkflowCompletionFinalizer({
      ctx: preparation.ctx,
      session: { id: preparation.sessionId, sessionStore: runtime.sessionStore },
      projectRoot: preparation.projectRoot,
      dataRoot: preparation.dataRoot,
      dependencies: {
        getServiceContainer: () => preparation.ctx.container,
      },
      semanticMemory: { mode: 'immediate' },
      steps: preparation.skipTargetDelivery ? { delivery: 'skip', wiki: 'skip' } : undefined,
      shouldAbort,
    });
  }

  return {
    completionSummary: buildAiDimensionCompletionSummary({
      pipelineMode,
      workflowCompletion,
    }),
    consolidationResult: workflowCompletion.semanticMemoryResult,
    pipelineMode,
    workflowCompletion,
  };
}

export function buildAiDimensionPersistenceInput({
  completionSummary,
  consolidationResult,
  preparation,
  runtime,
  sessionResult,
  skillResults,
  startedAtMs,
}: {
  completionSummary: WorkflowCompletionSummary;
  consolidationResult: WorkflowSemanticMemoryConsolidationResult | null;
  preparation: AiDimensionPreparation;
  runtime: AiDimensionRuntime;
  sessionResult: AiDimensionSessionResult;
  skillResults: SkillResults;
  startedAtMs: number;
}): WorkflowResultPersistenceInput {
  return {
    ctx: preparation.ctx,
    dataRoot: preparation.dataRoot,
    projectRoot: preparation.projectRoot,
    projectInfo: runtime.projectInfo,
    sessionId: preparation.sessionId,
    allFiles: preparation.allFiles,
    sessionStore: runtime.sessionStore,
    dimensionStats: sessionResult.dimensionStats,
    candidateResults: sessionResult.candidateResults,
    skillResults,
    consolidationResult,
    completionSummary,
    skippedDims: sessionResult.skippedDims,
    incrementalSkippedDims: sessionResult.incrementalSkippedDims,
    isIncremental: preparation.isIncremental,
    incrementalPlan: preparation.incrementalPlan,
    enableParallel: sessionResult.enableParallel,
    concurrency: sessionResult.concurrency,
    startedAtMs,
  } as unknown as WorkflowResultPersistenceInput;
}

export function cleanupAiDimensionRuntimeCaches(
  preparation: Pick<AiDimensionPreparation, 'ctx'>
): AiDimensionRuntimeCacheCleanupResult {
  preparation.ctx.container.singletons._fileCache = null;
  return { fileCacheCleared: true };
}

export function buildAiDimensionCompletionSummary({
  pipelineMode,
  workflowCompletion,
}: {
  pipelineMode: 'bootstrap' | 'rescan';
  workflowCompletion: WorkflowCompletionFinalizerResult;
}): WorkflowCompletionSummary {
  if (pipelineMode === 'rescan') {
    return {
      mode: 'rescan',
      isolation: 'pipeline-isolation',
      reason: 'rescan skips delivery/wiki/semantic memory to avoid rebuilding downstream artifacts',
      delivery: { status: 'skipped', verification: null },
      wiki: { status: 'skipped' },
      semanticMemory: { status: 'skipped', result: null },
    };
  }

  return {
    mode: 'bootstrap',
    isolation: 'full-completion',
    delivery: {
      status:
        workflowCompletion.deliveryStatus ??
        (workflowCompletion.deliveryVerification ? 'completed' : 'skipped'),
      verification: workflowCompletion.deliveryVerification,
    },
    wiki: { status: workflowCompletion.wikiStatus ?? 'scheduled' },
    semanticMemory: {
      status: workflowCompletion.semanticMemoryResult ? 'completed' : 'skipped',
      result: workflowCompletion.semanticMemoryResult,
    },
  };
}
