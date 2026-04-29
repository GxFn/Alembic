import type { SessionStore } from '#agent/memory/SessionStore.js';
import Logger from '#infra/logging/Logger.js';
import type { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import type { DimensionCheckpointResult, IncrementalPlan } from '#types/workflows.js';
import type {
  CandidateResults,
  DimensionCandidateData,
  DimensionStat,
} from '#workflows/common-capabilities/agent-execution/internal/consumers/BootstrapDimensionConsumer.js';
import type { DimensionContext } from '#workflows/common-capabilities/agent-execution/internal/context/DimensionContext.js';
import { loadDimensionCheckpoints } from '#workflows/common-capabilities/progress/checkpoint/DimensionCheckpointStore.js';

const logger = Logger.getInstance();

export interface DimensionCheckpoint extends DimensionCheckpointResult {
  dimId?: string;
  candidateCount?: number;
  rejectedCount?: number;
  analysisChars?: number;
  referencedFiles?: number;
  durationMs?: number;
  toolCallCount?: number;
  tokenUsage?: { input: number; output: number };
  analysisText?: string;
  referencedFilesList?: string[];
  digest?: unknown;
}

export function syncRestoredSessionStoreDigests({
  sessionStore,
  dimContext,
}: {
  sessionStore: SessionStore;
  dimContext: DimensionContext;
}) {
  const restoredDims = sessionStore.getCompletedDimensions();
  logger.info(
    `[Insight-v3] Restored SessionStore: ${restoredDims.length} dims [${restoredDims.join(', ')}]`
  );

  for (const dimId of restoredDims) {
    const report = sessionStore.getDimensionReport(dimId);
    if (report?.digest) {
      dimContext.addDimensionDigest(
        dimId,
        report.digest as Parameters<typeof dimContext.addDimensionDigest>[1]
      );
    }
  }
  return restoredDims;
}

export function resolveIncrementalSkippedDimensions({
  isIncremental,
  incrementalPlan,
  activeDimIds,
  emitter,
}: {
  isIncremental?: boolean | null;
  incrementalPlan?: IncrementalPlan | null;
  activeDimIds: string[];
  emitter: BootstrapEventEmitter;
}) {
  const incrementalSkippedDims: string[] = [];
  if (!isIncremental || !incrementalPlan) {
    return incrementalSkippedDims;
  }

  const affected = new Set(incrementalPlan.affectedDimensions);
  for (const dimId of activeDimIds) {
    if (!affected.has(dimId) && incrementalPlan.skippedDimensions.includes(dimId)) {
      incrementalSkippedDims.push(dimId);
      emitter.emitDimensionComplete(dimId, {
        type: 'incremental-restored',
        reason: 'no-change-detected',
      });
    }
  }
  if (incrementalSkippedDims.length > 0) {
    logger.info(
      `[Insight-v3] ⏩ Incremental skip: [${incrementalSkippedDims.join(', ')}] ` +
        `(using historical results)`
    );
  }
  return incrementalSkippedDims;
}

export async function restoreCheckpointDimensions({
  dataRoot,
  activeDimIds,
  dimContext,
  sessionStore,
  emitter,
}: {
  dataRoot: string;
  activeDimIds: string[];
  dimContext: DimensionContext;
  sessionStore: SessionStore;
  emitter: BootstrapEventEmitter;
}) {
  const completedCheckpoints = (await loadDimensionCheckpoints(dataRoot)) as Map<
    string,
    DimensionCheckpoint
  >;
  const skippedDims: string[] = [];
  for (const [dimId, checkpoint] of completedCheckpoints) {
    if (!activeDimIds.includes(dimId)) {
      continue;
    }
    if (checkpoint.digest) {
      dimContext.addDimensionDigest(
        dimId,
        checkpoint.digest as Parameters<typeof dimContext.addDimensionDigest>[1]
      );
      sessionStore.addDimensionDigest(
        dimId,
        checkpoint.digest as Parameters<typeof sessionStore.addDimensionDigest>[1]
      );
    }
    emitter.emitDimensionComplete(dimId, {
      type: 'checkpoint-restored',
      ...checkpoint,
    });
    skippedDims.push(dimId);
    logger.info(`[Insight-v3] ⏩ 跳过已完成维度 (checkpoint): "${dimId}"`);
  }
  return { completedCheckpoints, skippedDims };
}

export function applyRestoredDimensionState({
  incrementalSkippedDims,
  checkpointSkippedDims,
  completedCheckpoints,
  sessionStore,
  dimensionStats,
  candidateResults,
  dimensionCandidates,
}: {
  incrementalSkippedDims: string[];
  checkpointSkippedDims: string[];
  completedCheckpoints: Map<string, DimensionCheckpoint>;
  sessionStore: SessionStore;
  dimensionStats: Record<string, DimensionStat>;
  candidateResults: CandidateResults;
  dimensionCandidates: Record<string, DimensionCandidateData>;
}) {
  for (const dimId of incrementalSkippedDims) {
    restoreIncrementalSkippedDimension({ dimId, sessionStore, dimensionStats });
  }
  for (const dimId of checkpointSkippedDims) {
    if (!incrementalSkippedDims.includes(dimId)) {
      restoreCheckpointDimension({
        dimId,
        completedCheckpoints,
        sessionStore,
        dimensionStats,
        candidateResults,
        dimensionCandidates,
      });
    }
  }
}

function restoreIncrementalSkippedDimension({
  dimId,
  sessionStore,
  dimensionStats,
}: {
  dimId: string;
  sessionStore: SessionStore;
  dimensionStats: Record<string, DimensionStat>;
}) {
  const report = sessionStore.getDimensionReport(dimId);
  const dimResult = {
    candidateCount: report?.candidatesSummary?.length || 0,
    rejectedCount: 0,
    analysisChars: report?.analysisText?.length || 0,
    referencedFiles: report?.referencedFiles?.length || 0,
    referencedFilesList: report?.referencedFiles || [],
    durationMs: 0,
    toolCallCount: 0,
    tokenUsage: { input: 0, output: 0 },
    skipped: true,
    restoredFromIncremental: true,
  };
  dimensionStats[dimId] = dimResult;
  logger.info(`[Insight-v3] ⏩ "${dimId}" — incremental skip (historical result)`);
}

function restoreCheckpointDimension({
  dimId,
  completedCheckpoints,
  sessionStore,
  dimensionStats,
  candidateResults,
  dimensionCandidates,
}: {
  dimId: string;
  completedCheckpoints: Map<string, DimensionCheckpoint>;
  sessionStore: SessionStore;
  dimensionStats: Record<string, DimensionStat>;
  candidateResults: CandidateResults;
  dimensionCandidates: Record<string, DimensionCandidateData>;
}) {
  const cp = completedCheckpoints.get(dimId);
  const cpResult = {
    candidateCount: cp?.candidateCount || 0,
    rejectedCount: cp?.rejectedCount || 0,
    analysisChars: cp?.analysisChars || 0,
    referencedFiles: cp?.referencedFiles || 0,
    durationMs: cp?.durationMs || 0,
    toolCallCount: cp?.toolCallCount || 0,
    tokenUsage: cp?.tokenUsage || { input: 0, output: 0 },
    skipped: true,
    restoredFromCheckpoint: true,
  };
  dimensionStats[dimId] = cpResult;
  candidateResults.created += cpResult.candidateCount;

  if (cp?.analysisText) {
    const restoredFiles = Array.isArray(cp.referencedFilesList) ? cp.referencedFilesList : [];
    dimensionCandidates[dimId] = {
      analysisReport: {
        analysisText: cp.analysisText,
        referencedFiles: restoredFiles,
        findings: [],
        metadata: {},
      },
      producerResult: { candidateCount: cp.candidateCount || 0, toolCalls: [] },
    };
    sessionStore.storeDimensionReport(dimId, {
      analysisText: cp.analysisText,
      findings: [],
      referencedFiles: restoredFiles,
      candidatesSummary: [],
    });
    logger.info(
      `[Insight-v3] ✅ Checkpoint "${dimId}": analysisText restored (${cp.analysisText.length} chars) — Skill generation enabled`
    );
  }
}
