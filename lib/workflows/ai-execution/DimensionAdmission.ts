import type { SessionStore } from '@alembic/agent/memory';
import Logger from '@alembic/core/logging';
import type { IncrementalPlan } from '@alembic/core/types';
import type { GenerateEventEmitter } from '#service/generate/GenerateEventEmitter.js';
import type { DimensionContext } from './DimensionContext.js';
import {
  applyRestoredDimensionState,
  type DimensionCheckpoint,
  resolveIncrementalSkippedDimensions,
  restoreCheckpointDimensions,
} from './DimensionRestoreState.js';
import type {
  CandidateResults,
  DimensionCandidateData,
  DimensionStat,
} from './GenerateConsumers.js';
import type { GenerateRescanContext } from './RescanContext.js';

const logger = Logger.getInstance();

export type GenerateDimensionAdmissionStatus =
  | 'run'
  | 'incremental-restored'
  | 'checkpoint-restored';

export interface GenerateDimensionAdmissionDecision {
  dimId: string;
  status: GenerateDimensionAdmissionStatus;
  reason: string;
  forcedByRescan?: boolean;
}

export interface GenerateDimensionAdmissionResult {
  decisions: Record<string, GenerateDimensionAdmissionDecision>;
  skippedDimIds: string[];
  incrementalSkippedDims: string[];
  checkpointSkippedDims: string[];
  rescanForceExecuteDimIds: string[];
  completedCheckpoints: Map<string, DimensionCheckpoint>;
}

export async function resolveGenerateDimensionAdmissions({
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
  rescanContext: GenerateRescanContext | null;
  dimContext: DimensionContext;
  sessionStore: SessionStore;
  emitter: GenerateEventEmitter;
}): Promise<GenerateDimensionAdmissionResult> {
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

  const decisions = buildGenerateDimensionAdmissionDecisions({
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

export function buildGenerateDimensionAdmissionDecisions({
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
  const decisions: Record<string, GenerateDimensionAdmissionDecision> = {};
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

export function applyGenerateDimensionAdmissions({
  admissions,
  sessionStore,
  dimensionStats,
  candidateResults,
  dimensionCandidates,
}: {
  admissions: Pick<
    GenerateDimensionAdmissionResult,
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
