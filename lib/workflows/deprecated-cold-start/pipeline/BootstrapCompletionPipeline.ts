import type { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import type { BootstrapFileEntry } from '#workflows/deprecated-cold-start/agent-runs/BootstrapDimensionInputBuilder.js';
import { consumeBootstrapCandidateRelations } from '#workflows/deprecated-cold-start/consumers/BootstrapCandidateRelationConsumer.js';
import {
  type ConsolidationResult,
  consumeBootstrapSemanticMemory,
} from '#workflows/deprecated-cold-start/consumers/BootstrapSemanticMemoryConsumer.js';
import {
  consumeBootstrapSkills,
  type SkillResults,
} from '#workflows/deprecated-cold-start/consumers/BootstrapSkillConsumer.js';
import { consumeBootstrapDeliveryAndWiki } from '#workflows/deprecated-cold-start/delivery/BootstrapDeliveryConsumer.js';
import { consumeBootstrapReportAndSnapshot } from '#workflows/deprecated-cold-start/reports/BootstrapReportSnapshotConsumer.js';
import type { BootstrapWorkflowContext } from '../BootstrapWorkflow.js';
import type { initializeBootstrapRuntime } from '../context/BootstrapRuntimeInitializer.js';
import type { BootstrapDimensionSessionPipelineResult } from './BootstrapDimensionSessionPipeline.js';

type BootstrapRuntime = Awaited<ReturnType<typeof initializeBootstrapRuntime>>;

interface BootstrapTaskManagerLike {
  isSessionValid(sessionId: string): boolean;
}

export interface CompleteBootstrapPipelineOptions {
  ctx: BootstrapWorkflowContext;
  projectRoot: string;
  dataRoot: string;
  dimensions: DimensionDef[];
  runtime: BootstrapRuntime;
  dimensionSession: BootstrapDimensionSessionPipelineResult;
  emitter: BootstrapEventEmitter;
  sessionId: string;
  taskManager: BootstrapTaskManagerLike | null;
  allFiles: BootstrapFileEntry[] | null;
  isIncremental: boolean | null | undefined;
  incrementalPlan: Parameters<typeof consumeBootstrapReportAndSnapshot>[0]['incrementalPlan'];
}

export interface BootstrapCompletionSummary extends Record<string, unknown> {
  dimensions: number;
  files: number;
  activeDimensions: number;
  skippedDimensions: number;
  incrementalSkippedDimensions: number;
  candidatesCreated: number;
  candidatesFailed: number;
  skillsCreated: number;
  skillsFailed: number;
  semanticMemory: unknown | null;
  snapshotId: string | null;
  totalToolCalls: number;
  totalTokenUsage: { input: number; output: number };
  coverage: BootstrapCompletionCoverageSummary;
  totalTimeMs: number;
  incremental: boolean;
}

export interface BootstrapCompletionCoverageSummary extends Record<string, unknown> {
  dimensionsTotal: number;
  dimensionsActive: number;
  dimensionsSkipped: number;
  dimensionsIncrementalSkipped: number;
  dimensionsWithCandidates: number;
  dimensionsWithAnalysis: number;
  filesTotal: number;
  referencedFiles: number;
  referencedFileMentions: number;
}

export interface CompleteBootstrapPipelineResult {
  skillResults: SkillResults;
  consolidationResult: ConsolidationResult | null;
  totalTimeMs: number;
  summary: BootstrapCompletionSummary;
}

export async function completeBootstrapPipeline({
  ctx,
  projectRoot,
  dataRoot,
  dimensions,
  runtime,
  dimensionSession,
  emitter,
  sessionId,
  taskManager,
  allFiles,
  isIncremental,
  incrementalPlan,
}: CompleteBootstrapPipelineOptions): Promise<CompleteBootstrapPipelineResult> {
  const skillResults = await consumeBootstrapSkills({
    ctx,
    dimensions,
    dimensionCandidates: dimensionSession.dimensionCandidates,
    sessionStore: runtime.sessionStore,
    emitter,
    shouldAbort: () => !!(taskManager && !taskManager.isSessionValid(sessionId)),
  });

  await consumeBootstrapCandidateRelations({
    ctx,
    projectRoot,
    dimensionCandidates: dimensionSession.dimensionCandidates,
  });

  const consolidationResult = consumeBootstrapSemanticMemory({
    ctx,
    dataRoot,
    sessionId,
    sessionStore: runtime.sessionStore,
  });

  const reportSnapshot = await consumeBootstrapReportAndSnapshot({
    ctx,
    dataRoot,
    projectRoot,
    projectInfo: runtime.projectInfo,
    sessionId,
    allFiles,
    sessionStore: runtime.sessionStore,
    dimensionStats: dimensionSession.dimensionStats,
    candidateResults: dimensionSession.candidateResults,
    skillResults,
    consolidationResult,
    skippedDims: dimensionSession.skippedDims,
    incrementalSkippedDims: dimensionSession.incrementalSkippedDims,
    isIncremental,
    incrementalPlan,
    enableParallel: dimensionSession.enableParallel,
    concurrency: dimensionSession.concurrency,
    startedAtMs: dimensionSession.startedAtMs,
  });
  const { totalTimeMs, snapshotId, totalToolCalls, totalTokenUsage } = reportSnapshot;

  ctx.container.singletons._fileCache = null;
  await consumeBootstrapDeliveryAndWiki({
    projectRoot,
    dataRoot,
    projectGraph: runtime.projectGraph,
  });

  const summary: BootstrapCompletionSummary = {
    dimensions: dimensions.length,
    files: allFiles?.length ?? 0,
    activeDimensions: dimensionSession.activeDimIds.length,
    skippedDimensions: dimensionSession.skippedDims.length,
    incrementalSkippedDimensions: dimensionSession.incrementalSkippedDims.length,
    candidatesCreated: dimensionSession.candidateResults.created,
    candidatesFailed: dimensionSession.candidateResults.failed,
    skillsCreated: skillResults.created,
    skillsFailed: skillResults.failed,
    semanticMemory: consolidationResult?.total ?? null,
    snapshotId,
    totalToolCalls,
    totalTokenUsage,
    coverage: summarizeBootstrapBaselineCoverage({
      dimensionsTotal: dimensions.length,
      dimensionsActive: dimensionSession.activeDimIds.length,
      dimensionsSkipped: dimensionSession.skippedDims.length,
      dimensionsIncrementalSkipped: dimensionSession.incrementalSkippedDims.length,
      filesTotal: allFiles?.length ?? 0,
      dimensionStats: dimensionSession.dimensionStats,
    }),
    totalTimeMs,
    incremental: Boolean(isIncremental),
  };

  return { skillResults, consolidationResult, totalTimeMs, summary };
}

function summarizeBootstrapBaselineCoverage({
  dimensionsTotal,
  dimensionsActive,
  dimensionsSkipped,
  dimensionsIncrementalSkipped,
  filesTotal,
  dimensionStats,
}: {
  dimensionsTotal: number;
  dimensionsActive: number;
  dimensionsSkipped: number;
  dimensionsIncrementalSkipped: number;
  filesTotal: number;
  dimensionStats: BootstrapDimensionSessionPipelineResult['dimensionStats'];
}): BootstrapCompletionCoverageSummary {
  const referencedFiles = new Set<string>();
  let referencedFileMentions = 0;
  let dimensionsWithCandidates = 0;
  let dimensionsWithAnalysis = 0;

  for (const stat of Object.values(dimensionStats)) {
    if ((stat.candidateCount ?? 0) > 0) {
      dimensionsWithCandidates += 1;
    }
    if ((stat.analysisChars ?? 0) > 0) {
      dimensionsWithAnalysis += 1;
    }
    referencedFileMentions += stat.referencedFiles ?? 0;
    for (const filePath of stat.referencedFilesList ?? []) {
      referencedFiles.add(filePath);
    }
  }

  return {
    dimensionsTotal,
    dimensionsActive,
    dimensionsSkipped,
    dimensionsIncrementalSkipped,
    dimensionsWithCandidates,
    dimensionsWithAnalysis,
    filesTotal,
    referencedFiles: referencedFiles.size,
    referencedFileMentions,
  };
}
