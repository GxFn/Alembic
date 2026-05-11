import type { SessionStore } from '#agent/memory/SessionStore.js';
import Logger from '#infra/logging/Logger.js';
import type { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import type { IncrementalPlan } from '#types/workflows.js';
import type {
  CandidateResults,
  DimensionCandidateData,
  DimensionStat,
} from '#workflows/capabilities/execution/internal-agent/BootstrapConsumers.js';
import type { BootstrapRescanContext } from '#workflows/capabilities/execution/internal-agent/BootstrapRescanState.js';
import type { DimensionContext } from '#workflows/capabilities/execution/internal-agent/DimensionContext.js';
import {
  applyRestoredDimensionState,
  type DimensionCheckpoint,
  resolveIncrementalSkippedDimensions,
  restoreCheckpointDimensions,
} from '#workflows/capabilities/persistence/DimensionCheckpoint.js';

const logger = Logger.getInstance();

export type BootstrapDimensionAdmissionStatus =
  | 'run'
  | 'incremental-restored'
  | 'checkpoint-restored';

export interface BootstrapDimensionAdmissionDecision {
  dimId: string;
  status: BootstrapDimensionAdmissionStatus;
  reason: string;
  forcedByRescan?: boolean;
}

export interface BootstrapDimensionAdmissionResult {
  decisions: Record<string, BootstrapDimensionAdmissionDecision>;
  skippedDimIds: string[];
  incrementalSkippedDims: string[];
  checkpointSkippedDims: string[];
  rescanForceExecuteDimIds: string[];
  completedCheckpoints: Map<string, DimensionCheckpoint>;
}

export async function resolveBootstrapDimensionAdmissions({
  dataRoot,
  activeDimIds,
  isIncremental,
  incrementalPlan,
  rescanContext,
  dimContext,
  sessionStore,
  emitter,
}: {
  dataRoot: string;
  activeDimIds: string[];
  isIncremental?: boolean | null;
  incrementalPlan?: IncrementalPlan | null;
  rescanContext: BootstrapRescanContext | null;
  dimContext: DimensionContext;
  sessionStore: SessionStore;
  emitter: BootstrapEventEmitter;
}): Promise<BootstrapDimensionAdmissionResult> {
  const rescanForceExecuteDimIds = activeDimIds.filter(
    (dimId) => rescanContext?.executionDecisions?.[dimId]?.shouldExecute === true
  );
  const incrementalSkippedDims = resolveIncrementalSkippedDimensions({
    isIncremental,
    incrementalPlan,
    activeDimIds,
    forceExecuteDimIds: rescanForceExecuteDimIds,
    emitter,
  });

  const checkpointRestoreDimIds = rescanContext ? [] : activeDimIds;
  if (rescanContext && activeDimIds.length > 0) {
    logger.info(
      `[Insight-v3] Rescan mode: checkpoint restore disabled for active dimensions [${activeDimIds.join(', ')}]`
    );
  }
  const { completedCheckpoints, skippedDims: checkpointSkippedDims } =
    await restoreCheckpointDimensions({
      dataRoot,
      activeDimIds: checkpointRestoreDimIds,
      dimContext,
      sessionStore,
      emitter,
    });

  const decisions = buildBootstrapDimensionAdmissionDecisions({
    activeDimIds,
    incrementalSkippedDims,
    checkpointSkippedDims,
    rescanForceExecuteDimIds,
  });

  return {
    decisions,
    skippedDimIds: Object.values(decisions)
      .filter((decision) => decision.status !== 'run')
      .map((decision) => decision.dimId),
    incrementalSkippedDims,
    checkpointSkippedDims,
    rescanForceExecuteDimIds,
    completedCheckpoints,
  };
}

export function buildBootstrapDimensionAdmissionDecisions({
  activeDimIds,
  incrementalSkippedDims,
  checkpointSkippedDims,
  rescanForceExecuteDimIds = [],
}: {
  activeDimIds: string[];
  incrementalSkippedDims: string[];
  checkpointSkippedDims: string[];
  rescanForceExecuteDimIds?: string[];
}) {
  const incremental = new Set(incrementalSkippedDims);
  const checkpoint = new Set(checkpointSkippedDims);
  const forced = new Set(rescanForceExecuteDimIds);
  const decisions: Record<string, BootstrapDimensionAdmissionDecision> = {};
  for (const dimId of activeDimIds) {
    if (incremental.has(dimId)) {
      decisions[dimId] = {
        dimId,
        status: 'incremental-restored',
        reason: 'no-change-detected',
      };
      continue;
    }
    if (checkpoint.has(dimId)) {
      decisions[dimId] = {
        dimId,
        status: 'checkpoint-restored',
        reason: 'dimension checkpoint is still valid',
      };
      continue;
    }
    decisions[dimId] = {
      dimId,
      status: 'run',
      reason: forced.has(dimId) ? 'rescan execution decision requires run' : 'admitted',
      ...(forced.has(dimId) ? { forcedByRescan: true } : {}),
    };
  }
  return decisions;
}

export function applyBootstrapDimensionAdmissions({
  admissions,
  sessionStore,
  dimensionStats,
  candidateResults,
  dimensionCandidates,
}: {
  admissions: Pick<
    BootstrapDimensionAdmissionResult,
    'incrementalSkippedDims' | 'checkpointSkippedDims' | 'completedCheckpoints'
  >;
  sessionStore: SessionStore;
  dimensionStats: Record<string, DimensionStat>;
  candidateResults: CandidateResults;
  dimensionCandidates: Record<string, DimensionCandidateData>;
}) {
  applyRestoredDimensionState({
    incrementalSkippedDims: admissions.incrementalSkippedDims,
    checkpointSkippedDims: admissions.checkpointSkippedDims,
    completedCheckpoints: admissions.completedCheckpoints,
    sessionStore,
    dimensionStats,
    candidateResults,
    dimensionCandidates,
  });
}
