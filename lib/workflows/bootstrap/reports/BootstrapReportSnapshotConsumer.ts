import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionStore } from '#agent/memory/SessionStore.js';
import type { BootstrapFile, IncrementalPlan } from '#external/mcp/handlers/types.js';
import Logger from '#infra/logging/Logger.js';
import { clearCheckpoints } from '#workflows/bootstrap/checkpoint/BootstrapCheckpointStore.js';
import type {
  CandidateResults,
  DimensionStat,
} from '#workflows/bootstrap/consumers/BootstrapDimensionConsumer.js';
import type { ConsolidationResult } from '#workflows/bootstrap/consumers/BootstrapSemanticMemoryConsumer.js';
import type { SkillResults } from '#workflows/bootstrap/consumers/BootstrapSkillConsumer.js';
import { IncrementalBootstrap } from '#workflows/bootstrap/incremental/IncrementalBootstrap.js';

const logger = Logger.getInstance();

export interface BootstrapReport {
  version: string;
  timestamp: string;
  project: { name: string; files: number; lang: string };
  duration: { totalMs: number; totalSec: number };
  dimensions: Record<string, Record<string, unknown>>;
  totals: Record<string, unknown>;
  checkpoints: { restored: string[] };
  incremental: Record<string, unknown> | null;
  semanticMemory: Record<string, unknown> | null;
  codeEntityGraph?: Record<string, unknown>;
  [key: string]: unknown;
}

interface BootstrapReportSnapshotContext {
  container: {
    get(name: string): unknown;
    singletons?: Record<string, unknown>;
  };
}

export interface ConsumeBootstrapReportSnapshotOptions {
  ctx: BootstrapReportSnapshotContext;
  dataRoot: string;
  projectRoot: string;
  projectInfo: { name: string; fileCount: number; lang: string };
  sessionId: string;
  allFiles: BootstrapFile[] | null;
  sessionStore: SessionStore;
  dimensionStats: Record<string, DimensionStat>;
  candidateResults: CandidateResults;
  skillResults: SkillResults;
  consolidationResult: ConsolidationResult | null;
  skippedDims: string[];
  incrementalSkippedDims: string[];
  isIncremental?: boolean | null;
  incrementalPlan?: IncrementalPlan | null;
  enableParallel: boolean;
  concurrency: number;
  startedAtMs: number;
  createIncrementalBootstrap?: (
    db: unknown,
    projectRoot: string
  ) => Pick<IncrementalBootstrap, 'saveSnapshot'>;
}

export interface BootstrapReportSnapshotResult {
  totalTimeMs: number;
  totalTokenUsage: { input: number; output: number };
  totalToolCalls: number;
  report: BootstrapReport | null;
  snapshotId: string | null;
}

