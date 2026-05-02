import type { MemoryCoordinator } from '#agent/memory/MemoryCoordinator.js';
import type { SessionStore } from '#agent/memory/SessionStore.js';
import type { AgentRunResult } from '#agent/service/index.js';
import Logger from '#infra/logging/Logger.js';
import type { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import {
  type AgentResultLike,
  type BootstrapDimensionAnalysisReport,
  type BootstrapDimensionProducerResult,
  type BootstrapDimensionProjection,
  type BootstrapSessionProjection,
  type DimensionFinding,
  normalizeDimensionFindings,
  projectBootstrapSessionResult,
  type ToolCallRecord,
} from '#workflows/capabilities/execution/internal-agent/BootstrapProjections.js';
import {
  type DimensionContext,
  parseDimensionDigest,
} from '#workflows/capabilities/execution/internal-agent/context/DimensionContext.js';
import { generateSkill } from '#workflows/capabilities/execution/WorkflowSkillCompletionCapability.js';
import { saveDimensionCheckpoint } from '#workflows/capabilities/persistence/DimensionCheckpoint.js';
import { buildTierReflection } from '#workflows/capabilities/planning/dimensions/bootstrapDimensionConfigs.js';

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
    const tokenStore = ctx.container?.get?.('tokenUsageStore') as TokenUsageStoreLike | undefined;
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
        const realtime = ctx.container?.get?.('realtimeService') as RealtimeServiceLike | undefined;
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
      if (toolName !== 'submit_knowledge' && toolName !== 'submit_with_check') {
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
  const { CodeEntityGraph } = await import('#service/knowledge/CodeEntityGraph.js');
  return CodeEntityGraph as CodeEntityGraphConstructor;
}

// ---------------------------------------------------------------------------
// Skill consumer
// ---------------------------------------------------------------------------

export interface SkillResults {
  created: number;
  failed: number;
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
  shouldAbort?: () => boolean;
  generateSkillFn?: GenerateSkillFn;
}

export async function consumeBootstrapSkills({
  ctx,
  dimensions,
  dimensionCandidates,
  sessionStore,
  emitter,
  shouldAbort,
  generateSkillFn = generateSkill,
}: ConsumeBootstrapSkillsOptions): Promise<SkillResults> {
  const skillResults: SkillResults = { created: 0, failed: 0, skills: [], errors: [] };

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
  skillResults,
  generateSkillFn,
}: {
  ctx: Parameters<GenerateSkillFn>[0];
  dim: BootstrapSkillDimension;
  dimData: DimensionCandidateData;
  sessionStore: SessionStore;
  emitter: BootstrapEventEmitter;
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
      skillResults.created++;
      skillResults.skills.push(result.skillName);
      emitter.emitDimensionComplete(dim.id, {
        type: 'skill',
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
