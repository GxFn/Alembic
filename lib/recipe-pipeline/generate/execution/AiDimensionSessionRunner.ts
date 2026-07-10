import type { AgentRunResult, AgentService, SystemRunContextFactory } from '@alembic/agent/service';
import { TierScheduler } from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
import type { DimensionDef } from '@alembic/core/types';
import {
  prepareGenerateRescanState,
  projectGenerateDimensionSeedTitles,
  seedGenerateDedupFromKnowledgeBase,
} from '../dedup/GenerateDedupSeeder.js';
import {
  buildGenerateDimensionResultProcessEvents,
  buildGenerateTierReflectionProcessEvents,
} from './AgentRunProcessEvents.js';
import {
  projectAgentRunResult,
  projectGenerateDimensionAgentOutput,
} from './AgentRunProjections.js';
import type { AiDimensionPreparation } from './AiDimensionPreparation.js';
import {
  applyGenerateDimensionAdmissions,
  type GenerateDimensionAdmissionResult,
  resolveGenerateDimensionAdmissions,
} from './DimensionAdmission.js';
import {
  createGenerateDimensionRuntimeInput,
  type GenerateDimensionPlan,
  resolveGenerateDimensionPlan as resolveBootstrapDimensionPlanData,
} from './DimensionRuntimeBuilder.js';
import {
  type CandidateResults,
  consumeGenerateDimensionError as consumeBootstrapDimensionErrorSideEffects,
  consumeGenerateSessionResult as consumeBootstrapSessionResultSideEffects,
  consumeGenerateDimensionResult,
  consumeGenerateTierReflection,
  type DimensionCandidateData,
  type DimensionStat,
} from './GenerateConsumers.js';
import type { initializeGenerateRuntime } from './RuntimeInitializer.js';
import { buildGenerateSessionExecutionInput } from './SessionExecutionBuilder.js';

const logger = Logger.getInstance();

type AiDimensionRuntime = Awaited<ReturnType<typeof initializeGenerateRuntime>>;

export interface AiDimensionSessionResult {
  activeDimIds: string[];
  incrementalSkippedDims: string[];
  skippedDims: string[];
  candidateResults: CandidateResults;
  dimensionCandidates: Record<string, DimensionCandidateData>;
  dimensionStats: Record<string, DimensionStat>;
  bootstrapDedup: { count: number; clear(): void };
  admissions: GenerateDimensionAdmissionResult;
  enableParallel: boolean;
  concurrency: number;
}

