/**
 * DimensionResultConsumer — 单维度执行结果/错误的消费处理器
 *
 * 结构清洗 W2：自 GenerateConsumers.ts 纯移动拆出。承载
 * consumeGenerateDimensionResult / consumeGenerateDimensionError 及其私有助手：
 * checkpoint 决策、token/效率统计记录、dimension-complete 事件载荷构建、
 * PCV 证据信封构建与报告/digest 写入；候选记账与 [Producer] 汇总日志见
 * 同目录 CandidateAccounting.ts。逻辑与日志文案保持逐字不变。
 */

import type { MemoryCoordinator, SessionStore } from '@alembic/agent/memory';
import { saveDimensionCheckpoint } from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import type { AgentEfficiencySummary } from '#recipe-pipeline/generate/runtime/GenerateEfficiency.js';
import type { GenerateEventEmitter } from '#recipe-pipeline/generate/runtime/GenerateEventEmitter.js';
import type { ProjectContextDimensionResultHook } from '../../../../project-facts/ProjectContextWorkflowFacts.js';
import {
  type AgentResultLike,
  type DimensionFinding,
  type GenerateDimensionAnalysisReport,
  type GenerateDimensionProducerResult,
  type GenerateDimensionProjection,
  type GenerateDimensionRunIssue,
  isRecoverableProducerTimeoutIssue,
  normalizeDimensionFindings,
  resolveGenerateDimensionRunIssue,
  type ToolCallRecord,
} from '../AgentRunProjections.js';
import { type DimensionContext, parseDimensionDigest } from '../DimensionContext.js';
import {
  buildPcvAnalyzeGroundingLedgerSummary,
  buildPcvN9StageProjectionEvidence,
  buildPcvN12ConsumerPersistenceEvidence,
  buildPcvN12ErrorEvidence,
  buildPcvNodeEvidenceEnvelope,
  type GeneratePcvNodeEvidenceSet,
  mergeGeneratePcvNodeEvidence,
  type PcvNodeEvidenceEnvelope,
  successfulProducerSubmitCalls,
} from '../PcvStageNodeMap.js';
import {
  applyGenerateDimensionCandidateAccounting,
  type GenerateDimensionCandidateAccountingResult,
  logGenerateDimensionProducerSummary,
} from './CandidateAccounting.js';
import {
  type CandidateResults,
  type DimensionCandidateData,
  type DimensionStat,
  type GenerateDimensionRunIssueState,
  isRecord,
} from './shared.js';

const logger = Logger.getInstance();

// ---------------------------------------------------------------------------
// Dimension consumer
// ---------------------------------------------------------------------------

