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
}: Omit<
  ConsumeBootstrapReportSnapshotOptions,
  'allFiles' | 'sessionStore' | 'enableParallel' | 'concurrency' | 'startedAtMs'
> & {
  totalTimeMs: number;
  totalTokenUsage: { input: number; output: number };
  totalToolCalls: number;
}): Promise<BootstrapReport | null> {
  try {
    const report = buildBootstrapReport({
      sessionId,
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
  sessionId,
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
  sessionId?: string;
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
  const toolUsage = summarizeReportToolUsage(dimensionStats);
  const terminal = summarizeReportTerminalUsage(dimensionStats);
  const stageToolsets = summarizeReportStageToolsets(dimensionStats);
  const terminalToolset = inferTerminalToolset(stageToolsets);
  const report: BootstrapReport = {
    version: '2.7.0',
    timestamp: new Date().toISOString(),
    session: {
      id: sessionId || null,
      mode: isIncremental && incrementalPlan ? 'incremental' : 'full',
      startedAt: new Date(Date.now() - totalTimeMs).toISOString(),
      completedAt: new Date().toISOString(),
      terminalTest: terminalToolset !== 'baseline',
      terminalToolset,
    },
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
    stageToolsets,
    toolUsage,
    terminal,
    comparisonHints: {
      durationMs: totalTimeMs,
      candidates: candidateResults.created,
      toolCalls: totalToolCalls,
      terminalEnabled: terminal.enabled,
      terminalSuccessRate: terminal.successRate,
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
      stages: stat.stages || {},
    };
  }

  return report;
}

function summarizeReportStageToolsets(dimensionStats: Record<string, DimensionStat>) {
  const seen = new Set<string>();
  const result: Array<Record<string, unknown>> = [];
  for (const [dimensionId, stat] of Object.entries(dimensionStats)) {
    const diagnostics = stat.diagnostics as
      | { stageToolsets?: Array<Record<string, unknown>> }
      | null
      | undefined;
    for (const toolset of diagnostics?.stageToolsets || []) {
      const key = JSON.stringify([
        dimensionId,
        toolset.stage,
        toolset.source,
        toolset.allowedToolIds,
      ]);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ dimensionId, ...toolset });
    }
  }
  return result;
}

function summarizeReportToolUsage(dimensionStats: Record<string, DimensionStat>) {
  const byTool: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  let blocked = 0;
  let needsConfirmation = 0;
  let timeouts = 0;
  let durationTotal = 0;
  let durationCount = 0;

  for (const stat of Object.values(dimensionStats)) {
    const diagnostics = stat.diagnostics as
      | {
          toolCalls?: Array<{
            tool: string;
            status?: string;
            durationMs?: number;
            source?: string;
          }>;
        }
      | null
      | undefined;
    for (const call of diagnostics?.toolCalls || []) {
      byTool[call.tool] = (byTool[call.tool] || 0) + 1;
      const stage = call.source || 'unknown';
      byStage[stage] = (byStage[stage] || 0) + 1;
      if (call.status === 'blocked') {
        blocked++;
      }
      if (call.status === 'needs-confirmation') {
        needsConfirmation++;
      }
      if (call.status === 'timeout') {
        timeouts++;
      }
      if (typeof call.durationMs === 'number') {
        durationTotal += call.durationMs;
        durationCount++;
      }
    }
  }

  const total = Object.values(byTool).reduce((sum, count) => sum + count, 0);
  return {
    total,
    byTool,
    byStage,
    blocked,
    needsConfirmation,
    timeouts,
    avgDurationMs: durationCount > 0 ? Math.round(durationTotal / durationCount) : 0,
  };
}

function summarizeReportTerminalUsage(dimensionStats: Record<string, DimensionStat>) {
  const commands: Array<Record<string, unknown>> = [];
  let blocked = 0;
  let ptyRuns = 0;
  let success = 0;
  let total = 0;

  for (const [dimensionId, stat] of Object.entries(dimensionStats)) {
    const diagnostics = stat.diagnostics as
      | { toolCalls?: Array<{ tool: string; status?: string; ok?: boolean; durationMs?: number }> }
      | null
      | undefined;
    for (const call of diagnostics?.toolCalls || []) {
      if (!call.tool.startsWith('terminal_')) {
        continue;
      }
      total++;
      if (call.ok) {
        success++;
      }
      if (call.status === 'blocked' || call.status === 'needs-confirmation') {
        blocked++;
      }
      if (call.tool === 'terminal_pty') {
        ptyRuns++;
      }
      commands.push({
        dimensionId,
        tool: call.tool,
        status: call.status,
        ok: call.ok,
        durationMs: call.durationMs,
      });
    }
  }

  return {
    enabled: total > 0,
    commands,
    ptyRuns,
    blocked,
    transcriptRefs: [],
    successRate: total > 0 ? success / total : 0,
  };
}

function inferTerminalToolset(stageToolsets: Array<Record<string, unknown>>) {
  const tools = new Set(
    stageToolsets.flatMap((toolset) =>
      Array.isArray(toolset.allowedToolIds)
        ? toolset.allowedToolIds.filter((tool): tool is string => typeof tool === 'string')
        : []
    )
  );
  if (tools.has('terminal_pty')) {
    return 'terminal-pty';
  }
  if (tools.has('terminal_shell')) {
    return 'terminal-shell';
  }
  if (tools.has('terminal_run')) {
    return 'terminal-run';
  }
  return 'baseline';
}

function getReportSessionId(report: BootstrapReport) {
  const session = report.session as { id?: unknown } | undefined;
  return typeof session?.id === 'string' && session.id ? session.id : null;
}

function buildBootstrapReportSummary(report: BootstrapReport) {
  const terminal = report.terminal as { enabled?: boolean; successRate?: number } | undefined;
  const totals = report.totals || {};
  const duration = report.duration || {};
  const session = report.session as Record<string, unknown> | undefined;
  return {
    sessionId: getReportSessionId(report),
    timestamp: report.timestamp,
    project: report.project,
    mode: session?.mode || null,
    terminalToolset: session?.terminalToolset || 'baseline',
    durationMs: duration.totalMs || 0,
    candidates: totals.candidates || 0,
    toolCalls: totals.toolCalls || 0,
    terminalEnabled: terminal?.enabled === true,
    terminalSuccessRate: terminal?.successRate || 0,
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
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
    await writeBootstrapReportHistoryWithWriteZone(wz, report);
    return;
  }
  const reportDir = path.join(dataRoot, '.asd');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(
    path.join(reportDir, 'bootstrap-report.json'),
    JSON.stringify(report, null, 2)
  );
  await writeBootstrapReportHistory(reportDir, report);
}

async function writeBootstrapReportHistoryWithWriteZone(
  wz: import('#infra/io/WriteZone.js').WriteZone,
  report: BootstrapReport
) {
  const sessionId = getReportSessionId(report);
  if (!sessionId) {
    return;
  }
  await wz.writeFileAsync(
    wz.runtime(path.join('bootstrap-reports', `${sessionId}.json`)),
    JSON.stringify(report, null, 2)
  );
  const indexPath = wz.runtime(path.join('bootstrap-reports', 'index.json'));
  const existing = await readJsonFile<{ reports?: Array<Record<string, unknown>> }>(
    indexPath.absolute
  );
  const reports = sanitizeReportSummaries(existing?.reports || []).filter(
    (entry) => entry.sessionId !== sessionId
  );
  reports.unshift(buildBootstrapReportSummary(report));
  await wz.writeFileAsync(
    indexPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), reports: reports.slice(0, 100) }, null, 2)
  );
}

async function writeBootstrapReportHistory(reportDir: string, report: BootstrapReport) {
  const sessionId = getReportSessionId(report);
  if (!sessionId) {
    return;
  }
  const historyDir = path.join(reportDir, 'bootstrap-reports');
  await fs.mkdir(historyDir, { recursive: true });
  await fs.writeFile(path.join(historyDir, `${sessionId}.json`), JSON.stringify(report, null, 2));

  const indexPath = path.join(historyDir, 'index.json');
  const existing = await readJsonFile<{ reports?: Array<Record<string, unknown>> }>(indexPath);
  const reports = sanitizeReportSummaries(existing?.reports || []).filter(
    (entry) => entry.sessionId !== sessionId
  );
  reports.unshift(buildBootstrapReportSummary(report));
  await fs.writeFile(
    indexPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), reports: reports.slice(0, 100) }, null, 2)
  );
}

function sanitizeReportSummaries(reports: Array<Record<string, unknown>>) {
  return reports.filter(
    (entry) => typeof entry.sessionId === 'string' && entry.sessionId.trim().length > 0
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
