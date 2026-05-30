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
  PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT,
  PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT_VERSION,
} from './BootstrapPcvNodeLocalEvidence.js';

type InternalDimensionFillRuntime = Awaited<ReturnType<typeof initializeBootstrapRuntime>>;

interface PcvAnalyzeGroundingProcessMetric {
  burnCount: number;
  chainNodeIds: string[];
  deepseekV4NoForcedToolChoiceCount: number;
  deterministicEvidenceConsumedCount: number;
  dimensionsWithEvidence: number;
  evidenceProducedCount: number;
  invalidNoEvidenceCount: number;
  missingLinkReasons: string[];
  nodeIds: string[];
  planningOnlyCount: number;
  recordOnlyCount: number;
  statuses: Record<string, number>;
  summaryOnlyCount: number;
  toolSchemasVisibleCount: number;
  verificationOnlyCount: number;
}

interface PcvProcessMetrics {
  analyzeGrounding: PcvAnalyzeGroundingProcessMetric;
}

type WorkflowResultPersistenceInput = Parameters<typeof persistWorkflowResult>[0];

export interface InternalDimensionFillFinalizerStepMap {
  cacheWarmupCleanup: 'clearInternalDimensionSessionDedupCache';
  skillConsumption: 'consumeInternalDimensionSkillsStep';
  candidateRelations: 'consumeInternalDimensionCandidateRelationsStep';
  completion: 'runInternalDimensionCompletionStep';
  persistence: 'buildInternalDimensionPersistenceInput';
  reportAugmentation: 'augmentInternalDimensionWorkflowReport';
  historyRewrite: 'persistEfficiencyAugmentedWorkflowReport';
  runtimeCacheCleanup: 'cleanupInternalDimensionRuntimeCaches';
}

export interface InternalDimensionCompletionStepResult {
  completionSummary: WorkflowCompletionSummary;
  consolidationResult: WorkflowSemanticMemoryConsolidationResult | null;
  pipelineMode: 'bootstrap' | 'rescan';
  workflowCompletion: WorkflowCompletionFinalizerResult;
}

export interface InternalDimensionReportAugmentationResult {
  changed: boolean;
  efficiency: boolean;
  historyRewrite: boolean;
  pcvNodeLocal: boolean;
  skillDelivery: boolean;
  warningOnly: boolean;
}

export interface InternalDimensionRuntimeCacheCleanupResult {
  bootstrapDedupCleared?: boolean;
  fileCacheCleared?: boolean;
}

export interface InternalDimensionFillFinalizationResult {
  skillResults: SkillResults;
  consolidationResult: WorkflowSemanticMemoryConsolidationResult | null;
  completionSummary: WorkflowCompletionSummary;
  finalizerStepMap: InternalDimensionFillFinalizerStepMap;
  reportAugmentation: InternalDimensionReportAugmentationResult;
  runtimeCacheCleanup: InternalDimensionRuntimeCacheCleanupResult;
  snapshotId: string | null;
  snapshot: WorkflowSnapshotSummary;
  totalTimeMs: number;
}