interface BootstrapDimensionConsumerContext {
  container?: {
    get?: (key: string) => unknown;
    singletons?: {
      aiProvider?: { name?: string; model?: string } | null;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface TokenUsageStoreLike {
  record(value: Record<string, unknown>): void;
}

interface RealtimeServiceLike {
  broadcastTokenUsageUpdated?(): void;
}

type BootstrapDimensionCompleteEventPayload = Parameters<
  GenerateEventEmitter['emitDimensionComplete']
>[1];

export interface ConsumeGenerateDimensionResultOptions {
  ctx: BootstrapDimensionConsumerContext;
  dimId: string;
  dimConfig: { label?: string };
  needsCandidates: boolean;
  projection: GenerateDimensionProjection;
  runResult: AgentResultLike;
  dimStartTime: number;
  analystScopeId: string;
  memoryCoordinator: MemoryCoordinator;
  sessionStore: SessionStore;
  dimContext: DimensionContext;
  candidateResults: CandidateResults;
  dimensionCandidates: Record<string, DimensionCandidateData>;
  dimensionStats: Record<string, DimensionStat>;
  emitter: GenerateEventEmitter;
  dataRoot: string;
  sessionId: string;
  onDimensionResult?: ProjectContextDimensionResultHook;
}

export interface GenerateDimensionCheckpointDecision {
  reason: string | null;
  shouldSave: boolean;
}

export interface GenerateDimensionPcvEvidenceResult {
  pcvNodeEvidence: GeneratePcvNodeEvidenceSet;
  pcvNodeEvidenceEnvelope: PcvNodeEvidenceEnvelope;
}

export function resolveGenerateDimensionConsumerRunIssue({
  needsCandidates,
  projection,
  runResult,
}: {
  needsCandidates: boolean;
  projection: GenerateDimensionProjection;
  runResult: AgentResultLike;
}): GenerateDimensionRunIssueState {
  const rawRunIssue = resolveGenerateDimensionRunIssue(runResult);
  const recoveredProducerTimeout = isRecoverableProducerTimeoutIssue({
    issue: rawRunIssue,
    needsCandidates,
    produceResult: projection.produceResult,
    successCount: projection.successCount,
  });
  const runIssue = recoveredProducerTimeout ? null : rawRunIssue;
  const isNormalCompletion = !runIssue;
  return {
    effectiveCandidateCount: isNormalCompletion ? projection.producerResult.candidateCount : 0,
    isNormalCompletion,
    rawRunIssue,
    recoveredProducerTimeout,
    runIssue,
  };
}

function writeBootstrapDimensionReport({
  analysisReport,
  analystScopeId,
  dimId,
  memoryCoordinator,
  sessionStore,
}: {
  analysisReport: GenerateDimensionAnalysisReport;
  analystScopeId: string;
  dimId: string;
  memoryCoordinator: MemoryCoordinator;
  sessionStore: SessionStore;
}) {
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
  return distilled;
}

function writeBootstrapDimensionDigestAndCandidates({
  analysisReport,
  candidateAccounting,
  dimContext,
  dimId,
  producerResult,
  sessionStore,
}: {
  analysisReport: GenerateDimensionAnalysisReport;
  candidateAccounting: GenerateDimensionCandidateAccountingResult;
  dimContext: DimensionContext;
  dimId: string;
  producerResult: GenerateDimensionProducerResult;
  sessionStore: SessionStore;
}) {
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

  for (const candidateSummary of candidateAccounting.submittedCandidateSummaries) {
    dimContext.addSubmittedCandidate(
      dimId,
      candidateSummary as Parameters<typeof dimContext.addSubmittedCandidate>[1]
    );
    sessionStore.addSubmittedCandidate(
      dimId,
      candidateSummary as Parameters<typeof sessionStore.addSubmittedCandidate>[1]
    );
  }
  return digest;
}

export function buildGenerateDimensionCompleteEventPayload({
  candidateAccounting,
  combinedTokenUsage,
  dimStartTime,
  efficiency,
  needsCandidates,
  runIssueState,
  runResult,
  runtimeToolCalls,
}: {
  candidateAccounting: GenerateDimensionCandidateAccountingResult;
  combinedTokenUsage: { input: number; output: number };
  dimStartTime: number;
  efficiency: AgentEfficiencySummary | null | undefined;
  needsCandidates: boolean;
  runIssueState: GenerateDimensionRunIssueState;
  runResult: AgentResultLike;
  runtimeToolCalls: ToolCallRecord[];
}): BootstrapDimensionCompleteEventPayload {
  return {
    type: needsCandidates ? 'candidate' : 'skill',
    extracted: candidateAccounting.effectiveCandidateCount,
    created: candidateAccounting.effectiveCandidateCount,
    status: runIssueState.runIssue?.status || 'v3-pipeline-complete',
    reason: runIssueState.runIssue?.reason,
    degraded: runResult?.degraded || false,
    durationMs: Date.now() - dimStartTime,
    toolCallCount: runtimeToolCalls.length,
    tokenUsage: combinedTokenUsage,
    efficiency,
    source: 'enhanced-pipeline-strategy',
  } as BootstrapDimensionCompleteEventPayload;
}

export function buildGenerateDimensionPcvEvidenceEnvelope({
  dimConfig,
  dimId,
  existingEvidence,
  needsCandidates,
  projection,
  runIssueState,
  runResult,
  sessionStore,
}: {
  dimConfig: { label?: string };
  dimId: string;
  existingEvidence?: unknown;
  needsCandidates: boolean;
  projection: GenerateDimensionProjection;
  runIssueState: GenerateDimensionRunIssueState;
  runResult: AgentResultLike;
  sessionStore: SessionStore;
}): GenerateDimensionPcvEvidenceResult {
  const groundingLedger = buildPcvAnalyzeGroundingLedgerSummary({
    dimId,
    label: dimConfig.label,
    runResult,
  });
  const n9QualityGate = buildPcvN9StageProjectionEvidence({
    dimId,
    label: dimConfig.label,
    runResult,
    stage: 'quality_gate',
  });
  const n9RecordRepair = buildPcvN9StageProjectionEvidence({
    dimId,
    label: dimConfig.label,
    runResult,
    stage: 'record_repair',
  });
  const pcvNodeEvidence = mergeGeneratePcvNodeEvidence(existingEvidence, {
    ...(groundingLedger ? { groundingLedger } : {}),
    ...(n9QualityGate ? { n9QualityGate } : {}),
    ...(n9RecordRepair ? { n9RecordRepair } : {}),
    n12: buildPcvN12ConsumerPersistenceEvidence({
      acceptedSubmitCalls: runIssueState.isNormalCompletion
        ? successfulProducerSubmitCalls(projection)
        : [],
      dimId,
      runIssueReason: runIssueState.runIssue?.reason || null,
      sessionStore,
    }),
  });
  return {
    pcvNodeEvidence,
    pcvNodeEvidenceEnvelope: buildPcvNodeEvidenceEnvelope({
      dimId,
      evidence: pcvNodeEvidence,
      source: 'bootstrap-dimension-consumer',
    }),
  };
}

export function decideGenerateDimensionCheckpoint({
  analysisText,
}: {
  analysisText: string;
}): GenerateDimensionCheckpointDecision {
  if (analysisText.length >= 50) {
    return { reason: null, shouldSave: true };
  }
  return {
    reason: `analysisText 过短 (${analysisText.length} chars)`,
    shouldSave: false,
  };
}

export function recordGenerateDimensionTokenUsage({
  combinedTokenUsage,
  ctx,
  dimId,
  dimStartTime,
  efficiency,
  runtimeToolCalls,
  sessionId,
}: {
  combinedTokenUsage: { input: number; output: number };
  ctx: BootstrapDimensionConsumerContext;
  dimId: string;
  dimStartTime: number;
  efficiency: AgentEfficiencySummary | null | undefined;
  runtimeToolCalls: ToolCallRecord[];
  sessionId: string;
}): void {
  try {
    const tokenStore = ctx.container?.get?.('tokenUsageStore') as TokenUsageStoreLike | undefined;
    const aiProv = ctx.container?.singletons?.aiProvider as
      | { name?: string; model?: string }
      | undefined;
    if (tokenStore) {
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
        const realtime = ctx.container?.get?.('realtimeService') as RealtimeServiceLike | undefined;
        realtime?.broadcastTokenUsageUpdated?.();
      } catch {
        /* optional */
      }
    }
    if (efficiency) {
      logger.info('[BootstrapEfficiency] Dimension metrics recorded', {
        sessionId: sessionId || null,
        dimension: dimId,
        stage: 'dimension-complete',
        provider: aiProv?.name || null,
        model: aiProv?.model || null,
        toolCalls: efficiency.toolCalls,
        duplicateToolCalls: efficiency.duplicateToolCalls,
        cacheHits: efficiency.cacheHits,
        cacheMisses: efficiency.cacheMisses,
        inputTokens: efficiency.tokenUsage.input,
        outputTokens: efficiency.tokenUsage.output,
        reasoningTokens: efficiency.tokenUsage.reasoning,
        cacheHitTokens: efficiency.tokenUsage.cacheHit,
        nudgeCount: efficiency.nudgeCount,
        replanCount: efficiency.replanCount,
        emptyRetries: efficiency.emptyRetries,
        maxCompactionLevel: efficiency.maxCompactionLevel,
        totalCompactedItems: efficiency.totalCompactedItems,
        forcedSummary: efficiency.forcedSummary,
        cancelReason: efficiency.cancelReason || null,
      });
    }
  } catch {
    /* token logging should never break execution */
  }
}

export function applyGenerateDimensionErrorAccounting({
  candidateResults,
  dimId,
  issue,
}: {
  candidateResults: CandidateResults;
  dimId: string;
  issue: GenerateDimensionRunIssue;
}): void {
  candidateResults.errors.push({ dimId, error: issue.reason });
}

export function buildGenerateDimensionErrorEventPayload(
  issue: GenerateDimensionRunIssue
): BootstrapDimensionCompleteEventPayload {
  return {
    type: 'error',
    status: issue.status,
    reason: issue.reason,
  } as BootstrapDimensionCompleteEventPayload;
}

export function buildGenerateDimensionErrorPcvEvidenceEnvelope({
  dimId,
  error,
  existingEvidence,
}: {
  dimId: string;
  error: string;
  existingEvidence?: unknown;
}): GenerateDimensionPcvEvidenceResult {
  const pcvNodeEvidence = mergeGeneratePcvNodeEvidence(existingEvidence, {
    n12: buildPcvN12ErrorEvidence({ dimId, error }),
  });
  return {
    pcvNodeEvidence,
    pcvNodeEvidenceEnvelope: buildPcvNodeEvidenceEnvelope({
      dimId,
      evidence: pcvNodeEvidence,
      source: 'bootstrap-dimension-error',
    }),
  };
}

export async function consumeGenerateDimensionResult({
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
  onDimensionResult,
}: ConsumeGenerateDimensionResultOptions): Promise<DimensionStat> {
  const {
    gateResult,
    artifact,
    runtimeToolCalls,
    combinedTokenUsage,
    efficiency,
    analysisReport,
    producerResult,
    successCount,
  } = projection;
  const runIssueState = resolveGenerateDimensionConsumerRunIssue({
    needsCandidates,
    projection,
    runResult,
  });
  if (runIssueState.recoveredProducerTimeout) {
    logger.warn(
      `[Producer] "${dimId}": producer summary timed out after ${successCount} successful candidate submit(s); preserving produced candidates as dimension output.`
    );
  }
  const candidateAccounting = applyGenerateDimensionCandidateAccounting({
    candidateResults,
    dimId,
    dimensionCandidates,
    projection,
    runIssueState,
  });
  await notifyProjectContextDimensionResult({
    acceptedSourceRefs: candidateAccounting.acceptedSourceRefs,
    candidateCount: candidateAccounting.effectiveCandidateCount,
    dimensionId: dimId,
    onDimensionResult,
    referencedFiles: analysisReport.referencedFiles || [],
    rejectedCount: candidateAccounting.rejectedCount,
  });

  // W2 纯移动：[Producer] 汇总日志（含 unique 双口径）整块迁至 CandidateAccounting.ts，触发条件与文案不变。
  logGenerateDimensionProducerSummary({
    dimId,
    needsCandidates,
    projection,
    runIssueState,
    runResult,
  });

  const distilled = writeBootstrapDimensionReport({
    analysisReport,
    analystScopeId,
    dimId,
    memoryCoordinator,
    sessionStore,
  });
  if (runIssueState.runIssue) {
    logger.warn(`[generate] Dimension "${dimId}" completed with non-normal status`, {
      dimension: dimId,
      status: runIssueState.runIssue.status,
      reason: runIssueState.runIssue.reason,
      degraded: runResult?.degraded || runResult?.diagnostics?.degraded || false,
    });
  }

  logger.info(
    `[generate] Dimension "${dimId}": analysis=${analysisReport.analysisText.length} chars, ` +
      `files=${analysisReport.referencedFiles.length}, findings=${(analysisReport.findings || distilled.keyFindings).length}, ` +
      `toolCalls=${runtimeToolCalls.length}, degraded=${runResult?.degraded || false} (${Date.now() - dimStartTime}ms)`
  );

  recordGenerateDimensionTokenUsage({
    combinedTokenUsage,
    ctx,
    dimId,
    dimStartTime,
    efficiency,
    runtimeToolCalls,
    sessionId,
  });

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
        `[generate] analysisText 补强 "${dimId}": ${originalLen} → ${analysisReport.analysisText.length} chars ` +
          `(from ${findings.length} findings)`
      );
    }
  }

  const digest = writeBootstrapDimensionDigestAndCandidates({
    analysisReport,
    candidateAccounting,
    dimContext,
    dimId,
    producerResult,
    sessionStore,
  });

  emitter.emitDimensionComplete(
    dimId,
    buildGenerateDimensionCompleteEventPayload({
      candidateAccounting,
      combinedTokenUsage,
      dimStartTime,
      efficiency,
      needsCandidates,
      runIssueState,
      runResult,
      runtimeToolCalls,
    })
  );

  const qualityScores = (artifact as Record<string, unknown>).qualityReport as
    | { scores: Record<string, number>; totalScore: number; suggestions: string[] }
    | undefined;
  const { pcvNodeEvidence, pcvNodeEvidenceEnvelope } = buildGenerateDimensionPcvEvidenceEnvelope({
    dimConfig,
    dimId,
    existingEvidence: dimensionStats[dimId]?.pcvNodeEvidence,
    needsCandidates,
    projection,
    runIssueState,
    runResult,
    sessionStore,
  });
  const status = runIssueState.runIssue?.status || 'v3-pipeline-complete';
  const error = runIssueState.runIssue?.reason;
  const checkpointDecision = decideGenerateDimensionCheckpoint({
    analysisText: analysisReport.analysisText,
  });
  const dimResult = {
    status,
    candidateCount: candidateAccounting.effectiveCandidateCount,
    rejectedCount: candidateAccounting.rejectedCount,
    analysisChars: analysisReport.analysisText.length,
    referencedFiles: analysisReport.referencedFiles.length,
    durationMs: Date.now() - dimStartTime,
    toolCallCount: runtimeToolCalls.length,
    tokenUsage: combinedTokenUsage,
    efficiency,
    diagnostics: runResult.diagnostics || null,
    error,
    recoveredProducerTimeout: runIssueState.recoveredProducerTimeout,
    pcvNodeEvidence,
    pcvNodeEvidenceEnvelope,
    stages: summarizeDimensionStages(runResult),
    analysisText: analysisReport.analysisText,
    referencedFilesList: analysisReport.referencedFiles || [],
    qualityGate: qualityScores
      ? {
          totalScore: qualityScores.totalScore,
          scores: qualityScores.scores,
          action:
            runIssueState.runIssue?.status ||
            gateResult?.action ||
            (runResult?.degraded ? 'degrade' : 'pass'),
        }
      : null,
  };

  dimensionStats[dimId] = dimResult;

  if (checkpointDecision.shouldSave) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- digest shape compatible at runtime
    await saveDimensionCheckpoint(
      dataRoot,
      sessionId,
      dimId,
      dimResult,
      digest as unknown as Parameters<typeof saveDimensionCheckpoint>[4]
    );
  } else {
    logger.warn(`[generate] ⚠ 跳过 checkpoint 保存: "${dimId}" ${checkpointDecision.reason}`);
  }

  return dimResult;
}

