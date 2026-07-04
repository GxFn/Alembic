/**
 * 结构清洗 W4——报告增强器自 AiDimensionFinalizer 拆出；终态编排与增强职责分离。
 *
 * 本文件承载终态第 5/6 步（reportAugmentation / historyRewrite）的报告增强职责（纯迁移，零逻辑改动）：
 *   - augmentWorkflowReportWithEfficiency：会话/维度效率指标写入报告
 *   - augmentWorkflowReportWithPcvNodeLocalBaseline：PCV 节点本地基线证据写入报告
 *   - augmentWorkflowReportWithSkillDeliveryReceipts：Project Skill 交付回执写入报告
 *   - persistEfficiencyAugmentedWorkflowReport：增强后报告落盘与历史重写
 * AiDimensionFinalizer 保留七步编排并从此处导入增强器。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type WorkflowReport,
  writeWorkflowReportHistory,
  writeWorkflowReportHistoryWithWriteZone,
} from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import {
  mergeAgentEfficiencySummaries,
  normalizeAgentEfficiencySummary,
} from '#recipe-pipeline/generate/runtime/GenerateEfficiency.js';
import type { AiDimensionPreparation } from './AiDimensionPreparation.js';
import type { AiDimensionSessionResult } from './AiDimensionSessionRunner.js';
import type { SkillResults } from './GenerateConsumers.js';
import {
  type GeneratePcvNodeEvidenceSet,
  PCV_COLD_START_NODE_LOCAL_CONTRACT,
  PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION,
  PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT,
  PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT_VERSION,
} from './PcvStageNodeMap.js';

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

export interface AiDimensionReportAugmentationResult {
  changed: boolean;
  efficiency: boolean;
  historyRewrite: boolean;
  pcvNodeLocal: boolean;
  skillDelivery: boolean;
  warningOnly: boolean;
}

export async function persistEfficiencyAugmentedWorkflowReport({
  ctx,
  dataRoot,
  dimensionStats,
  report,
  skillResults,
}: {
  ctx: AiDimensionPreparation['ctx'];
  dataRoot: string;
  dimensionStats: AiDimensionSessionResult['dimensionStats'];
  report: WorkflowReport | null;
  skillResults: SkillResults;
}): Promise<AiDimensionReportAugmentationResult> {
  if (!report) {
    return emptyAiDimensionReportAugmentationResult();
  }

  const result = augmentAiDimensionWorkflowReport({
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
      `[AiDimension] workflow report augmentation skipped: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ...result, historyRewrite: false, warningOnly: true };
  }
}

export function augmentAiDimensionWorkflowReport({
  dimensionStats,
  report,
  skillResults,
}: {
  dimensionStats: AiDimensionSessionResult['dimensionStats'];
  report: WorkflowReport;
  skillResults: SkillResults;
}): AiDimensionReportAugmentationResult {
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

function emptyAiDimensionReportAugmentationResult(): AiDimensionReportAugmentationResult {
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
  dimensionStats: AiDimensionSessionResult['dimensionStats']
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
  dimensionStats: AiDimensionSessionResult['dimensionStats']
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
  ) as Record<string, GeneratePcvNodeEvidenceSet>;
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

function normalizePcvNodeEvidenceEnvelope(value: unknown): GeneratePcvNodeEvidenceSet | null {
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

function normalizePcvNodeEvidenceSet(value: unknown): GeneratePcvNodeEvidenceSet | null {
  if (!isRecord(value)) {
    return null;
  }
  const evidence: GeneratePcvNodeEvidenceSet = {};
  if (isRecord(value.n8)) {
    evidence.n8 = value.n8 as unknown as NonNullable<GeneratePcvNodeEvidenceSet['n8']>;
  }
  if (isRecord(value.groundingLedger)) {
    evidence.groundingLedger = value.groundingLedger as unknown as NonNullable<
      GeneratePcvNodeEvidenceSet['groundingLedger']
    >;
  }
  if (isRecord(value.n9QualityGate)) {
    evidence.n9QualityGate = value.n9QualityGate as unknown as NonNullable<
      GeneratePcvNodeEvidenceSet['n9QualityGate']
    >;
  }
  if (isRecord(value.n9RecordRepair)) {
    evidence.n9RecordRepair = value.n9RecordRepair as unknown as NonNullable<
      GeneratePcvNodeEvidenceSet['n9RecordRepair']
    >;
  }
  if (isRecord(value.n12)) {
    evidence.n12 = value.n12 as unknown as NonNullable<GeneratePcvNodeEvidenceSet['n12']>;
  }
  return Object.keys(evidence).length > 0 ? evidence : null;
}

function summarizePcvNodeEvidence(dimensionEvidence: Record<string, GeneratePcvNodeEvidenceSet>) {
  const nodes: Record<string, Record<string, unknown>> = {};
  let linkedNodes = 0;
  let blockedNodes = 0;
  let nodeCount = 0;

  for (const nodeKey of ['n8', 'n9QualityGate', 'n9RecordRepair', 'n12'] as const) {
    const statuses: Record<string, number> = {};
    const missingLinkReasons = new Set<string>();
    const nodeIds = new Set<string>();
    const chainNodeIds = new Set<string>();
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
    nodes[nodeKey] = summary;
  }

  const processMetrics = summarizePcvAnalyzeGrounding(dimensionEvidence);
  return { blockedNodes, linkedNodes, nodeCount, nodes, processMetrics };
}

function summarizePcvAnalyzeGrounding(
  dimensionEvidence: Record<string, GeneratePcvNodeEvidenceSet>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
