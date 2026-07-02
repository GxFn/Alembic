/**
 * BootstrapConsumers — 内部 Agent 维度执行结果的消费处理器
 *
 * 处理维度运行结果的各个方面：
 *   - Dimension: 单维度分析报告消费、候选提交、checkpoint 保存
 *   - Session: 整体会话结果消费、缺失维度检测
 *   - Tier: 分层反思生成（跨维度 pattern 发现）
 *   - CandidateRelation: 候选间关系写入 Code Entity Graph
 *   - Skill: skillWorthy 维度的 Project Skill 生成
 */

import type { MemoryCoordinator, SessionStore } from '@alembic/agent/memory';
import type { AgentRunResult } from '@alembic/agent/service';
import {
  buildTierReflection,
  type ProjectSkillDeliveryReceipt,
  saveDimensionCheckpoint,
} from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import type { AgentEfficiencySummary } from '#recipe-pipeline/generate/runtime/GenerateEfficiency.js';
import type { GenerateEventEmitter } from '#recipe-pipeline/generate/runtime/GenerateEventEmitter.js';
import type { ProjectContextDimensionResultHook } from '../../../workflows/project-context/ProjectContextWorkflowFacts.js';
import {
  generateSkill,
  type WorkflowSkillGenerationResult,
} from '../../../workflows/skill-delivery/SkillCompletionCapability.js';
import {
  type AgentResultLike,
  type DimensionFinding,
  type GenerateDimensionAnalysisReport,
  type GenerateDimensionProducerResult,
  type GenerateDimensionProjection,
  type GenerateDimensionRunIssue,
  type GenerateSessionProjection,
  isRecoverableProducerTimeoutIssue,
  normalizeDimensionFindings,
  projectGenerateSessionResult,
  resolveGenerateDimensionRunIssue,
  type ToolCallRecord,
} from './AgentRunProjections.js';
import { type DimensionContext, parseDimensionDigest } from './DimensionContext.js';
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
} from './PcvNodeEvidence.js';

const logger = Logger.getInstance();

// ---------------------------------------------------------------------------
// Dimension consumer
// ---------------------------------------------------------------------------

export interface DimensionStat {
  candidateCount: number;
  rejectedCount?: number;
  analysisChars?: number;
  referencedFiles?: number;
  referencedFilesList?: string[];
  durationMs: number;
  toolCallCount?: number;
  tokenUsage?: { input: number; output: number };
  efficiency?: AgentEfficiencySummary | null;
  skipped?: boolean;
  restoredFromCheckpoint?: boolean;
  restoredFromIncremental?: boolean;
  analysisText?: string;
  error?: string;
  pcvNodeEvidenceEnvelope?: PcvNodeEvidenceEnvelope;
  [key: string]: unknown;
}

export interface CandidateResults {
  created: number;
  failed: number;
  errors: Array<{ dimId: string; error: string }>;
}

export interface DimensionCandidateData {
  analysisReport: GenerateDimensionAnalysisReport;
  producerResult: GenerateDimensionProducerResult;
}

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

export interface GenerateDimensionRunIssueState {
  effectiveCandidateCount: number;
  isNormalCompletion: boolean;
  rawRunIssue: GenerateDimensionRunIssue | null;
  recoveredProducerTimeout: boolean;
  runIssue: GenerateDimensionRunIssue | null;
}