async function notifyProjectContextDimensionResult({
  acceptedSourceRefs,
  candidateCount,
  dimensionId,
  onDimensionResult,
  referencedFiles,
  rejectedCount,
}: {
  acceptedSourceRefs: readonly string[];
  candidateCount: number;
  dimensionId: string;
  onDimensionResult?: ProjectContextDimensionResultHook;
  referencedFiles: readonly string[];
  rejectedCount: number;
}) {
  if (!onDimensionResult) {
    return;
  }
  try {
    await onDimensionResult({
      acceptedSourceRefs,
      candidateCount,
      dimensionId,
      referencedFiles,
      rejectedCount,
    });
  } catch (err: unknown) {
    logger.warn('[generate] Dimension result hook failed', {
      dimension: dimensionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

export function consumeGenerateDimensionError({
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
  emitter: GenerateEventEmitter;
}) {
  const issue = normalizeBootstrapDimensionError(err);
  const errMsg = issue.reason;
  logger.error(`[generate] Dimension "${dimId}" failed: ${errMsg}`);
  applyGenerateDimensionErrorAccounting({ candidateResults, dimId, issue });
  emitter.emitDimensionComplete(dimId, buildGenerateDimensionErrorEventPayload(issue));
  const { pcvNodeEvidence, pcvNodeEvidenceEnvelope } =
    buildGenerateDimensionErrorPcvEvidenceEnvelope({
      dimId,
      error: errMsg,
      existingEvidence: dimensionStats[dimId]?.pcvNodeEvidence,
    });
  const dimResult = {
    status: issue.status,
    candidateCount: 0,
    durationMs: 0,
    error: errMsg,
    diagnostics: issue.diagnostics || null,
    pcvNodeEvidence,
    pcvNodeEvidenceEnvelope,
  };
  dimensionStats[dimId] = dimResult;
  return dimResult;
}

function normalizeBootstrapDimensionError(err: unknown): GenerateDimensionRunIssue {
  if (isBootstrapDimensionRunIssue(err)) {
    return err;
  }
  // 全量 run 复盘：普通对象经 String() 输出 [object Object]——维度失败全链不可归因。
  // 安全序列化：Error 取 message；字符串直取；对象 JSON 截断（循环引用回退 String）。
  let reason: string;
  if (err instanceof Error) {
    reason = err.message;
  } else if (typeof err === 'string') {
    reason = err;
  } else {
    try {
      reason = JSON.stringify(err)?.slice(0, 300) ?? String(err);
    } catch {
      reason = String(err);
    }
  }
  return { status: 'error', reason };
}

function isBootstrapDimensionRunIssue(value: unknown): value is GenerateDimensionRunIssue {
  return (
    isRecord(value) &&
    typeof value.status === 'string' &&
    typeof value.reason === 'string' &&
    [
      'timeout',
      'blocked',
      'aborted',
      'error',
      'degraded_budget_exhausted',
      'degraded_no_findings',
      'record_repair_incomplete',
      'l4_compaction_failed_budget_exhausted',
    ].includes(value.status)
  );
}