export function buildInternalDimensionFinalizerStepMap(): InternalDimensionFillFinalizerStepMap {
  return {
    cacheWarmupCleanup: 'clearInternalDimensionSessionDedupCache',
    skillConsumption: 'consumeInternalDimensionSkillsStep',
    candidateRelations: 'consumeInternalDimensionCandidateRelationsStep',
    completion: 'runInternalDimensionCompletionStep',
    persistence: 'buildInternalDimensionPersistenceInput',
    reportAugmentation: 'augmentInternalDimensionWorkflowReport',
    historyRewrite: 'persistEfficiencyAugmentedWorkflowReport',
    runtimeCacheCleanup: 'cleanupInternalDimensionRuntimeCaches',
  };
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
  const finalizerStepMap = buildInternalDimensionFinalizerStepMap();
  const dedupCleanup = clearInternalDimensionSessionDedupCache(sessionResult);
  const shouldAbort = createInternalDimensionAbortGuard(preparation);

  const skillResults = await consumeInternalDimensionSkillsStep({
    preparation,
    runtime,
    sessionResult,
    shouldAbort,
  });

  await consumeInternalDimensionCandidateRelationsStep({ preparation, sessionResult });

  const { completionSummary, consolidationResult } = await runInternalDimensionCompletionStep({
    preparation,
    runtime,
    shouldAbort,
  });

  const persistenceInput = buildInternalDimensionPersistenceInput({
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
    ...cleanupInternalDimensionRuntimeCaches(preparation),
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

export function clearInternalDimensionSessionDedupCache(
  sessionResult: Pick<InternalDimensionFillSessionResult, 'bootstrapDedup'>
): InternalDimensionRuntimeCacheCleanupResult {
  sessionResult.bootstrapDedup.clear();
  return { bootstrapDedupCleared: true };
}

export function createInternalDimensionAbortGuard(
  preparation: Pick<InternalDimensionFillPreparation, 'sessionId' | 'taskManager'>
): () => boolean {
  return () =>
    !!(
      preparation.taskManager &&
      (!preparation.taskManager.isSessionValid(preparation.sessionId) ||
        preparation.taskManager.isUserCancelled?.(preparation.sessionId))
    );
}

export async function consumeInternalDimensionSkillsStep({
  preparation,
  runtime,
  sessionResult,
  shouldAbort,
}: {
  preparation: InternalDimensionFillPreparation;
  runtime: InternalDimensionFillRuntime;
  sessionResult: InternalDimensionFillSessionResult;
  shouldAbort: () => boolean;
}): Promise<SkillResults> {
  return consumeBootstrapSkills({
    ctx: preparation.ctx,
    dimensions: preparation.dimensions,
    dimensionCandidates: sessionResult.dimensionCandidates,
    sessionStore: runtime.sessionStore,
    emitter: preparation.emitter,
    sessionId: preparation.sessionId,
    shouldAbort,
  });
}

export async function consumeInternalDimensionCandidateRelationsStep({
  preparation,
  sessionResult,
}: {
  preparation: InternalDimensionFillPreparation;
  sessionResult: InternalDimensionFillSessionResult;
}): Promise<{ consumed: true }> {
  await consumeInternalDimensionCandidateRelations({ preparation, sessionResult });
  return { consumed: true };
}

export async function runInternalDimensionCompletionStep({
  preparation,
  runtime,
  shouldAbort,
}: {
  preparation: InternalDimensionFillPreparation;
  runtime: InternalDimensionFillRuntime;
  shouldAbort: () => boolean;
}): Promise<InternalDimensionCompletionStepResult> {
  const pipelineMode = preparation.view.mode ?? 'bootstrap';
  let workflowCompletion: WorkflowCompletionFinalizerResult;

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

  return {
    completionSummary: buildInternalDimensionCompletionSummary({
      pipelineMode,
      workflowCompletion,
    }),
    consolidationResult: workflowCompletion.semanticMemoryResult,
    pipelineMode,
    workflowCompletion,
  };
}

export function buildInternalDimensionPersistenceInput({
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
  preparation: InternalDimensionFillPreparation;
  runtime: InternalDimensionFillRuntime;
  sessionResult: InternalDimensionFillSessionResult;
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

export function cleanupInternalDimensionRuntimeCaches(
  preparation: Pick<InternalDimensionFillPreparation, 'ctx'>
): InternalDimensionRuntimeCacheCleanupResult {
  preparation.ctx.container.singletons._fileCache = null;
  return { fileCacheCleared: true };
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
}): Promise<InternalDimensionReportAugmentationResult> {
  if (!report) {
    return emptyInternalDimensionReportAugmentationResult();
  }

  const result = augmentInternalDimensionWorkflowReport({
    dimensionStats,
    report,
    skillResults,
  });
  if (!result.changed) {
    return result;
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
      return { ...result, historyRewrite: true };
    }

    const reportDir = path.join(dataRoot, '.asd');
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(
      path.join(reportDir, 'bootstrap-report.json'),
      JSON.stringify(report, null, 2)
    );
    await writeWorkflowReportHistory(reportDir, report);
    return { ...result, historyRewrite: true };
  } catch (err: unknown) {
    Logger.warn(
      `[InternalDimensionFill] workflow report augmentation skipped: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ...result, historyRewrite: false, warningOnly: true };
  }
}

export function augmentInternalDimensionWorkflowReport({
  dimensionStats,
  report,
  skillResults,
}: {
  dimensionStats: InternalDimensionFillSessionResult['dimensionStats'];
  report: WorkflowReport;
  skillResults: SkillResults;
}): InternalDimensionReportAugmentationResult {
  const efficiency = augmentWorkflowReportWithEfficiency(report, dimensionStats);
  const skillDelivery = augmentWorkflowReportWithSkillDeliveryReceipts(report, skillResults);
  const pcvNodeLocal = augmentWorkflowReportWithPcvNodeLocalBaseline(report, dimensionStats);
  return {
    changed: efficiency || skillDelivery || pcvNodeLocal,
    efficiency,
    historyRewrite: false,
    pcvNodeLocal,
    skillDelivery,
    warningOnly: false,
  };
}

function emptyInternalDimensionReportAugmentationResult(): InternalDimensionReportAugmentationResult {
  return {
    changed: false,
    efficiency: false,
    historyRewrite: false,
    pcvNodeLocal: false,
    skillDelivery: false,
    warningOnly: false,
  };
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
      .map(
        ([dimId, stat]) =>
          [
            dimId,
            normalizePcvNodeEvidenceEnvelope(stat.pcvNodeEvidenceEnvelope) ??
              normalizePcvNodeEvidenceSet(stat.pcvNodeEvidence),
          ] as const
      )
      .filter(([, evidence]) => Boolean(evidence))
  ) as Record<string, BootstrapPcvNodeEvidenceSet>;
  const dimensionIds = Object.keys(dimensionEvidence);
  if (dimensionIds.length === 0) {
    return false;
  }

  const nodeSummary = summarizePcvNodeEvidence(dimensionEvidence);
  const analyzeGrounding = nodeSummary.processMetrics?.analyzeGrounding;
  report.pcvScorecard = {
    contract: PCV_COLD_START_NODE_LOCAL_CONTRACT,
    contractVersion: PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION,
    dimensions: dimensionEvidence,
    nodes: nodeSummary.nodes,
    ...(nodeSummary.processMetrics ? { processMetrics: nodeSummary.processMetrics } : {}),
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
    ...(analyzeGrounding
      ? {
          pcvAnalyzeGroundingBurns: analyzeGrounding.burnCount,
          pcvAnalyzeGroundingDeepSeekV4NoForcedToolChoice:
            analyzeGrounding.deepseekV4NoForcedToolChoiceCount,
          pcvAnalyzeGroundingEvidenceProduced: analyzeGrounding.evidenceProducedCount,
          pcvAnalyzeGroundingInvalidNoEvidence: analyzeGrounding.invalidNoEvidenceCount,
          pcvAnalyzeGroundingToolSchemasVisible: analyzeGrounding.toolSchemasVisibleCount,
        }
      : {}),
  };
  report.comparisonHints = {
    ...(isRecord(report.comparisonHints) ? report.comparisonHints : {}),
    pcvNodeLocalBlockedNodes: nodeSummary.blockedNodes,
    pcvNodeLocalLinkedNodes: nodeSummary.linkedNodes,
    ...(analyzeGrounding
      ? {
          pcvAnalyzeGroundingBurns: analyzeGrounding.burnCount,
          pcvAnalyzeGroundingInvalidNoEvidence: analyzeGrounding.invalidNoEvidenceCount,
        }
      : {}),
  };

  for (const [dimId, evidence] of Object.entries(dimensionEvidence)) {
    report.dimensions[dimId] = {
      ...(report.dimensions[dimId] || {}),
      pcvNodeEvidence: evidence,
    };
  }

  return true;
}

function normalizePcvNodeEvidenceEnvelope(value: unknown): BootstrapPcvNodeEvidenceSet | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.contract !== PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT ||
    value.contractVersion !== PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT_VERSION
  ) {
    return null;
  }
  return normalizePcvNodeEvidenceSet(value.evidence);
}

function normalizePcvNodeEvidenceSet(value: unknown): BootstrapPcvNodeEvidenceSet | null {
  if (!isRecord(value)) {
    return null;
  }
  const evidence: BootstrapPcvNodeEvidenceSet = {};
  if (isRecord(value.n8)) {
    evidence.n8 = value.n8 as unknown as NonNullable<BootstrapPcvNodeEvidenceSet['n8']>;
  }
  if (isRecord(value.groundingLedger)) {
    evidence.groundingLedger = value.groundingLedger as unknown as NonNullable<
      BootstrapPcvNodeEvidenceSet['groundingLedger']
    >;
  }
  if (isRecord(value.n9QualityGate)) {
    evidence.n9QualityGate = value.n9QualityGate as unknown as NonNullable<
      BootstrapPcvNodeEvidenceSet['n9QualityGate']
    >;
  }
  if (isRecord(value.n9RecordRepair)) {
    evidence.n9RecordRepair = value.n9RecordRepair as unknown as NonNullable<
      BootstrapPcvNodeEvidenceSet['n9RecordRepair']
    >;
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

  for (const nodeKey of ['n8', 'n9QualityGate', 'n9RecordRepair', 'n11', 'n12'] as const) {
    const statuses: Record<string, number> = {};
    const missingLinkReasons = new Set<string>();
    const nodeIds = new Set<string>();
    const chainNodeIds = new Set<string>();
    let dimensionsWithEvidence = 0;
    let sourceRefTotal = 0;
    let sourceRefValid = 0;
    let sourceRefInvalid = 0;
    let attributedInvalidSourceRefCount = 0;
    let repairedSourceRefCount = 0;
    let rejectedSourceRefCount = 0;
    let unattributedInvalidSourceRefCount = 0;
    let warningSourceRefCount = 0;
    const sourceRefReasonCounts: Record<string, number> = {};
    const sourceRefValidityStatuses: Record<string, number> = {};
    const sourceRefValidationModes = new Set<string>();
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
      const nodeId = stringValue(nodeEvidence.nodeId);
      const chainNodeId = stringValue(nodeEvidence.chainNodeId);
      if (nodeId) {
        nodeIds.add(nodeId);
      }
      if (chainNodeId) {
        chainNodeIds.add(chainNodeId);
      }
      if (nodeEvidence.status === 'linked') {
        linkedNodes++;
      }
      if (nodeEvidence.status === 'blocked-by-observability-gap') {
        blockedNodes++;
      }
      if (nodeKey === 'n11' && isRecord(nodeEvidence)) {
        sourceRefTotal +=
          numberValue(nodeEvidence.totalSourceRefCount) ??
          (Array.isArray(nodeEvidence.sourceRefs) ? nodeEvidence.sourceRefs.length : 0);
        sourceRefValid += numberValue(nodeEvidence.validSourceRefCount) ?? 0;
        sourceRefInvalid += numberValue(nodeEvidence.invalidSourceRefCount) ?? 0;
        const explicitAttributedInvalid = numberValue(nodeEvidence.attributedInvalidSourceRefCount);
        const explicitUnattributedInvalid = numberValue(
          nodeEvidence.unattributedInvalidSourceRefCount
        );
        if (explicitAttributedInvalid != null || explicitUnattributedInvalid != null) {
          attributedInvalidSourceRefCount += explicitAttributedInvalid ?? 0;
          unattributedInvalidSourceRefCount += explicitUnattributedInvalid ?? 0;
        } else if (Array.isArray(nodeEvidence.invalidSourceRefs)) {
          const attributed = nodeEvidence.invalidSourceRefs.filter(
            (invalid) =>
              isRecord(invalid) &&
              Array.isArray(invalid.attributions) &&
              invalid.attributions.length > 0
          ).length;
          attributedInvalidSourceRefCount += attributed;
          unattributedInvalidSourceRefCount += Math.max(
            0,
            nodeEvidence.invalidSourceRefs.length - attributed
          );
        }
        repairedSourceRefCount +=
          numberValue(nodeEvidence.repairedSourceRefCount) ??
          (Array.isArray(nodeEvidence.repairedSourceRefs)
            ? nodeEvidence.repairedSourceRefs.length
            : 0);
        rejectedSourceRefCount +=
          numberValue(nodeEvidence.rejectedSourceRefCount) ??
          (Array.isArray(nodeEvidence.rejectedSourceRefs)
            ? nodeEvidence.rejectedSourceRefs.length
            : 0);
        warningSourceRefCount +=
          numberValue(nodeEvidence.warningSourceRefCount) ??
          (Array.isArray(nodeEvidence.warningSourceRefs)
            ? nodeEvidence.warningSourceRefs.length
            : 0);
        const hasTopLevelReasonCounts = isRecord(nodeEvidence.sourceRefReasonCounts);
        mergeNumericRecord(sourceRefReasonCounts, nodeEvidence.sourceRefReasonCounts);
        if (!hasTopLevelReasonCounts && isRecord(nodeEvidence.sourceRefValidity)) {
          mergeNumericRecord(sourceRefReasonCounts, nodeEvidence.sourceRefValidity.reasonCounts);
        }
        const validityStatus = stringValue(nodeEvidence.sourceRefValidityStatus);
        if (validityStatus) {
          sourceRefValidityStatuses[validityStatus] =
            (sourceRefValidityStatuses[validityStatus] || 0) + 1;
        }
        const validationMode = stringValue(nodeEvidence.sourceRefValidationMode);
        if (validationMode) {
          sourceRefValidationModes.add(validationMode);
        }
      }
    }
    if (dimensionsWithEvidence === 0) {
      continue;
    }
    const summary: Record<string, unknown> = {
      chainNodeIds: [...chainNodeIds],
      dimensionsWithEvidence,
      missingLinkReasons: [...missingLinkReasons],
      nodeIds: [...nodeIds],
      statuses,
    };
    if (nodeKey === 'n11') {
      summary.sourceRefValidity = {
        invalidSourceRefCount: sourceRefInvalid,
        invalidSourceRefRatio:
          sourceRefTotal > 0 ? Number((sourceRefInvalid / sourceRefTotal).toFixed(4)) : 0,
        attributedInvalidSourceRefCount,
        reasonCounts: sourceRefReasonCounts,
        repairedSourceRefCount,
        rejectedSourceRefCount,
        statuses: sourceRefValidityStatuses,
        totalSourceRefCount: sourceRefTotal,
        unattributedInvalidSourceRefCount,
        validSourceRefCount: sourceRefValid,
        validationModes: [...sourceRefValidationModes],
        warningSourceRefCount,
      };
    }
    nodes[nodeKey] = summary;
  }

  const processMetrics = summarizePcvAnalyzeGrounding(dimensionEvidence);
  return { blockedNodes, linkedNodes, nodeCount, nodes, processMetrics };
}

function summarizePcvAnalyzeGrounding(
  dimensionEvidence: Record<string, BootstrapPcvNodeEvidenceSet>
): PcvProcessMetrics | null {
  let dimensionsWithEvidence = 0;
  let burnCount = 0;
  let invalidNoEvidenceCount = 0;
  let planningOnlyCount = 0;
  let evidenceProducedCount = 0;
  let deterministicEvidenceConsumedCount = 0;
  let verificationOnlyCount = 0;
  let recordOnlyCount = 0;
  let summaryOnlyCount = 0;
  let toolSchemasVisibleCount = 0;
  let deepseekV4NoForcedToolChoiceCount = 0;
  const statuses: Record<string, number> = {};
  const missingLinkReasons = new Set<string>();
  const nodeIds = new Set<string>();
  const chainNodeIds = new Set<string>();

  for (const evidence of Object.values(dimensionEvidence)) {
    const grounding = evidence.groundingLedger;
    if (!grounding) {
      continue;
    }
    dimensionsWithEvidence++;
    burnCount += grounding.burnCount;
    invalidNoEvidenceCount += grounding.invalidNoEvidenceCount;
    planningOnlyCount += grounding.planningOnlyCount;
    evidenceProducedCount += grounding.evidenceProducedCount;
    deterministicEvidenceConsumedCount += grounding.deterministicEvidenceConsumedCount;
    verificationOnlyCount += grounding.verificationOnlyCount;
    recordOnlyCount += grounding.recordOnlyCount;
    summaryOnlyCount += grounding.summaryOnlyCount;
    toolSchemasVisibleCount += grounding.toolSchemasVisibleCount;
    deepseekV4NoForcedToolChoiceCount += grounding.deepseekV4NoForcedToolChoiceCount;
    statuses[grounding.status] = (statuses[grounding.status] || 0) + 1;
    for (const reason of grounding.missingLinkReasons || []) {
      missingLinkReasons.add(reason);
    }
    const nodeId = stringValue(grounding.nodeId);
    const chainNodeId = stringValue(grounding.chainNodeId);
    if (nodeId) {
      nodeIds.add(nodeId);
    }
    if (chainNodeId) {
      chainNodeIds.add(chainNodeId);
    }
  }

  if (dimensionsWithEvidence === 0) {
    return null;
  }

  return {
    analyzeGrounding: {
      burnCount,
      chainNodeIds: [...chainNodeIds],
      deepseekV4NoForcedToolChoiceCount,
      deterministicEvidenceConsumedCount,
      dimensionsWithEvidence,
      evidenceProducedCount,
      invalidNoEvidenceCount,
      missingLinkReasons: [...missingLinkReasons],
      nodeIds: [...nodeIds],
      planningOnlyCount,
      recordOnlyCount,
      statuses,
      summaryOnlyCount,
      toolSchemasVisibleCount,
      verificationOnlyCount,
    },
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mergeNumericRecord(target: Record<string, number>, value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const count = numberValue(entry);
    if (count == null) {
      continue;
    }
    target[key] = (target[key] || 0) + count;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