export async function consumeBootstrapReportAndSnapshot({
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
  createIncrementalBootstrap = (db, root) => new IncrementalBootstrap(db, root, { logger }),
}: ConsumeBootstrapReportSnapshotOptions): Promise<BootstrapReportSnapshotResult> {
  const totalTimeMs = Date.now() - startedAtMs;
  const { totalTokenUsage, totalToolCalls } = summarizeBootstrapDimensionStats(dimensionStats);
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

  const report = await writeBootstrapReport({
    ctx,
    dataRoot,
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

  await clearCheckpoints(dataRoot);

  const snapshotId = saveBootstrapSnapshot({
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
    createIncrementalBootstrap,
  });

  return { totalTimeMs, totalTokenUsage, totalToolCalls, report, snapshotId };
}

export function summarizeBootstrapDimensionStats(dimensionStats: Record<string, DimensionStat>) {
  const totalTokenUsage = { input: 0, output: 0 };
  const totalToolCalls = Object.values(dimensionStats).reduce(
    (sum, s) => sum + (s.toolCallCount || 0),
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
  candidateResults: CandidateResults;
  skillResults: SkillResults;
  consolidationResult: ConsolidationResult | null;
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

export async function writeBootstrapReport({
  ctx,
  dataRoot,
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
}: Omit<
  ConsumeBootstrapReportSnapshotOptions,
  'sessionId' | 'allFiles' | 'sessionStore' | 'enableParallel' | 'concurrency' | 'startedAtMs'
> & {
  totalTimeMs: number;
  totalTokenUsage: { input: number; output: number };
  totalToolCalls: number;
}): Promise<BootstrapReport | null> {
  try {
    const report = buildBootstrapReport({
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
    await attachCodeEntityGraphTopology({ ctx, projectRoot, report });
    await writeBootstrapReportFile({ ctx, dataRoot, report });
    logger.info(`[Insight-v3] 📊 Bootstrap report saved to .asd/bootstrap-report.json`);
    return report;
  } catch (reportErr: unknown) {
    logger.warn(
      `[Insight-v3] Bootstrap report generation failed: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`
    );
    return null;
  }
}

export function buildBootstrapReport({
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
}: {
  projectInfo: { name: string; fileCount: number; lang: string };
  dimensionStats: Record<string, DimensionStat>;
  candidateResults: CandidateResults;
  skillResults: SkillResults;
  consolidationResult: ConsolidationResult | null;
  skippedDims: string[];
  incrementalSkippedDims: string[];
  isIncremental?: boolean | null;
  incrementalPlan?: IncrementalPlan | null;
  totalTimeMs: number;
  totalTokenUsage: { input: number; output: number };
  totalToolCalls: number;
}): BootstrapReport {
  const report: BootstrapReport = {
    version: '2.7.0',
    timestamp: new Date().toISOString(),
    project: {
      name: projectInfo.name,
      files: projectInfo.fileCount,
      lang: projectInfo.lang,
    },
    duration: {
      totalMs: totalTimeMs,
      totalSec: Math.round(totalTimeMs / 1000),
    },
    dimensions: {},
    totals: {
      candidates: candidateResults.created,
      skills: skillResults.created,
      toolCalls: totalToolCalls,
      tokenUsage: totalTokenUsage,
      errors: candidateResults.errors.length,
    },
    checkpoints: {
      restored: skippedDims,
    },
    incremental:
      isIncremental && incrementalPlan
        ? {
            mode: 'incremental',
            affectedDimensions: incrementalPlan.affectedDimensions,
            skippedDimensions: incrementalSkippedDims,
            diff: incrementalPlan.diff
              ? {
                  added: incrementalPlan.diff.added.length,
                  modified: incrementalPlan.diff.modified.length,
                  deleted: incrementalPlan.diff.deleted.length,
                  unchanged: incrementalPlan.diff.unchanged.length,
                }
              : null,
            reason: incrementalPlan.reason,
          }
        : null,
    semanticMemory: consolidationResult
      ? {
          added: consolidationResult.total.added,
          updated: consolidationResult.total.updated,
          merged: consolidationResult.total.merged,
          skipped: consolidationResult.total.skipped,
          durationMs: consolidationResult.durationMs,
        }
      : null,
  };

  for (const [dimId, stat] of Object.entries(dimensionStats)) {
    report.dimensions[dimId] = {
      candidatesSubmitted: stat.candidateCount || 0,
      candidatesRejected: stat.rejectedCount || 0,
      analysisChars: stat.analysisChars || 0,
      referencedFiles: stat.referencedFiles || 0,
      durationMs: stat.durationMs || 0,
      toolCallCount: stat.toolCallCount || 0,
      tokenUsage: stat.tokenUsage || { input: 0, output: 0 },
      qualityGate: stat.qualityGate || null,
    };
  }

  return report;
}

async function attachCodeEntityGraphTopology({
  ctx,
  projectRoot,
  report,
}: {
  ctx: BootstrapReportSnapshotContext;
  projectRoot: string;
  report: BootstrapReport;
}) {
  try {
    const { CodeEntityGraph } = await import('#service/knowledge/CodeEntityGraph.js');
    const entityRepo = ctx.container.get('codeEntityRepository');
    const edgeRepo = ctx.container.get('knowledgeEdgeRepository');
    if (entityRepo && edgeRepo) {
      const ceg = new CodeEntityGraph(
        entityRepo as ConstructorParameters<typeof CodeEntityGraph>[0],
        edgeRepo as ConstructorParameters<typeof CodeEntityGraph>[1],
        { projectRoot, logger }
      );
      const topo = await ceg.getTopology();
      report.codeEntityGraph = {
        entities: topo.entities,
        edges: topo.edges,
        totalEntities: topo.totalEntities,
        totalEdges: topo.totalEdges,
        hotNodes: topo.hotNodes?.slice(0, 5),
      };
    }
  } catch {
    /* non-blocking */
  }
}

async function writeBootstrapReportFile({
  ctx,
  dataRoot,
  report,
}: {
  ctx: BootstrapReportSnapshotContext;
  dataRoot: string;
  report: BootstrapReport;
}) {
  const wz = ctx.container.singletons?.writeZone as
    | import('#infra/io/WriteZone.js').WriteZone
    | undefined;
  if (wz) {
    await wz.writeFileAsync(wz.runtime('bootstrap-report.json'), JSON.stringify(report, null, 2));
    return;
  }
  const reportDir = path.join(dataRoot, '.asd');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(
    path.join(reportDir, 'bootstrap-report.json'),
    JSON.stringify(report, null, 2)
  );
}

function saveBootstrapSnapshot({
  ctx,
  projectRoot,
  sessionId,
  allFiles,
  dimensionStats,
  sessionStore,
  totalTimeMs,
  candidateResults,
  primaryLang,
  isIncremental,
  incrementalPlan,
  createIncrementalBootstrap,
}: {
  ctx: BootstrapReportSnapshotContext;
  projectRoot: string;
  sessionId: string;
  allFiles: BootstrapFile[] | null;
  dimensionStats: Record<string, DimensionStat>;
  sessionStore: SessionStore;
  totalTimeMs: number;
  candidateResults: CandidateResults;
  primaryLang: string;
  isIncremental?: boolean | null;
  incrementalPlan?: IncrementalPlan | null;
  createIncrementalBootstrap: (
    db: unknown,
    projectRoot: string
  ) => Pick<IncrementalBootstrap, 'saveSnapshot'>;
}) {
  try {
    const db = ctx.container.get('database');
    if (db && allFiles) {
      const ib = createIncrementalBootstrap(db, projectRoot);
      const snapshotId = ib.saveSnapshot({
        sessionId,
        allFiles,
        dimensionStats,
        episodicMemory: sessionStore as unknown as Parameters<
          IncrementalBootstrap['saveSnapshot']
        >[0]['episodicMemory'],
        meta: {
          durationMs: totalTimeMs,
          candidateCount: candidateResults.created,
          primaryLang,
        },
        plan: isIncremental ? incrementalPlan || null : null,
      });
      logger.info(`[Insight-v3] 📸 Snapshot saved: ${snapshotId}`);
      return snapshotId;
    }
  } catch (snapErr: unknown) {
    logger.warn(
      `[Insight-v3] Snapshot save failed (non-blocking): ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`
    );
  }
  return null;
}
