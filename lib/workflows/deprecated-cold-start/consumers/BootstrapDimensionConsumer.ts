import type { MemoryCoordinator } from '#agent/memory/MemoryCoordinator.js';
import type { SessionStore } from '#agent/memory/SessionStore.js';
import Logger from '#infra/logging/Logger.js';
import type { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import { saveDimensionCheckpoint } from '#workflows/deprecated-cold-start/checkpoint/BootstrapCheckpointStore.js';
import {
  type DimensionContext,
  parseDimensionDigest,
} from '#workflows/deprecated-cold-start/context/DimensionContext.js';
import {
  type AgentResultLike,
  type BootstrapDimensionAnalysisReport,
  type BootstrapDimensionProducerResult,
  type BootstrapDimensionProjection,
  type DimensionFinding,
  normalizeDimensionFindings,
  type ToolCallRecord,
} from '#workflows/deprecated-cold-start/projections/BootstrapDimensionProjection.js';

const logger = Logger.getInstance();

export interface DimensionStat {
  candidateCount: number;
  rejectedCount?: number;
  analysisChars?: number;
  referencedFiles?: number;
  referencedFilesList?: string[];
  durationMs: number;
  toolCallCount?: number;
  tokenUsage?: { input: number; output: number };
  skipped?: boolean;
  restoredFromCheckpoint?: boolean;
  restoredFromIncremental?: boolean;
  analysisText?: string;
  error?: string;
  [key: string]: unknown;
}

export interface CandidateResults {
  created: number;
  failed: number;
  errors: Array<{ dimId: string; error: string }>;
}

export interface DimensionCandidateData {
  analysisReport: BootstrapDimensionAnalysisReport;
  producerResult: BootstrapDimensionProducerResult;
}

interface BootstrapDimensionConsumerContext {
  container?: {
    get?: (key: string) => any;
    singletons?: {
      aiProvider?: { name?: string; model?: string } | null;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ConsumeBootstrapDimensionResultOptions {
  ctx: BootstrapDimensionConsumerContext;
  dimId: string;
  dimConfig: { label?: string };
  needsCandidates: boolean;
  projection: BootstrapDimensionProjection;
  runResult: AgentResultLike;
  dimStartTime: number;
  analystScopeId: string;
  memoryCoordinator: MemoryCoordinator;
  sessionStore: SessionStore;
  dimContext: DimensionContext;
  candidateResults: CandidateResults;
  dimensionCandidates: Record<string, DimensionCandidateData>;
  dimensionStats: Record<string, DimensionStat>;
  emitter: BootstrapEventEmitter;
  dataRoot: string;
  sessionId: string;
}

export async function consumeBootstrapDimensionResult({
  ctx,
  dimId,
  dimConfig,
  needsCandidates,
  projection,
  runResult,
  dimStartTime,
  analystScopeId,
  memoryCoordinator,
  sessionStore,
  dimContext,
  candidateResults,
  dimensionCandidates,
  dimensionStats,
  emitter,
  dataRoot,
  sessionId,
}: ConsumeBootstrapDimensionResultOptions): Promise<DimensionStat> {
  const {
    gateResult,
    produceResult,
    analysisText,
    artifact,
    runtimeToolCalls,
    combinedTokenUsage,
    analysisReport,
    producerResult,
    submitCalls,
    successCount,
    rejectedCount,
  } = projection;

  candidateResults.created += producerResult.candidateCount;
  dimensionCandidates[dimId] = { analysisReport, producerResult };

  if (needsCandidates) {
    const producerToolCalls = produceResult?.toolCalls || [];
    const producerToolNames = producerToolCalls.map(
      (tc: ToolCallRecord) => tc?.tool || tc?.name || 'unknown'
    );
    const toolBreakdown: Record<string, number> = {};
    for (const name of producerToolNames) {
      toolBreakdown[name] = (toolBreakdown[name] || 0) + 1;
    }
    const breakdownStr = Object.entries(toolBreakdown)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    logger.info(
      `[Producer] "${dimId}": submitted=${submitCalls.length}, accepted=${successCount}, rejected=${rejectedCount}, ` +
        `producerToolCalls=${producerToolCalls.length} (${breakdownStr || 'none'}), ` +
        `analysisInput=${analysisText.length} chars`
    );

    if (successCount === 0 && submitCalls.length === 0) {
      logger.warn(
        `[Producer] "${dimId}": ⚠ Producer 未提交任何候选。` +
          `分析文本=${analysisText.length} chars, findings=${(analysisReport.findings || []).length}, ` +
          `producerIterations=${producerToolCalls.length}, degraded=${runResult?.degraded || false}`
      );
    }
  }

  const ac = memoryCoordinator.getActiveContext(analystScopeId);
  const distilled = ac
    ? ac.distill()
    : { keyFindings: [], totalObservations: 0, toolCallSummary: [] };
  sessionStore.storeDimensionReport(dimId, {
    analysisText: analysisReport.analysisText,
    findings:
      analysisReport.findings.length > 0
        ? normalizeDimensionFindings(analysisReport.findings)
        : distilled.keyFindings,
    referencedFiles: analysisReport.referencedFiles || [],
    candidatesSummary: [],
    workingMemoryDistilled: distilled,
  });

  logger.info(
    `[Insight-v3] Dimension "${dimId}": analysis=${analysisReport.analysisText.length} chars, ` +
      `files=${analysisReport.referencedFiles.length}, findings=${(analysisReport.findings || distilled.keyFindings).length}, ` +
      `toolCalls=${runtimeToolCalls.length}, degraded=${runResult?.degraded || false} (${Date.now() - dimStartTime}ms)`
  );

  try {
    const tokenStore = ctx.container?.get?.('tokenUsageStore');
    if (tokenStore) {
      const aiProv = ctx.container?.singletons?.aiProvider as
        | { name?: string; model?: string }
        | undefined;
      tokenStore.record({
        source: 'system',
        dimension: dimId,
        provider: aiProv?.name || null,
        model: aiProv?.model || null,
        inputTokens: combinedTokenUsage.input || 0,
        outputTokens: combinedTokenUsage.output || 0,
        durationMs: Date.now() - dimStartTime,
        toolCalls: runtimeToolCalls.length,
        sessionId: sessionId || null,
      });
      try {
        const realtime = ctx.container?.get?.('realtimeService');
        realtime?.broadcastTokenUsageUpdated?.();
      } catch {
        /* optional */
      }
    }
  } catch {
    /* token logging should never break execution */
  }

  if (needsCandidates && analysisReport.analysisText.length < 100) {
    const findings = analysisReport.findings || [];
    if (findings.length >= 3) {
      const dimLabel = dimConfig.label || dimId;
      const synthesized = [
        `## ${dimLabel}`,
        '',
        analysisReport.analysisText.trim(),
        '',
        '### 关键发现',
        '',
        ...findings.slice(0, 10).map((f: DimensionFinding | string, i: number) => {
          const text = typeof f === 'string' ? f : f.finding;
          return `${i + 1}. ${text}`;
        }),
      ];
      const memDistilled = distilled;
      if (memDistilled?.toolCallSummary?.length > 0) {
        synthesized.push('', '### 探索记录', '');
        for (const s of memDistilled.toolCallSummary.slice(0, 10)) {
          synthesized.push(`- ${s}`);
        }
      }
      const originalLen = analysisReport.analysisText.length;
      analysisReport.analysisText = synthesized.join('\n');
      logger.info(
        `[Insight-v3] analysisText 补强 "${dimId}": ${originalLen} → ${analysisReport.analysisText.length} chars ` +
          `(from ${findings.length} findings)`
      );
    }
  }

  const digest = parseDimensionDigest(producerResult.reply) || {
    summary: `v3 分析: ${analysisReport.analysisText.substring(0, 200)}...`,
    candidateCount: producerResult.candidateCount,
    keyFindings: [] as string[],
    crossRefs: {},
    gaps: [] as string[],
  };
  dimContext.addDimensionDigest(
    dimId,
    digest as Parameters<typeof dimContext.addDimensionDigest>[1]
  );
  sessionStore.addDimensionDigest(
    dimId,
    digest as Parameters<typeof sessionStore.addDimensionDigest>[1]
  );

  for (const tc of producerResult.toolCalls || []) {
    const tool = tc.tool || tc.name;
    if (tool === 'submit_knowledge' || tool === 'submit_with_check') {
      const args = tc.params || tc.args || {};
      const candidateSummary = {
        title: String(args.title || ''),
        subTopic: String(args.category || ''),
        summary: String(args.summary || ''),
      };
      dimContext.addSubmittedCandidate(
        dimId,
        candidateSummary as Parameters<typeof dimContext.addSubmittedCandidate>[1]
      );
      sessionStore.addSubmittedCandidate(
        dimId,
        candidateSummary as Parameters<typeof sessionStore.addSubmittedCandidate>[1]
      );
    }
  }

  emitter.emitDimensionComplete(dimId, {
    type: needsCandidates ? 'candidate' : 'skill',
    extracted: producerResult.candidateCount,
    created: producerResult.candidateCount,
    status: 'v3-pipeline-complete',
    degraded: runResult?.degraded || false,
    durationMs: Date.now() - dimStartTime,
    toolCallCount: runtimeToolCalls.length,
    source: 'enhanced-pipeline-strategy',
  });

  const qualityScores = (artifact as Record<string, unknown>).qualityReport as
    | { scores: Record<string, number>; totalScore: number; suggestions: string[] }
    | undefined;
  const dimResult = {
    candidateCount: producerResult.candidateCount,
    rejectedCount: producerResult.rejectedCount || 0,
    analysisChars: analysisReport.analysisText.length,
    referencedFiles: analysisReport.referencedFiles.length,
    durationMs: Date.now() - dimStartTime,
    toolCallCount: runtimeToolCalls.length,
    tokenUsage: combinedTokenUsage,
    diagnostics: runResult.diagnostics || null,
    stages: summarizeDimensionStages(runResult),
    analysisText: analysisReport.analysisText,
    referencedFilesList: analysisReport.referencedFiles || [],
    qualityGate: qualityScores
      ? {
          totalScore: qualityScores.totalScore,
          scores: qualityScores.scores,
          action: gateResult?.action || (runResult?.degraded ? 'degrade' : 'pass'),
        }
      : null,
  };

  dimensionStats[dimId] = dimResult;

  if (analysisReport.analysisText.length >= 50) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- digest shape compatible at runtime
    await saveDimensionCheckpoint(
      dataRoot,
      sessionId,
      dimId,
      dimResult,
      digest as unknown as Parameters<typeof saveDimensionCheckpoint>[4]
    );
  } else {
    logger.warn(
      `[Insight-v3] ⚠ 跳过 checkpoint 保存: "${dimId}" analysisText 过短 (${analysisReport.analysisText.length} chars)`
    );
  }

  return dimResult;
}

function summarizeDimensionStages(runResult: AgentResultLike) {
  const phases = runResult.phases || {};
  return Object.fromEntries(
    Object.entries(phases)
      .filter(([, value]) => value && typeof value === 'object')
      .map(([stage, value]) => {
        const phase = value as {
          toolCalls?: ToolCallRecord[];
          tokenUsage?: { input?: number; output?: number };
          iterations?: number;
          timedOut?: boolean;
        };
        return [
          stage,
          {
            toolCallCount: phase.toolCalls?.length || 0,
            tokenUsage: phase.tokenUsage || { input: 0, output: 0 },
            iterations: phase.iterations || 0,
            timedOut: phase.timedOut === true,
          },
        ];
      })
  );
}

export function consumeBootstrapDimensionError({
  dimId,
  err,
  candidateResults,
  dimensionStats,
  emitter,
}: {
  dimId: string;
  err: unknown;
  candidateResults: CandidateResults;
  dimensionStats: Record<string, DimensionStat>;
  emitter: BootstrapEventEmitter;
}) {
  const errMsg = err instanceof Error ? err.message : String(err);
  logger.error(`[Insight-v3] Dimension "${dimId}" failed: ${errMsg}`);
  candidateResults.errors.push({ dimId, error: errMsg });
  emitter.emitDimensionComplete(dimId, { type: 'error', reason: errMsg });
  const dimResult = { candidateCount: 0, durationMs: 0, error: errMsg };
  dimensionStats[dimId] = dimResult;
  return dimResult;
}
