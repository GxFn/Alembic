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
import type { AgentEfficiencySummary } from '#service/bootstrap/BootstrapEfficiency.js';
import type { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import {
  type AgentResultLike,
  type BootstrapDimensionAnalysisReport,
  type BootstrapDimensionProducerResult,
  type BootstrapDimensionProjection,
  type BootstrapDimensionRunIssue,
  type BootstrapSessionProjection,
  type DimensionFinding,
  isRecoverableProducerTimeoutIssue,
  normalizeDimensionFindings,
  projectBootstrapSessionResult,
  resolveBootstrapDimensionRunIssue,
  type ToolCallRecord,
} from '#workflows/capabilities/execution/internal-agent/BootstrapProjections.js';
import {
  type DimensionContext,
  parseDimensionDigest,
} from '#workflows/capabilities/execution/internal-agent/DimensionContext.js';
import {
  generateSkill,
  type WorkflowSkillGenerationResult,
} from '#workflows/capabilities/execution/WorkflowSkillCompletionCapability.js';
import {
  buildPcvN11ProduceEvidence,
  buildPcvN12ConsumerPersistenceEvidence,
  buildPcvN12ErrorEvidence,
  mergeBootstrapPcvNodeEvidence,
  type PcvSourceRefValidationContext,
  successfulProducerSubmitCalls,
} from './BootstrapPcvNodeLocalEvidence.js';

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
  sourceRefValidation?: PcvSourceRefValidationContext | null;
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
  sourceRefValidation,
}: ConsumeBootstrapDimensionResultOptions): Promise<DimensionStat> {
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
  const rawRunIssue = resolveBootstrapDimensionRunIssue(runResult);
  const recoveredProducerTimeout = isRecoverableProducerTimeoutIssue({
    issue: rawRunIssue,
    needsCandidates,
    produceResult,
    successCount,
  });
  const runIssue = recoveredProducerTimeout ? null : rawRunIssue;
  if (recoveredProducerTimeout) {
    logger.warn(
      `[Producer] "${dimId}": producer summary timed out after ${successCount} successful candidate submit(s); preserving produced candidates as dimension output.`
    );
  }
  const isNormalCompletion = !runIssue;
  const effectiveCandidateCount = isNormalCompletion ? producerResult.candidateCount : 0;

  candidateResults.created += effectiveCandidateCount;
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

    if (successCount === 0 && submitCalls.length === 0 && isNormalCompletion) {
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
  if (runIssue) {
    logger.warn(`[Insight-v3] Dimension "${dimId}" completed with non-normal status`, {
      dimension: dimId,
      status: runIssue.status,
      reason: runIssue.reason,
      degraded: runResult?.degraded || runResult?.diagnostics?.degraded || false,
    });
  }

  logger.info(
    `[Insight-v3] Dimension "${dimId}": analysis=${analysisReport.analysisText.length} chars, ` +
      `files=${analysisReport.referencedFiles.length}, findings=${(analysisReport.findings || distilled.keyFindings).length}, ` +
      `toolCalls=${runtimeToolCalls.length}, degraded=${runResult?.degraded || false} (${Date.now() - dimStartTime}ms)`
  );

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

  for (const tc of isNormalCompletion ? submitCalls : []) {
    if (!isSuccessfulToolCall(tc)) {
      continue;
    }
    const params = extractSubmitParams(tc);
    const result = isRecord(tc.result) ? tc.result : {};
    const candidateSummary = {
      title: pickString(params.title) || pickString(result.title),
      subTopic: pickString(params.category) || pickString(params.knowledgeType) || dimId,
      summary: pickString(params.summary) || pickString(params.description),
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

  emitter.emitDimensionComplete(dimId, {
    type: needsCandidates ? 'candidate' : 'skill',
    extracted: effectiveCandidateCount,
    created: effectiveCandidateCount,
    status: runIssue?.status || 'v3-pipeline-complete',
    reason: runIssue?.reason,
    degraded: runResult?.degraded || false,
    durationMs: Date.now() - dimStartTime,
    toolCallCount: runtimeToolCalls.length,
    tokenUsage: combinedTokenUsage,
    efficiency,
    source: 'enhanced-pipeline-strategy',
  } as Parameters<BootstrapEventEmitter['emitDimensionComplete']>[1]);

  const qualityScores = (artifact as Record<string, unknown>).qualityReport as
    | { scores: Record<string, number>; totalScore: number; suggestions: string[] }
    | undefined;
  const pcvNodeEvidence = mergeBootstrapPcvNodeEvidence(dimensionStats[dimId]?.pcvNodeEvidence, {
    n11: buildPcvN11ProduceEvidence({ dimId, needsCandidates, projection, sourceRefValidation }),
    n12: buildPcvN12ConsumerPersistenceEvidence({
      acceptedSubmitCalls: isNormalCompletion ? successfulProducerSubmitCalls(projection) : [],
      dimId,
      runIssueReason: runIssue?.reason || null,
      sessionStore,
    }),
  });
  const dimResult = {
    status: runIssue?.status || 'v3-pipeline-complete',
    candidateCount: effectiveCandidateCount,
    rejectedCount: isNormalCompletion ? producerResult.rejectedCount || 0 : submitCalls.length,
    analysisChars: analysisReport.analysisText.length,
    referencedFiles: analysisReport.referencedFiles.length,
    durationMs: Date.now() - dimStartTime,
    toolCallCount: runtimeToolCalls.length,
    tokenUsage: combinedTokenUsage,
    efficiency,
    diagnostics: runResult.diagnostics || null,
    error: runIssue?.reason,
    recoveredProducerTimeout,
    pcvNodeEvidence,
    stages: summarizeDimensionStages(runResult),
    analysisText: analysisReport.analysisText,
    referencedFilesList: analysisReport.referencedFiles || [],
    qualityGate: qualityScores
      ? {
          totalScore: qualityScores.totalScore,
          scores: qualityScores.scores,
          action:
            runIssue?.status || gateResult?.action || (runResult?.degraded ? 'degrade' : 'pass'),
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

function extractSubmitParams(tc: ToolCallRecord): Record<string, unknown> {
  const rawArgs = tc.params || tc.args || {};
  const nestedParams = rawArgs.params;
  return isRecord(nestedParams) ? nestedParams : rawArgs;
}

function isSuccessfulToolCall(tc: ToolCallRecord): boolean {
  const res = tc.result;
  if (!res) {
    return true;
  }
  if (typeof res === 'string') {
    return !res.includes('rejected') && !res.includes('error');
  }
  if (!isRecord(res)) {
    return true;
  }
  if (res.error || res.submitted === false) {
    return false;
  }
  return res.status !== 'rejected' && res.status !== 'error';
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
  const issue = normalizeBootstrapDimensionError(err);
  const errMsg = issue.reason;
  logger.error(`[Insight-v3] Dimension "${dimId}" failed: ${errMsg}`);
  candidateResults.errors.push({ dimId, error: errMsg });
  emitter.emitDimensionComplete(dimId, {
    type: 'error',
    status: issue.status,
    reason: errMsg,
  } as Parameters<BootstrapEventEmitter['emitDimensionComplete']>[1]);
  const dimResult = {
    status: issue.status,
    candidateCount: 0,
    durationMs: 0,
    error: errMsg,
    diagnostics: issue.diagnostics || null,
    pcvNodeEvidence: mergeBootstrapPcvNodeEvidence(dimensionStats[dimId]?.pcvNodeEvidence, {
      n12: buildPcvN12ErrorEvidence({ dimId, error: errMsg }),
    }),
  };
  dimensionStats[dimId] = dimResult;
  return dimResult;
}

function normalizeBootstrapDimensionError(err: unknown): BootstrapDimensionRunIssue {
  if (isBootstrapDimensionRunIssue(err)) {
    return err;
  }
  return {
    status: 'error',
    reason: err instanceof Error ? err.message : String(err),
  };
}

function isBootstrapDimensionRunIssue(value: unknown): value is BootstrapDimensionRunIssue {
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

export interface ConsumeBootstrapSessionResultOptions {
  parentRunResult: AgentRunResult;
  activeDimIds: string[];
  skippedDimIds: string[];
  durationMs: number;
  sessionStore: SessionStore;
  dimensionStats: Record<string, DimensionStat>;
  consumeMissingDimension: (dimId: string) => void;
}

export function consumeBootstrapSessionResult({
  parentRunResult,
  activeDimIds,
  skippedDimIds,
  durationMs,
  sessionStore,
  dimensionStats,
  consumeMissingDimension,
}: ConsumeBootstrapSessionResultOptions): BootstrapSessionProjection {
  const projection = projectBootstrapSessionResult({
    parentRunResult,
    activeDimIds,
    skippedDimIds,
  });
  consumeMissingBootstrapDimensions({
    missingDimensionIds: projection.missingDimensionIds,
    dimensionStats,
    consumeMissingDimension,
  });
  logger.info(
    `[Insight-v3] All tiers complete: ${projection.completedDimensions} dimensions in ${durationMs}ms`
  );
  if (
    projection.parentStatus !== 'success' ||
    projection.failedDimensionIds.length > 0 ||
    projection.abortedDimensionIds.length > 0
  ) {
    logger.warn(
      `[Insight-v3] Bootstrap session completed with ${projection.failedDimensionIds.length} failed, ${projection.abortedDimensionIds.length} aborted dimensions (status=${projection.parentStatus})`
    );
  }
  if (projection.missingDimensionIds.length > 0) {
    logger.warn(
      `[Insight-v3] Bootstrap session missing dimension results: [${projection.missingDimensionIds.join(', ')}]`
    );
  }

  const emStats = sessionStore.getStats();
  logger.info(
    `[Insight-v3] Memory stats: ${emStats.completedDimensions} dims, ` +
      `${emStats.totalFindings} findings, ${emStats.referencedFiles} files, ` +
      `${emStats.crossReferences} cross-refs, ${emStats.tierReflections} reflections`
  );
  if (emStats.cache) {
    logger.info(
      `[Insight-v3] Cache stats: ${emStats.cache.hitRate} hit rate, ` +
        `${emStats.cache.searchCacheSize} searches, ${emStats.cache.fileCacheSize} files`
    );
  }
  return projection;
}

export function consumeMissingBootstrapDimensions({
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
// Candidate relation consumer
// ---------------------------------------------------------------------------

export interface BootstrapCandidateRelation {
  title: unknown;
  relations: unknown;
}

interface CodeEntityGraphLike {
  populateFromCandidateRelations(
    candidates: BootstrapCandidateRelation[]
  ): Promise<{ edgesCreated: number; durationMs: number }>;
}

type CodeEntityGraphConstructor = new (
  entityRepo: unknown,
  edgeRepo: unknown,
  options: { projectRoot: string; logger: typeof logger }
) => CodeEntityGraphLike;

export interface ConsumeBootstrapCandidateRelationsOptions {
  ctx: { container: { get(name: string): unknown } };
  projectRoot: string;
  dimensionCandidates: Record<string, DimensionCandidateData>;
  getCodeEntityGraphClass?: () => Promise<CodeEntityGraphConstructor>;
}

export async function consumeBootstrapCandidateRelations({
  ctx,
  projectRoot,
  dimensionCandidates,
  getCodeEntityGraphClass = defaultGetCodeEntityGraphClass,
}: ConsumeBootstrapCandidateRelationsOptions) {
  try {
    const entityRepo = ctx.container.get('codeEntityRepository');
    const edgeRepo = ctx.container.get('knowledgeEdgeRepository');
    if (!entityRepo || !edgeRepo) {
      return null;
    }

    const allCandidates = extractBootstrapCandidateRelations(dimensionCandidates);
    if (allCandidates.length === 0) {
      return null;
    }

    const CodeEntityGraph = await getCodeEntityGraphClass();
    const graph = new CodeEntityGraph(entityRepo, edgeRepo, { projectRoot, logger });
    const relResult = await graph.populateFromCandidateRelations(allCandidates);
    logger.info(
      `[Insight-v3] Code Entity Graph relations: ${relResult.edgesCreated} edges from ${allCandidates.length} candidates (${relResult.durationMs}ms)`
    );
    return {
      ...relResult,
      candidates: allCandidates.length,
    };
  } catch (cegErr: unknown) {
    logger.warn(
      `[Insight-v3] Code Entity Graph relations failed (non-blocking): ${cegErr instanceof Error ? cegErr.message : String(cegErr)}`
    );
    return null;
  }
}

export function extractBootstrapCandidateRelations(
  dimensionCandidates: Record<string, DimensionCandidateData>
): BootstrapCandidateRelation[] {
  const allCandidates: BootstrapCandidateRelation[] = [];
  for (const dimData of Object.values(dimensionCandidates)) {
    const toolCalls = dimData?.producerResult?.toolCalls || [];
    for (const toolCall of toolCalls) {
      const toolName = toolCall.tool || toolCall.name;
      if (toolName !== 'knowledge') {
        continue;
      }
      const params = toolCall.params || toolCall.args || {};
      if (params.title) {
        allCandidates.push({
          title: params.title,
          relations: params.relations || null,
        });
      }
    }
  }
  return allCandidates;
}

async function defaultGetCodeEntityGraphClass() {
  const { CodeEntityGraph } = await import('@alembic/core/knowledge');
  return CodeEntityGraph as CodeEntityGraphConstructor;
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

export interface BootstrapSkillDimension {
  id: string;
  label?: string;
  skillWorthy?: boolean;
  skillMeta?: { name?: string; description?: string } | null;
}

type GenerateSkillFn = typeof generateSkill;

export interface ConsumeBootstrapSkillsOptions {
  ctx: Parameters<GenerateSkillFn>[0];
  dimensions: BootstrapSkillDimension[];
  dimensionCandidates: Record<string, DimensionCandidateData>;
  sessionStore: SessionStore;
  emitter: BootstrapEventEmitter;
  sessionId?: string;
  shouldAbort?: () => boolean;
  generateSkillFn?: GenerateSkillFn;
}

export async function consumeBootstrapSkills({
  ctx,
  dimensions,
  dimensionCandidates,
  sessionStore,
  emitter,
  sessionId,
  shouldAbort,
  generateSkillFn = generateSkill,
}: ConsumeBootstrapSkillsOptions): Promise<SkillResults> {
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
      `[Insight-v3] Skill generation module import failed: ${e instanceof Error ? e.message : String(e)}`
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
  dim: BootstrapSkillDimension;
  dimData: DimensionCandidateData;
  sessionStore: SessionStore;
  emitter: BootstrapEventEmitter;
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
    logger.warn(`[Insight-v3] Skill generation failed for "${dim.id}": ${errMsg}`);
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
  dim: BootstrapSkillDimension;
  emitter: BootstrapEventEmitter;
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
    emitter as { emitProcessEvents?: BootstrapEventEmitter['emitProcessEvents'] }
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
  dim: BootstrapSkillDimension;
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
    `[Insight-v3] Skill "${dim.id}": analysisText too short (${analysisText.trim().length} chars), ` +
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

export interface ConsumeBootstrapTierReflectionOptions {
  tierIndex: number;
  tierResults: Map<string, DimensionStat>;
  sessionStore: SessionStore;
}

export interface BootstrapTierReflection {
  tierIndex: number;
  completedDimensions: string[];
  topFindings: Array<Record<string, unknown>>;
  crossDimensionPatterns: string[];
  suggestionsForNextTier: string[];
}

export function consumeBootstrapTierReflection({
  tierIndex,
  tierResults,
  sessionStore,
}: ConsumeBootstrapTierReflectionOptions): BootstrapTierReflection | null {
  const tierStats = [...tierResults.values()];
  const totalCandidates = tierStats.reduce((s, r) => s + (r.candidateCount || 0), 0);
  logger.info(
    `[Insight-v3] Tier ${tierIndex + 1} complete: ${tierResults.size} dimensions, ${totalCandidates} candidates`
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
      `[Insight-v3] Tier ${tierIndex + 1} reflection: ` +
        `${reflection.topFindings.length} top findings, ` +
        `${reflection.crossDimensionPatterns.length} patterns`
    );
    return reflection as BootstrapTierReflection;
  } catch (refErr: unknown) {
    logger.warn(
      `[Insight-v3] Tier ${tierIndex + 1} reflection failed: ${refErr instanceof Error ? refErr.message : String(refErr)}`
    );
    return null;
  }
}
