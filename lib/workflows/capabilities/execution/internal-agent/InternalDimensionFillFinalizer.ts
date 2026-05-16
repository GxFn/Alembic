import Logger from '#infra/logging/Logger.js';
import {
  runWorkflowCompletionFinalizer,
  type WorkflowCompletionFinalizerResult,
  type WorkflowCompletionSummary,
  type WorkflowSemanticMemoryConsolidationResult,
} from '#workflows/capabilities/completion/WorkflowCompletionFinalizer.js';
import {
  consumeBootstrapSkills,
  type SkillResults,
} from '#workflows/capabilities/execution/internal-agent/BootstrapConsumers.js';
import type { initializeBootstrapRuntime } from '#workflows/capabilities/execution/internal-agent/BootstrapRuntimeInitializer.js';
import type { InternalDimensionFillPreparation } from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillPreparation.js';
import {
  consumeInternalDimensionCandidateRelations,
  type InternalDimensionFillSessionResult,
} from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillSessionRunner.js';
import type { WorkflowSnapshotSummary } from '#workflows/capabilities/persistence/WorkflowReportTypes.js';
import { persistWorkflowResult } from '#workflows/capabilities/persistence/WorkflowResultPersistence.js';

type InternalDimensionFillRuntime = Awaited<ReturnType<typeof initializeBootstrapRuntime>>;

export interface InternalDimensionFillFinalizationResult {
  skillResults: SkillResults;
  consolidationResult: WorkflowSemanticMemoryConsolidationResult | null;
  completionSummary: WorkflowCompletionSummary;
  snapshotId: string | null;
  snapshot: WorkflowSnapshotSummary;
  totalTimeMs: number;
}

export async function finalizeInternalDimensionFill({
  preparation,
  runtime,
  sessionResult,
  startedAtMs,
}: {
  preparation: InternalDimensionFillPreparation;
  runtime: InternalDimensionFillRuntime;
  sessionResult: InternalDimensionFillSessionResult;
  startedAtMs: number;
}): Promise<InternalDimensionFillFinalizationResult> {
  sessionResult.bootstrapDedup.clear();

  const shouldAbort = () =>
    !!(
      preparation.taskManager &&
      (!preparation.taskManager.isSessionValid(preparation.sessionId) ||
        preparation.taskManager.isUserCancelled?.(preparation.sessionId))
    );

  const skillResults: SkillResults = await consumeBootstrapSkills({
    ctx: preparation.ctx,
    dimensions: preparation.dimensions,
    dimensionCandidates: sessionResult.dimensionCandidates,
    sessionStore: runtime.sessionStore,
    emitter: preparation.emitter,
    shouldAbort,
  });

  await consumeInternalDimensionCandidateRelations({ preparation, sessionResult });

  const pipelineMode = preparation.view.mode ?? 'bootstrap';
  let workflowCompletion: Awaited<ReturnType<typeof runWorkflowCompletionFinalizer>>;

  if (pipelineMode === 'rescan') {
    Logger.info(
      '[InternalDimensionFill] rescan mode — skipping delivery/wiki/memory (pipeline isolation)'
    );
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
  const consolidationResult = workflowCompletion.semanticMemoryResult;
  const completionSummary = buildInternalDimensionCompletionSummary({
    pipelineMode,
    workflowCompletion,
  });

  const { totalTimeMs, snapshotId, snapshot } = await persistWorkflowResult({
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
  });

  preparation.ctx.container.singletons._fileCache = null;

  return {
    skillResults,
    consolidationResult,
    completionSummary,
    snapshotId,
    snapshot,
    totalTimeMs,
  };
}

export function buildInternalDimensionCompletionSummary({
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
