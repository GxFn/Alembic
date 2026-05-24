import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowSnapshotSummary } from '@alembic/core/host-agent-workflows';
import {
  persistWorkflowResult,
  type WorkflowReport,
  writeWorkflowReportHistory,
  writeWorkflowReportHistoryWithWriteZone,
} from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import {
  mergeAgentEfficiencySummaries,
  normalizeAgentEfficiencySummary,
} from '#service/bootstrap/BootstrapEfficiency.js';
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
    sessionId: preparation.sessionId,
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

  const persistenceInput = {
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
  } as unknown as Parameters<typeof persistWorkflowResult>[0];

  const persistenceResult = await persistWorkflowResult(persistenceInput);
  await persistEfficiencyAugmentedWorkflowReport({
    ctx: preparation.ctx,
    dataRoot: preparation.dataRoot,
    dimensionStats: sessionResult.dimensionStats,
    report: persistenceResult.report,
    skillResults,
  });
  const { totalTimeMs, snapshotId, snapshot } = persistenceResult;

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

async function persistEfficiencyAugmentedWorkflowReport({
  ctx,
  dataRoot,
  dimensionStats,
  report,
  skillResults,
}: {
  ctx: InternalDimensionFillPreparation['ctx'];
  dataRoot: string;
  dimensionStats: InternalDimensionFillSessionResult['dimensionStats'];
  report: WorkflowReport | null;
  skillResults: SkillResults;
}) {
  if (!report) {
    return;
  }

  const augmentedEfficiency = augmentWorkflowReportWithEfficiency(report, dimensionStats);
  const augmentedSkillDelivery = augmentWorkflowReportWithSkillDeliveryReceipts(
    report,
    skillResults
  );
  if (!augmentedEfficiency && !augmentedSkillDelivery) {
    return;
  }

  try {
    const writeZone = ctx.container.singletons?.writeZone as
      | Parameters<typeof writeWorkflowReportHistoryWithWriteZone>[0]
      | undefined;
    if (writeZone) {
      await writeZone.writeFileAsync(
        writeZone.runtime('bootstrap-report.json'),
        JSON.stringify(report, null, 2)
      );
      await writeWorkflowReportHistoryWithWriteZone(writeZone, report);
      return;
    }

    const reportDir = path.join(dataRoot, '.asd');
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(
      path.join(reportDir, 'bootstrap-report.json'),
      JSON.stringify(report, null, 2)
    );
    await writeWorkflowReportHistory(reportDir, report);
  } catch (err: unknown) {
    Logger.warn(
      `[InternalDimensionFill] workflow report augmentation skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function augmentWorkflowReportWithSkillDeliveryReceipts(
  report: WorkflowReport,
  skillResults: SkillResults
): boolean {
  const receipts = skillResults.deliveryReceipts ?? [];
  if (receipts.length === 0) {
    return false;
  }

  const summaries = skillResults.deliveryReceiptSummaries ?? [];
  const validationIssues = skillResults.deliveryReceiptValidationIssues ?? [];
  report.projectSkillDelivery = {
    contract: 'ProjectSkillDeliveryReceipt',
    route: 'alembic',
    receiptCount: receipts.length,
    receipts,
    summaries,
    validationIssues,
  };
  report.totals = {
    ...(report.totals || {}),
    projectSkillDeliveryReceipts: receipts.length,
  };

  for (const receipt of receipts) {
    if (!receipt.dimensionId) {
      continue;
    }
    report.dimensions[receipt.dimensionId] = {
      ...(report.dimensions[receipt.dimensionId] || {}),
      projectSkillDelivery: {
        receiptId: receipt.id,
        runtimeExportStatus: receipt.runtimeExport.status,
        skillName: receipt.skillName,
        summary: receipt.shoutSummary.message,
      },
    };
  }

  return true;
}

export function augmentWorkflowReportWithEfficiency(
  report: WorkflowReport,
  dimensionStats: InternalDimensionFillSessionResult['dimensionStats']
): boolean {
  const sessionEfficiency = mergeAgentEfficiencySummaries(
    Object.values(dimensionStats).map((stat) => stat.efficiency)
  );
  if (!sessionEfficiency) {
    return false;
  }

  report.efficiency = sessionEfficiency;
  report.session = {
    ...(report.session || {}),
    efficiency: sessionEfficiency,
  };
  report.totals = {
    ...(report.totals || {}),
    efficiency: sessionEfficiency,
  };
  report.comparisonHints = {
    ...(isRecord(report.comparisonHints) ? report.comparisonHints : {}),
    cacheHits: sessionEfficiency.cacheHits,
    duplicateToolCalls: sessionEfficiency.duplicateToolCalls,
    maxCompactionLevel: sessionEfficiency.maxCompactionLevel,
    nudgeCount: sessionEfficiency.nudgeCount,
    replanCount: sessionEfficiency.replanCount,
  };

  for (const [dimId, stat] of Object.entries(dimensionStats)) {
    const efficiency = normalizeAgentEfficiencySummary(stat.efficiency);
    if (!efficiency) {
      continue;
    }
    report.dimensions[dimId] = {
      ...(report.dimensions[dimId] || {}),
      efficiency,
    };
  }

  return true;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
