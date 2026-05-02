import Logger from '#infra/logging/Logger.js';
import type { IncrementalPlan } from '#types/workflows.js';
import type { DimensionStat } from '#workflows/capabilities/execution/internal-agent/BootstrapConsumers.js';
import { clearDimensionCheckpoints } from '#workflows/capabilities/persistence/DimensionCheckpoint.js';
import type {
  PersistWorkflowResultOptions,
  WorkflowResultPersistenceResult,
} from '#workflows/capabilities/persistence/WorkflowReportTypes.js';
import { writeWorkflowReport } from '#workflows/capabilities/persistence/WorkflowReportWriter.js';
import {
  createDefaultFileDiffPlanner,
  saveWorkflowSnapshot,
} from '#workflows/capabilities/persistence/WorkflowSnapshotStore.js';

const logger = Logger.getInstance();

export async function persistWorkflowResult({
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
  startedAtMs,
  createFileDiffPlanner = createDefaultFileDiffPlanner,
}: PersistWorkflowResultOptions): Promise<WorkflowResultPersistenceResult> {
  const totalTimeMs = Date.now() - startedAtMs;
  const { totalTokenUsage, totalToolCalls } = summarizeWorkflowDimensionStats(dimensionStats);
  logBootstrapSummary({
    totalTimeMs,
    totalTokenUsage,
    totalToolCalls,
    candidateResults,
    skillResults,
    consolidationResult,
    skippedDims,
    incrementalSkippedDims,
    isIncremental,
    incrementalPlan,
    enableParallel,
    concurrency,
  });

  const report = await writeWorkflowReport({
    ctx,
    dataRoot,
    sessionId,
    projectRoot,
    projectInfo,
    dimensionStats,
    candidateResults,
    skillResults,
    consolidationResult,
    skippedDims,
    incrementalSkippedDims,
    isIncremental,
    incrementalPlan,
    totalTimeMs,
    totalTokenUsage,
    totalToolCalls,
  });

  await clearDimensionCheckpoints(dataRoot);

  const snapshotId = saveWorkflowSnapshot({
    ctx,
    projectRoot,
    sessionId,
    allFiles,
    dimensionStats,
    sessionStore,
    totalTimeMs,
    candidateResults,
    primaryLang: projectInfo.lang,
    isIncremental,
    incrementalPlan,
    createFileDiffPlanner,
  });

  return { totalTimeMs, totalTokenUsage, totalToolCalls, report, snapshotId };
}

export function summarizeWorkflowDimensionStats(dimensionStats: Record<string, DimensionStat>) {
  const totalTokenUsage = { input: 0, output: 0 };
  const totalToolCalls = Object.values(dimensionStats).reduce(
    (sum, stat) => sum + (stat.toolCallCount || 0),
    0
  );
  for (const stat of Object.values(dimensionStats)) {
    if (stat.tokenUsage) {
      totalTokenUsage.input += stat.tokenUsage.input || 0;
      totalTokenUsage.output += stat.tokenUsage.output || 0;
    }
  }
  return { totalTokenUsage, totalToolCalls };
}

function logBootstrapSummary({
  totalTimeMs,
  totalTokenUsage,
  totalToolCalls,
  candidateResults,
  skillResults,
  consolidationResult,
  skippedDims,
  incrementalSkippedDims,
  isIncremental,
  incrementalPlan,
  enableParallel,
  concurrency,
}: {
  totalTimeMs: number;
  totalTokenUsage: { input: number; output: number };
  totalToolCalls: number;
  candidateResults: import('#workflows/capabilities/execution/internal-agent/BootstrapConsumers.js').CandidateResults;
  skillResults: import('#workflows/capabilities/execution/internal-agent/BootstrapConsumers.js').SkillResults;
  consolidationResult:
    | import('#workflows/capabilities/persistence/WorkflowReportTypes.js').WorkflowReportConsolidationResult
    | null;
  skippedDims: string[];
  incrementalSkippedDims: string[];
  isIncremental?: boolean | null;
  incrementalPlan?: IncrementalPlan | null;
  enableParallel: boolean;
  concurrency: number;
}) {
  logger.info(
    [
      `[Insight-v3] ═══ Pipeline complete ═══`,
      isIncremental && incrementalPlan
        ? `  Mode: INCREMENTAL (${incrementalPlan.affectedDimensions.length} affected, ${incrementalSkippedDims.length} skipped)`
        : '',
      `  Candidates: ${candidateResults.created} created, ${candidateResults.errors.length} errors`,
      `  Skills: ${skillResults.created} created, ${skillResults.failed} failed`,
      consolidationResult
        ? `  Semantic Memory: +${consolidationResult.total.added} ADD, ~${consolidationResult.total.updated} UPDATE, ⊕${consolidationResult.total.merged} MERGE`
        : '',
      `  Time: ${totalTimeMs}ms (${(totalTimeMs / 1000).toFixed(1)}s)`,
      `  Mode: ${enableParallel ? `parallel (concurrency=${concurrency})` : 'serial'}`,
      `  Tokens: input=${totalTokenUsage.input}, output=${totalTokenUsage.output}`,
      `  Tool calls: ${totalToolCalls}`,
      skippedDims.length > 0 ? `  Checkpoints restored: [${skippedDims.join(', ')}]` : '',
      incrementalSkippedDims.length > 0
        ? `  Incremental skip: [${incrementalSkippedDims.join(', ')}]`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  );
}