export async function runAiDimensionSession({
  preparation,
  runtime,
}: {
  preparation: AiDimensionPreparation;
  runtime: AiDimensionRuntime;
}): Promise<AiDimensionSessionResult> {
  const services = resolveAiDimensionServices(preparation);

  const { enableParallel, concurrency } = resolveAiDimensionConcurrency();
  const groundingEnforcement = resolveGenerateGroundingEnforcement();
  const scheduler = new TierScheduler();
  const activeDimIds = preparation.dimensions.map((dimension: DimensionDef) => dimension.id);
  const {
    globalSubmittedTitles,
    globalSubmittedPatterns,
    globalSubmittedTriggers,
    bootstrapDedup,
    rescanContext,
  } = prepareGenerateRescanState({
    existingRecipes: preparation.existingRecipes,
    evolutionPrescreen: preparation.evolutionPrescreen,
    executionDecisions: preparation.rescanExecutionDecisions,
  });
  // W1（结构清洗）：查重播种单源化——bootstrap 无 rescan 上下文时从知识库播种，
  // 逻辑与三态留痕在 dedup/GenerateDedupSeeder（M1b 语义不变，rescan 在场即跳过）。
  const dedupSeedByDim = rescanContext
    ? null
    : await seedGenerateDedupFromKnowledgeBase(
        { globalSubmittedTitles, globalSubmittedTriggers },
        (preparation.ctx as unknown as { container?: { get(name: string): unknown } }).container
      );
  const candidateResults: CandidateResults = { created: 0, failed: 0, errors: [] };
  const dimensionCandidates: Record<string, DimensionCandidateData> = {};
  const dimensionStats: Record<string, DimensionStat> = {};

  // G2(用户决策)：候选数量目标由 plan 按项目规模产出（totalRecipeBudget = f(scale)），折算为
  // per-dimension 建议区间注入 Producer——是引导而非硬限，最终条数由模型按实际发现自判（宁深勿多）。
  // 无 plan 投影（如 rescan 直跑）时不注入，Producer 走原有 findings 数目标。
  const planBudgetProjection = (
    preparation.view?.projectContextFacts?.report?.planSelectionProjection as
      | {
          budget?: { totalRecipeBudget?: number; dimensionBudgets?: Record<string, number> };
        }
      | undefined
  )?.budget;
  const planRecipeBudget = planBudgetProjection?.totalRecipeBudget;
  const planDimensionBudgets = planBudgetProjection?.dimensionBudgets;
  // P-3(2026-07-02)：优先用 plan 的 per-dimension 预算（按证据面分配，不抹平维度差异）；
  // 缺失时 fallback 均分。区间 = [max(2, 0.8×预算), 预算+1]，仍是引导非硬限。
  const resolveSuggestedRange = (dimId: string): { min: number; max: number } | null => {
    const perDim = planDimensionBudgets?.[dimId];
    if (typeof perDim === 'number' && perDim > 0) {
      return { min: Math.max(2, Math.floor(perDim * 0.8)), max: perDim + 1 };
    }
    if (typeof planRecipeBudget === 'number' && planRecipeBudget > 0 && activeDimIds.length > 0) {
      return {
        min: Math.max(2, Math.floor((planRecipeBudget / activeDimIds.length) * 0.6)),
        max: Math.max(3, Math.ceil(planRecipeBudget / activeDimIds.length)),
      };
    }
    return null;
  };
  // H4：建议区间注入可观测——数量问题排查时首先要能看到 plan 建议是否到位、数值多少。
  logger.info(
    `[generate] plan candidate suggestion: totalRecipeBudget=${planRecipeBudget ?? 'n/a'}, dims=${activeDimIds.length}, dimensionBudgets=${planDimensionBudgets ? JSON.stringify(planDimensionBudgets) : 'none'}`
  );

  const admissions = await resolveGenerateDimensionAdmissions({
    dataRoot: preparation.dataRoot,
    activeDimIds,
    isIncremental: preparation.isIncremental,
    incrementalPlan: preparation.incrementalPlan,
    rescanContext,
    dimContext: runtime.dimContext,
    sessionStore: runtime.sessionStore,
    emitter: preparation.emitter,
  });
  logger.info(
    `[generate] Active dimensions: [${activeDimIds.join(', ')}], concurrency=${enableParallel ? concurrency : 1}${preparation.isIncremental ? `, incremental skip: [${admissions.incrementalSkippedDims.join(', ')}]` : ''}`
  );
  applyGenerateDimensionAdmissions({
    admissions,
    sessionStore: runtime.sessionStore,
    dimensionStats,
    candidateResults,
    dimensionCandidates,
  });

  function resolveGenerateDimensionPlan(dimId: string) {
    return resolveBootstrapDimensionPlanData({
      dimId,
      dimensions: preparation.dimensions,
      rescanContext,
    });
  }

  // 决策④(2026-07-11):source_graph 证据进 AI prompt 的唯一分叉点。
  // 默认关(未设 ALEMBIC_SOURCE_GRAPH_EVIDENCE=1 → 传 null,生产 prompt 零变化);
  // eval A/B 对照(同维度两轮 rescan 开关对照)确认收益后再决定常开。
  const sourceGraphEvidenceEnabled = process.env.ALEMBIC_SOURCE_GRAPH_EVIDENCE === '1';
  if (sourceGraphEvidenceEnabled) {
    const durable = preparation.sourceGraphResult?.durableTables;
    logger.info(
      `[generate] source-graph evidence starters ENABLED (ALEMBIC_SOURCE_GRAPH_EVIDENCE=1): ` +
        `result=${preparation.sourceGraphResult ? preparation.sourceGraphResult.action : 'null(降级不注入)'} ` +
        `symbols=${durable?.source_graph_symbols ?? 0} edges=${durable?.source_graph_edges ?? 0}`
    );
  }

  function createBootstrapDimensionRunInput(dimId: string, plan: GenerateDimensionPlan) {
    return createGenerateDimensionRuntimeInput({
      dimId,
      plan,
      memoryCoordinator: runtime.memoryCoordinator,
      systemRunContextFactory: services.systemRunContextFactory,
      projectInfo: runtime.projectInfo,
      // R1: 锚点补齐的只读根边界（insightGate 用它把 findings 的 path:line 补成精确片段）
      projectRoot: preparation.projectRoot,
      // G2/P-3: plan 折算的本维度候选数量建议（per-dimension 预算优先，引导非硬限）
      suggestedCandidateRange: resolveSuggestedRange(dimId),
      primaryLang: preparation.primaryLang,
      dimContext: runtime.dimContext,
      sessionStore: runtime.sessionStore,
      semanticMemory: runtime.semanticMemory,
      projectGraph: runtime.projectGraph,
      panoramaResult: preparation.panoramaResult,
      astProjectSummary: preparation.astProjectSummary,
      guardAudit: preparation.guardAudit,
      depGraphData: preparation.depGraphData,
      callGraphResult: preparation.callGraphResult,
      // 决策④:开关关闭时恒 null(evidence starters 不感知 source_graph 的存在)。
      sourceGraphResult: sourceGraphEvidenceEnabled ? preparation.sourceGraphResult : null,
      rescanContext,
      targetFileMap: preparation.targetFileMap,
      globalSubmittedTitles,
      globalSubmittedPatterns,
      globalSubmittedTriggers,
      bootstrapDedup,
      sessionId: preparation.sessionId,
      allFiles: preparation.allFiles,
      projectScopeSourceIdentityMap: runtime.projectScopeSourceIdentityMap,
      sessionAbortSignal: preparation.sessionAbortSignal,
      // M1b：本维度已入库标题（bootstrap 播种；rescan 模式 §9a 已带同类信息，此处为 null）
      existingDimensionTitles: projectGenerateDimensionSeedTitles(dedupSeedByDim, dimId),
    });
  }

  async function consumeBootstrapDimensionAgentResult({
    dimId,
    plan,
    agentRunResult,
    dimStartTime,
    analystScopeId,
  }: {
    dimId: string;
    plan: NonNullable<ReturnType<typeof resolveGenerateDimensionPlan>>;
    agentRunResult: AgentRunResult;
    dimStartTime: number;
    analystScopeId: string;
  }) {
    const runResult = projectAgentRunResult(agentRunResult);
    const projection = projectGenerateDimensionAgentOutput({
      dimId,
      needsCandidates: plan.needsCandidates,
      runResult,
      projectScopeSourceIdentities: runtime.projectScopeSourceIdentities,
    });
    const processEvents = buildGenerateDimensionResultProcessEvents({
      dimId,
      label: plan.dimConfig.label || plan.dim.label || dimId,
      projection,
      runResult,
      sessionId: preparation.sessionId,
    });
    if (processEvents.length > 0) {
      preparation.emitter.emitProcessEvents({
        dimensionId: dimId,
        events: processEvents,
        sessionId: preparation.sessionId,
        source: 'bootstrap-dimension-result',
        targetName: plan.dimConfig.label || plan.dim.label || dimId,
        taskId: dimId,
      });
    }
    return consumeGenerateDimensionResult({
      ctx: preparation.ctx,
      dimId,
      dimConfig: plan.dimConfig,
      needsCandidates: plan.needsCandidates,
      projection,
      runResult,
      dimStartTime,
      analystScopeId,
      memoryCoordinator: runtime.memoryCoordinator,
      sessionStore: runtime.sessionStore,
      dimContext: runtime.dimContext,
      candidateResults,
      dimensionCandidates,
      dimensionStats,
      emitter: preparation.emitter,
      dataRoot: preparation.dataRoot,
      sessionId: preparation.sessionId,
      onDimensionResult: preparation.onDimensionResult,
    });
  }

  function consumeGenerateDimensionError({ dimId, err }: { dimId: string; err: unknown }) {
    return consumeBootstrapDimensionErrorSideEffects({
      dimId,
      err,
      candidateResults,
      dimensionStats,
      emitter: preparation.emitter,
    });
  }

  function consumeBootstrapSessionTierResult(
    tierIndex: number,
    tierResults: Map<string, DimensionStat>
  ) {
    const reflection = consumeGenerateTierReflection({
      tierIndex,
      tierResults,
      sessionStore: runtime.sessionStore,
    });
    if (reflection) {
      preparation.emitter.emitProcessEvents({
        events: buildGenerateTierReflectionProcessEvents({
          reflection,
          sessionId: preparation.sessionId,
        }),
        sessionId: preparation.sessionId,
        source: 'bootstrap-tier-reflection',
        targetName: `Tier ${tierIndex + 1}`,
      });
    }
    return reflection;
  }

  function consumeGenerateSessionResult({
    parentRunResult,
    durationMs,
  }: {
    parentRunResult: AgentRunResult;
    durationMs: number;
  }) {
    return consumeBootstrapSessionResultSideEffects({
      parentRunResult,
      activeDimIds,
      skippedDimIds: admissions.skippedDimIds,
      durationMs,
      sessionStore: runtime.sessionStore,
      dimensionStats,
      consumeMissingDimension: (dimId) =>
        consumeGenerateDimensionError({ dimId, err: 'missing child result' }),
    });
  }

  const { input: generateSessionInput } = buildGenerateSessionExecutionInput({
    sessionId: preparation.sessionId,
    activeDimIds,
    skippedDimIds: admissions.skippedDimIds,
    concurrency,
    primaryLang: preparation.primaryLang,
    projectLang: runtime.projectInfo.lang || null,
    sessionAbortSignal: preparation.sessionAbortSignal,
    groundingEnforcement,
    taskManager: preparation.taskManager,
    scheduler,
    dimensionStats,
    resolvePlan: resolveGenerateDimensionPlan,
    createDimensionRunInput: createBootstrapDimensionRunInput,
    emitDimensionStart: (dimId) => preparation.emitter.emitDimensionStart(dimId),
    consumeDimensionResult: consumeBootstrapDimensionAgentResult,
    consumeDimensionError: consumeGenerateDimensionError,
    consumeTierResult: consumeBootstrapSessionTierResult,
    emitProcessEvents: (payload) => preparation.emitter.emitProcessEvents(payload),
  });

  const startedAtMs = Date.now();
  logger.info('[generate] Bootstrap agent session run start', {
    sessionId: preparation.sessionId,
    activeDimIds,
    skippedDimIds: admissions.skippedDimIds,
    concurrency: enableParallel ? concurrency : 1,
    incremental: preparation.isIncremental,
  });
  let parentRunResult: AgentRunResult;
  try {
    parentRunResult = await services.agentService.run(generateSessionInput);
    logger.info('[generate] Bootstrap agent session run complete', {
      sessionId: preparation.sessionId,
      durationMs: Date.now() - startedAtMs,
      status: parentRunResult.status,
      profileId: parentRunResult.profileId,
      childResultCount: Object.keys(
        (parentRunResult.phases?.dimensionResults as Record<string, unknown> | undefined) || {}
      ).length,
      toolCallCount: parentRunResult.toolCalls.length,
      usage: parentRunResult.usage,
    });
  } catch (err: unknown) {
    logger.warn('[generate] Bootstrap agent session run failed', {
      sessionId: preparation.sessionId,
      durationMs: Date.now() - startedAtMs,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  consumeGenerateSessionResult({ parentRunResult, durationMs: Date.now() - startedAtMs });

  if (bootstrapDedup.count > 0) {
    logger.info(
      `[generate] GenerateDedup: ${bootstrapDedup.count} entries registered during session`
    );
  }

  return {
    activeDimIds,
    incrementalSkippedDims: admissions.incrementalSkippedDims,
    skippedDims: admissions.checkpointSkippedDims,
    candidateResults,
    dimensionCandidates,
    dimensionStats,
    bootstrapDedup,
    admissions,
    enableParallel,
    concurrency,
  };
}

export function resolveAiDimensionConcurrency(env: NodeJS.ProcessEnv = process.env) {
  const enableParallel = env.ALEMBIC_PARALLEL_BOOTSTRAP !== 'false';
  const rawConcurrency =
    env.ALEMBIC_PARALLEL_CONCURRENCY ?? env.ALEMBIC_BOOTSTRAP_CONCURRENCY ?? '3';
  const parsedConcurrency = Number.parseInt(rawConcurrency, 10);
  const configuredConcurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? Math.floor(parsedConcurrency) : 3;
  return {
    enableParallel,
    concurrency: enableParallel ? configuredConcurrency : 1,
  };
}

// AP-7：质量验证会话（PCVM/Test）per-invocation 显式开 grounding guard 的 opt-in 信号（PD6 真实消费者 + PD7
// per-invocation 粒度）。读 env ALEMBIC_GROUNDING_ENFORCEMENT：'guard'=恢复 analyze grounding 阻断+nudge+rollback；
// 'off'=显式 observe-only。未设或非法值 → undefined → 不覆盖、子运行回退 runtime 全局默认（observe-only），
// 普通 bootstrap/rescan/增量运行零可见行为变更。供 PCVM/Test 质量验证链路在发起 bootstrap 前设置该 env。
export function resolveGenerateGroundingEnforcement(
  env: NodeJS.ProcessEnv = process.env
): 'off' | 'guard' | undefined {
  const raw = env.ALEMBIC_GROUNDING_ENFORCEMENT;
  return raw === 'guard' || raw === 'off' ? raw : undefined;
}

function resolveAiDimensionServices(preparation: AiDimensionPreparation): {
  agentService: AgentService;
  systemRunContextFactory: SystemRunContextFactory;
} {
  if (!preparation.agentService || !preparation.systemRunContextFactory) {
    throw new Error('AI dimension pipeline requires AgentService and SystemRunContextFactory');
  }
  return {
    agentService: preparation.agentService,
    systemRunContextFactory: preparation.systemRunContextFactory,
  };
}