export interface GenerateDimensionCandidateAccountingResult {
  acceptedSubmitCalls: ToolCallRecord[];
  acceptedSourceRefs: string[];
  effectiveCandidateCount: number;
  rejectedCount: number;
  submittedCandidateSummaries: Array<{
    subTopic: string;
    summary: string;
    title: string;
  }>;
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

export function applyGenerateDimensionCandidateAccounting({
  candidateResults,
  dimId,
  dimensionCandidates,
  projection,
  runIssueState,
}: {
  candidateResults: CandidateResults;
  dimId: string;
  dimensionCandidates: Record<string, DimensionCandidateData>;
  projection: GenerateDimensionProjection;
  runIssueState: GenerateDimensionRunIssueState;
}): GenerateDimensionCandidateAccountingResult {
  candidateResults.created += runIssueState.effectiveCandidateCount;
  dimensionCandidates[dimId] = {
    analysisReport: projection.analysisReport,
    producerResult: projection.producerResult,
  };

  const acceptedSubmitCalls = runIssueState.isNormalCompletion
    ? projection.submitCalls.filter(isSuccessfulToolCall)
    : [];
  return {
    acceptedSubmitCalls,
    acceptedSourceRefs: collectAcceptedSubmitCallSourceRefs(acceptedSubmitCalls),
    effectiveCandidateCount: runIssueState.effectiveCandidateCount,
    rejectedCount: runIssueState.isNormalCompletion
      ? projection.producerResult.rejectedCount || 0
      : projection.submitCalls.length,
    submittedCandidateSummaries: acceptedSubmitCalls.map((call) =>
      buildSubmittedCandidateSummary(call, dimId)
    ),
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
    produceResult,
    analysisText,
    artifact,
    runtimeToolCalls,
    combinedTokenUsage,
    efficiency,
    analysisReport,
    producerResult,
    submitCalls,
    successCount,
    rejectedCount,
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

    if (successCount === 0 && submitCalls.length === 0 && runIssueState.isNormalCompletion) {
      logger.warn(
        `[Producer] "${dimId}": ⚠ Producer 未提交任何候选。` +
          `分析文本=${analysisText.length} chars, findings=${(analysisReport.findings || []).length}, ` +
          `producerIterations=${producerToolCalls.length}, degraded=${runResult?.degraded || false}`
      );
    }
  }

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

function buildSubmittedCandidateSummary(tc: ToolCallRecord, dimId: string) {
  const params = extractSubmitParams(tc);
  const result = isRecord(tc.result) ? tc.result : {};
  return {
    title: pickString(params.title) || pickString(result.title),
    subTopic: pickString(params.category) || pickString(params.knowledgeType) || dimId,
    summary: pickString(params.summary) || pickString(params.description),
  };
}

function collectAcceptedSubmitCallSourceRefs(acceptedSubmitCalls: readonly ToolCallRecord[]) {
  const refs = acceptedSubmitCalls.flatMap((tc) => {
    const params = extractSubmitParams(tc);
    const reasoningRefs = isRecord(params.reasoning) ? stringArray(params.reasoning.sources) : [];
    return [
      ...stringArray(params.sourceRefs),
      ...stringArray(params.referencedFiles),
      ...reasoningRefs,
    ];
  });
  return uniqueStrings(refs);
}

function extractSubmitParams(tc: ToolCallRecord): Record<string, unknown> {
  const rawArgs = tc.params || tc.args || {};
  const nestedParams = rawArgs.params;
  return isRecord(nestedParams) ? nestedParams : rawArgs;
}

function isSuccessfulToolCall(tc: ToolCallRecord): boolean {
  const res = tc.result;
  // 核心修正:失败的 submit 经 fail(...) → data:null 折叠成 null 结果；非结构化结果同样不是成功。
  // 旧逻辑把这两种都 return true(误记为 accepted，掩盖了真库 0 行)。null/非结构化判为失败;其余保持原判据。
  if (!res) {
    return false;
  }
  if (typeof res === 'string') {
    return !res.includes('rejected') && !res.includes('error');
  }
  if (!isRecord(res)) {
    return false;
  }
  if (res.error || res.submitted === false) {
    return false;
  }
  return res.status !== 'rejected' && res.status !== 'error';
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
  return {
    status: 'error',
    reason: err instanceof Error ? err.message : String(err),
  };
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

// ---------------------------------------------------------------------------
// Session consumer
// ---------------------------------------------------------------------------

export interface ConsumeGenerateSessionResultOptions {
  parentRunResult: AgentRunResult;
  activeDimIds: string[];
  skippedDimIds: string[];
  durationMs: number;
  sessionStore: SessionStore;
  dimensionStats: Record<string, DimensionStat>;
  consumeMissingDimension: (dimId: string) => void;
}

export function consumeGenerateSessionResult({
  parentRunResult,
  activeDimIds,
  skippedDimIds,
  durationMs,
  sessionStore,
  dimensionStats,
  consumeMissingDimension,
}: ConsumeGenerateSessionResultOptions): GenerateSessionProjection {
  const projection = projectGenerateSessionResult({
    parentRunResult,
    activeDimIds,
    skippedDimIds,
  });
  consumeMissingGenerateDimensions({
    missingDimensionIds: projection.missingDimensionIds,
    dimensionStats,
    consumeMissingDimension,
  });
  logger.info(
    `[generate] All tiers complete: ${projection.completedDimensions} dimensions in ${durationMs}ms`
  );
  if (
    projection.parentStatus !== 'success' ||
    projection.failedDimensionIds.length > 0 ||
    projection.abortedDimensionIds.length > 0
  ) {
    logger.warn(
      `[generate] Bootstrap session completed with ${projection.failedDimensionIds.length} failed, ${projection.abortedDimensionIds.length} aborted dimensions (status=${projection.parentStatus})`
    );
  }
  if (projection.missingDimensionIds.length > 0) {
    logger.warn(
      `[generate] Bootstrap session missing dimension results: [${projection.missingDimensionIds.join(', ')}]`
    );
  }

  const emStats = sessionStore.getStats();
  logger.info(
    `[generate] Memory stats: ${emStats.completedDimensions} dims, ` +
      `${emStats.totalFindings} findings, ${emStats.referencedFiles} files, ` +
      `${emStats.crossReferences} cross-refs, ${emStats.tierReflections} reflections`
  );
  if (emStats.cache) {
    logger.info(
      `[generate] Cache stats: ${emStats.cache.hitRate} hit rate, ` +
        `${emStats.cache.searchCacheSize} searches, ${emStats.cache.fileCacheSize} files`
    );
  }
  return projection;
}

export function consumeMissingGenerateDimensions({
  missingDimensionIds,
  dimensionStats,
  consumeMissingDimension,
}: {
  missingDimensionIds: string[];
  dimensionStats: Record<string, DimensionStat>;
  consumeMissingDimension: (dimId: string) => void;
}) {
  for (const dimId of missingDimensionIds) {
    if (dimensionStats[dimId]) {
      continue;
    }
    consumeMissingDimension(dimId);
  }
}

// ---------------------------------------------------------------------------
// Skill consumer
// ---------------------------------------------------------------------------

export interface SkillResults {
  created: number;
  failed: number;
  deliveryReceiptSummaries?: string[];
  deliveryReceiptValidationIssues?: Array<{ dimId: string; issues: string[]; skillName: string }>;
  deliveryReceipts?: ProjectSkillDeliveryReceipt[];
  skills: string[];
  errors: Array<{ dimId: string; error: string }>;
}

export interface GenerateSkillDimension {
  id: string;
  label?: string;
  skillWorthy?: boolean;
  skillMeta?: { name?: string; description?: string } | null;
}

type GenerateSkillFn = typeof generateSkill;

export interface ConsumeGenerateSkillsOptions {
  ctx: Parameters<GenerateSkillFn>[0];
  dimensions: GenerateSkillDimension[];
  dimensionCandidates: Record<string, DimensionCandidateData>;
  sessionStore: SessionStore;
  emitter: GenerateEventEmitter;
  sessionId?: string;
  shouldAbort?: () => boolean;
  generateSkillFn?: GenerateSkillFn;
}

export async function consumeGenerateSkills({
  ctx,
  dimensions,
  dimensionCandidates,
  sessionStore,
  emitter,
  sessionId,
  shouldAbort,
  generateSkillFn = generateSkill,
}: ConsumeGenerateSkillsOptions): Promise<SkillResults> {
  const skillResults: SkillResults = {
    created: 0,
    deliveryReceiptSummaries: [],
    deliveryReceiptValidationIssues: [],
    deliveryReceipts: [],
    failed: 0,
    skills: [],
    errors: [],
  };

  try {
    for (const dim of dimensions) {
      if (!dim.skillWorthy) {
        continue;
      }
      const dimData = dimensionCandidates[dim.id];
      if (!dimData?.analysisReport?.analysisText) {
        continue;
      }
      if (shouldAbort?.()) {
        break;
      }

      await consumeSingleBootstrapSkill({
        ctx,
        dim,
        dimData,
        sessionStore,
        emitter,
        sessionId,
        skillResults,
        generateSkillFn,
      });
    }
  } catch (e: unknown) {
    logger.warn(
      `[generate] Skill generation module import failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  return skillResults;
}

async function consumeSingleBootstrapSkill({
  ctx,
  dim,
  dimData,
  sessionStore,
  emitter,
  sessionId,
  skillResults,
  generateSkillFn,
}: {
  ctx: Parameters<GenerateSkillFn>[0];
  dim: GenerateSkillDimension;
  dimData: DimensionCandidateData;
  sessionStore: SessionStore;
  emitter: GenerateEventEmitter;
  sessionId?: string;
  skillResults: SkillResults;
  generateSkillFn: GenerateSkillFn;
}) {
  try {
    const analysisText = dimData.analysisReport.analysisText;
    const referencedFiles = dimData.analysisReport.referencedFiles || [];
    const dimReport = sessionStore.getDimensionReport(dim.id);
    const keyFindings = extractSkillKeyFindings(dimReport);
    const effectiveText = buildEffectiveSkillAnalysisText({
      dim,
      analysisText,
      keyFindings,
      distilled: dimReport?.workingMemoryDistilled,
    });

    const result = await generateSkillFn(
      ctx,
      dim,
      effectiveText,
      referencedFiles,
      keyFindings,
      'bootstrap-v3'
    );

    if (result.success) {
      recordSkillDeliveryReceipt({
        dim,
        emitter,
        result,
        sessionId,
        skillResults,
      });
      skillResults.created++;
      skillResults.skills.push(result.skillName);
      emitter.emitDimensionComplete(dim.id, {
        type: 'skill',
        deliveryReceipt: result.deliveryReceipt,
        deliveryReceiptSummary: result.deliveryReceiptSummary,
        deliveryReceiptValidation: result.deliveryReceiptValidation,
        skillName: result.skillName,
        sourceCount: referencedFiles.length,
      });
    } else {
      skillResults.failed++;
      skillResults.errors.push({ dimId: dim.id, error: result.error ?? 'unknown' });
      emitter.emitDimensionFailed(dim.id, new Error(result.error));
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`[generate] Skill generation failed for "${dim.id}": ${errMsg}`);
    skillResults.failed++;
    skillResults.errors.push({ dimId: dim.id, error: errMsg });
    emitter.emitDimensionFailed(dim.id, err instanceof Error ? err : new Error(errMsg));
  }
}

function recordSkillDeliveryReceipt({
  dim,
  emitter,
  result,
  sessionId,
  skillResults,
}: {
  dim: GenerateSkillDimension;
  emitter: GenerateEventEmitter;
  result: WorkflowSkillGenerationResult;
  sessionId?: string;
  skillResults: SkillResults;
}) {
  if (!result.deliveryReceipt) {
    return;
  }

  skillResults.deliveryReceipts?.push(result.deliveryReceipt);
  if (result.deliveryReceiptSummary) {
    skillResults.deliveryReceiptSummaries?.push(result.deliveryReceiptSummary);
  }
  if (result.deliveryReceiptValidation && !result.deliveryReceiptValidation.ok) {
    skillResults.deliveryReceiptValidationIssues?.push({
      dimId: dim.id,
      issues: result.deliveryReceiptValidation.issues,
      skillName: result.skillName,
    });
  }

  if (!sessionId) {
    return;
  }

  const emitProcessEvents = (
    emitter as { emitProcessEvents?: GenerateEventEmitter['emitProcessEvents'] }
  ).emitProcessEvents;
  emitProcessEvents?.call(emitter, {
    dimensionId: dim.id,
    sessionId,
    source: 'alembic-project-skill-delivery',
    targetName: dim.label ?? dim.id,
    taskId: dim.id,
    events: [
      {
        artifactRefs: [
          {
            kind: 'project-skill-delivery-receipt',
            label: 'ProjectSkillDeliveryReceipt',
            mimeType: 'application/json',
            ref: `project-skill-delivery:${result.deliveryReceipt.id}`,
          },
          {
            kind: 'skill-file',
            label: 'Generated SKILL.md',
            mimeType: 'text/markdown',
            ref: result.deliveryReceipt.asset.path,
          },
        ],
        content: {
          data: result.deliveryReceipt,
          language: 'json',
          mimeType: 'application/json',
          role: 'tool',
          text: JSON.stringify(result.deliveryReceipt, null, 2),
        },
        displayPolicy: 'summary-only',
        kind: 'artifact',
        metadata: {
          projectScopeId: result.deliveryReceipt.projectScopeId,
          receiptId: result.deliveryReceipt.id,
          route: result.deliveryReceipt.route,
          runtimeExportStatus: result.deliveryReceipt.runtimeExport.status,
          skillName: result.skillName,
          validationIssues: result.deliveryReceiptValidation?.issues ?? [],
        },
        phase: 'skill-delivery',
        retention: 'artifact-retained',
        severity: result.deliveryReceiptValidation?.ok === false ? 'warning' : 'success',
        summary:
          result.deliveryReceiptSummary ??
          `Project Skill ${result.skillName} generated; runtime export pending.`,
        title: 'Project Skill delivery receipt',
      },
    ],
  });
}

export function extractSkillKeyFindings(dimReport: unknown): string[] {
  const report = dimReport as { findings?: Array<Record<string, unknown>> } | null | undefined;
  return ((report?.findings || []) as Array<Record<string, unknown>>)
    .sort((a, b) => (Number(b.importance) || 5) - (Number(a.importance) || 5))
    .slice(0, 10)
    .map((f) => String(f.finding || ''));
}

export function buildEffectiveSkillAnalysisText({
  dim,
  analysisText,
  keyFindings,
  distilled,
}: {
  dim: GenerateSkillDimension;
  analysisText: string;
  keyFindings: string[];
  distilled?: { toolCallSummary?: Array<string | { tool?: string; summary?: string }> } | null;
}) {
  if (analysisText.trim().length >= 100 || keyFindings.length === 0) {
    return analysisText;
  }

  const synthesized = [
    `## ${dim.label || dim.id}`,
    '',
    analysisText.trim(),
    '',
    '## 关键发现',
    '',
    ...keyFindings.map((f: string, i: number) => `${i + 1}. ${f}`),
  ];
  if ((distilled?.toolCallSummary?.length ?? 0) > 0) {
    synthesized.push('', '## 探索记录', '');
    for (const s of (distilled?.toolCallSummary ?? []).slice(0, 10)) {
      synthesized.push(`- ${formatToolCallSummary(s)}`);
    }
  }
  const effectiveText = synthesized.join('\n');
  logger.info(
    `[generate] Skill "${dim.id}": analysisText too short (${analysisText.trim().length} chars), ` +
      `synthesized from ${keyFindings.length} findings → ${effectiveText.length} chars`
  );
  return effectiveText;
}

function formatToolCallSummary(summary: string | { tool?: string; summary?: string }) {
  if (typeof summary === 'string') {
    return summary;
  }
  return [summary.tool, summary.summary].filter(Boolean).join(': ') || 'unknown tool call';
}

// ---------------------------------------------------------------------------
// Tier reflection consumer
// ---------------------------------------------------------------------------

export interface ConsumeGenerateTierReflectionOptions {
  tierIndex: number;
  tierResults: Map<string, DimensionStat>;
  sessionStore: SessionStore;
}

export interface GenerateTierReflection {
  tierIndex: number;
  completedDimensions: string[];
  topFindings: Array<Record<string, unknown>>;
  crossDimensionPatterns: string[];
  suggestionsForNextTier: string[];
}

export function consumeGenerateTierReflection({
  tierIndex,
  tierResults,
  sessionStore,
}: ConsumeGenerateTierReflectionOptions): GenerateTierReflection | null {
  const tierStats = [...tierResults.values()];
  const totalCandidates = tierStats.reduce((s, r) => s + (r.candidateCount || 0), 0);
  logger.info(
    `[generate] Tier ${tierIndex + 1} complete: ${tierResults.size} dimensions, ${totalCandidates} candidates`
  );

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- SessionStore structurally compatible
    const reflection = buildTierReflection(
      tierIndex,
      tierResults as Parameters<typeof buildTierReflection>[1],
      sessionStore as Parameters<typeof buildTierReflection>[2]
    );
    sessionStore.addTierReflection(
      tierIndex,
      reflection as Parameters<typeof sessionStore.addTierReflection>[1]
    );
    logger.info(
      `[generate] Tier ${tierIndex + 1} reflection: ` +
        `${reflection.topFindings.length} top findings, ` +
        `${reflection.crossDimensionPatterns.length} patterns`
    );
    return reflection as GenerateTierReflection;
  } catch (refErr: unknown) {
    logger.warn(
      `[generate] Tier ${tierIndex + 1} reflection failed: ${refErr instanceof Error ? refErr.message : String(refErr)}`
    );
    return null;
  }
}
