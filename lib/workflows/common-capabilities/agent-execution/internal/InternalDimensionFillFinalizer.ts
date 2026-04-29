import {
  consumeBootstrapSkills,
  type SkillResults,
} from '#workflows/common-capabilities/agent-execution/internal/consumers/BootstrapSkillConsumer.js';
import type { initializeBootstrapRuntime } from '#workflows/common-capabilities/agent-execution/internal/context/BootstrapRuntimeInitializer.js';
import type { InternalDimensionFillPreparation } from '#workflows/common-capabilities/agent-execution/internal/InternalDimensionFillPreparation.js';
import {
  consumeInternalDimensionCandidateRelations,
  type InternalDimensionFillSessionResult,
} from '#workflows/common-capabilities/agent-execution/internal/InternalDimensionFillSessionRunner.js';
import {
  runWorkflowCompletionFinalizer,
  type WorkflowSemanticMemoryConsolidationResult,
} from '#workflows/common-capabilities/completion/WorkflowCompletionFinalizer.js';
import { persistWorkflowResult } from '#workflows/common-capabilities/progress/reports/WorkflowResultPersistence.js';

type InternalDimensionFillRuntime = Awaited<ReturnType<typeof initializeBootstrapRuntime>>;

export interface InternalDimensionFillFinalizationResult {
  skillResults: SkillResults;
  consolidationResult: WorkflowSemanticMemoryConsolidationResult | null;
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

  const skillResults: SkillResults = await consumeBootstrapSkills({
    ctx: preparation.ctx,
    dimensions: preparation.dimensions,
    dimensionCandidates: sessionResult.dimensionCandidates,
    sessionStore: runtime.sessionStore,
    emitter: preparation.emitter,
    shouldAbort: () =>
      !!(preparation.taskManager && !preparation.taskManager.isSessionValid(preparation.sessionId)),
  });

  await consumeInternalDimensionCandidateRelations({ preparation, sessionResult });

  const workflowCompletion = await runWorkflowCompletionFinalizer({
    ctx: preparation.ctx,
    session: { id: preparation.sessionId, sessionStore: runtime.sessionStore },
    projectRoot: preparation.projectRoot,
    dataRoot: preparation.dataRoot,
    dependencies: {
      getServiceContainer: () => preparation.ctx.container,
    },
    semanticMemory: { mode: 'immediate' },
  });
  const consolidationResult = workflowCompletion.semanticMemoryResult;

  const { totalTimeMs } = await persistWorkflowResult({
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
    skippedDims: sessionResult.skippedDims,
    incrementalSkippedDims: sessionResult.incrementalSkippedDims,
    isIncremental: preparation.isIncremental,
    incrementalPlan: preparation.incrementalPlan,
    enableParallel: process.env.ALEMBIC_PARALLEL_BOOTSTRAP !== 'false',
    concurrency: parseInt(process.env.ALEMBIC_PARALLEL_CONCURRENCY || '3', 10),
    startedAtMs,
  });

  preparation.ctx.container.singletons._fileCache = null;

  return { skillResults, consolidationResult, totalTimeMs };
}
