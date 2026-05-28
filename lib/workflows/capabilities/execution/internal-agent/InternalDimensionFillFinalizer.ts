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
import {
  type BootstrapPcvNodeEvidenceSet,
  PCV_COLD_START_NODE_LOCAL_CONTRACT,
  PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION,
} from './BootstrapPcvNodeLocalEvidence.js';

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
  const augmentedPcvNodeLocal = augmentWorkflowReportWithPcvNodeLocalBaseline(
    report,
    dimensionStats
  );
  if (!augmentedEfficiency && !augmentedSkillDelivery && !augmentedPcvNodeLocal) {
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

export function augmentWorkflowReportWithPcvNodeLocalBaseline(
  report: WorkflowReport,
  dimensionStats: InternalDimensionFillSessionResult['dimensionStats']
): boolean {
  const dimensionEvidence = Object.fromEntries(
    Object.entries(dimensionStats)
      .map(([dimId, stat]) => [dimId, normalizePcvNodeEvidenceSet(stat.pcvNodeEvidence)] as const)
      .filter(([, evidence]) => Boolean(evidence))
  ) as Record<string, BootstrapPcvNodeEvidenceSet>;
  const dimensionIds = Object.keys(dimensionEvidence);
  if (dimensionIds.length === 0) {
    return false;
  }

  const nodeSummary = summarizePcvNodeEvidence(dimensionEvidence);
  report.pcvScorecard = {
    contract: PCV_COLD_START_NODE_LOCAL_CONTRACT,
    contractVersion: PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION,
    dimensions: dimensionEvidence,
    nodes: nodeSummary.nodes,
    scope: 'alembic-cold-start-bootstrap-node-local',
    summary: {
      blockedNodes: nodeSummary.blockedNodes,
      dimensionCount: dimensionIds.length,
      linkedNodes: nodeSummary.linkedNodes,
      nodeCount: nodeSummary.nodeCount,
    },
  };
  report.totals = {
    ...(report.totals || {}),
    pcvNodeLocalBlockedNodes: nodeSummary.blockedNodes,
    pcvNodeLocalEvidenceDimensions: dimensionIds.length,
    pcvNodeLocalEvidenceNodes: nodeSummary.nodeCount,
    pcvNodeLocalLinkedNodes: nodeSummary.linkedNodes,
  };
  report.comparisonHints = {
    ...(isRecord(report.comparisonHints) ? report.comparisonHints : {}),
    pcvNodeLocalBlockedNodes: nodeSummary.blockedNodes,
    pcvNodeLocalLinkedNodes: nodeSummary.linkedNodes,
  };

  for (const [dimId, evidence] of Object.entries(dimensionEvidence)) {
    report.dimensions[dimId] = {
      ...(report.dimensions[dimId] || {}),
      pcvNodeEvidence: evidence,
    };
  }

  return true;
}

function normalizePcvNodeEvidenceSet(value: unknown): BootstrapPcvNodeEvidenceSet | null {
  if (!isRecord(value)) {
    return null;
  }
  const evidence: BootstrapPcvNodeEvidenceSet = {};
  if (isRecord(value.n8)) {
    evidence.n8 = value.n8 as unknown as NonNullable<BootstrapPcvNodeEvidenceSet['n8']>;
  }
  if (isRecord(value.n11)) {
    evidence.n11 = value.n11 as unknown as NonNullable<BootstrapPcvNodeEvidenceSet['n11']>;
  }
  if (isRecord(value.n12)) {
    evidence.n12 = value.n12 as unknown as NonNullable<BootstrapPcvNodeEvidenceSet['n12']>;
  }
  return Object.keys(evidence).length > 0 ? evidence : null;
}

function summarizePcvNodeEvidence(dimensionEvidence: Record<string, BootstrapPcvNodeEvidenceSet>) {
  const nodes: Record<string, Record<string, unknown>> = {};
  let linkedNodes = 0;
  let blockedNodes = 0;
  let nodeCount = 0;

  for (const nodeKey of ['n8', 'n11', 'n12'] as const) {
    const statuses: Record<string, number> = {};
    const missingLinkReasons = new Set<string>();
    let dimensionsWithEvidence = 0;
    for (const evidence of Object.values(dimensionEvidence)) {
      const nodeEvidence = evidence[nodeKey];
      if (!nodeEvidence) {
        continue;
      }
      dimensionsWithEvidence++;
      nodeCount++;
      statuses[nodeEvidence.status] = (statuses[nodeEvidence.status] || 0) + 1;
      for (const reason of nodeEvidence.missingLinkReasons || []) {
        missingLinkReasons.add(reason);
      }
      if (nodeEvidence.status === 'linked') {
        linkedNodes++;
      }
      if (nodeEvidence.status === 'blocked-by-observability-gap') {
        blockedNodes++;
      }
    }
    if (dimensionsWithEvidence === 0) {
      continue;
    }
    nodes[nodeKey] = {
      dimensionsWithEvidence,
      missingLinkReasons: [...missingLinkReasons],
      statuses,
    };
  }

  return { blockedNodes, linkedNodes, nodeCount, nodes };
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
