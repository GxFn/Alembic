/**
 * KnowledgeRescanWorkflow — Alembic API AI 增量知识重扫
 *
 * 本文件由 Alembic API AI 配置驱动 AgentRuntime，在服务端自动完成知识补齐。
 *
 * 流程:
 *   1. snapshotRecipes — 快照保留知识
 *   2. rescanClean — 清理衍生缓存
 *   2.5 Recipe 文件 ↔ DB 一致性恢复 (SourceRefReconciler)
 *   3. Phase 1-4 全量分析 (ProjectContext facade)
 *   4. 覆盖分类 — RecipeImpactPlanner + SourceRef + lifecycle 三层评估
 *   5. 计算 gap 维度（需要补齐的维度）
 *   5.5 缓存 Phase 结果供复用 (SessionSupport)
 *   6. 快速返回骨架 → 异步 AI dimension execution 填充 gap 维度
 *   7. 前端通过 Socket.io 接收维度完成进度
 */

import { type AgentService, runEvolutionAudit, runModuleMining } from '@alembic/agent/service';
import {
  type EvolutionAuditRecipe as CoreEvolutionAuditRecipe,
  type EvolutionCandidatePlan,
  RecipeImpactPlanner,
  type RescanImpactSubmissionResult,
  submitRescanImpactDecisions,
  toEvolutionAuditRecipe,
} from '@alembic/core/evolution';
import {
  auditRecipesForRescan,
  buildCoverageLedgerModuleAxisFromSummaries,
  buildKnowledgeRescanPlan,
  buildKnowledgeRescanWorkflowPlan,
  buildRescanPrescreen,
  type CoverageLedgerCandidate,
  type CoverageLedgerModuleAxis,
  type CoverageLedgerWriteResult,
  createInternalKnowledgeRescanIntent as createKnowledgeRescanIntent,
  type InternalKnowledgeRescanArgs as KnowledgeRescanArgs,
  presentInternalKnowledgeRescanEmptyProject as presentKnowledgeRescanEmptyProject,
  projectHostAgentRescanEvidencePlan as projectKnowledgeRescanEvidencePlan,
  projectInternalRescanGapPlan as projectKnowledgeRescanGapPlan,
  projectInternalRescanPromptRecipes as projectKnowledgeRescanPromptRecipes,
  resolveModuleTier,
  resolvePerCellTargetDefault,
  runForceRescanCleanPolicy,
  runRescanCleanPolicy,
  syncKnowledgeStoreForRescan,
  writeCoverageLedgerForCompletion,
} from '@alembic/core/host-agent-workflows';
import { SourceRefReconciler } from '@alembic/core/knowledge';
import type { EvolutionCoverageLedgerRepository } from '@alembic/core/repositories';
import { applyTestDimensionFilter } from '@alembic/core/shared';
import type { DimensionDef, WorkflowDatabaseLike, WorkflowSkillHooks } from '@alembic/core/types';
import { CleanupService } from '#service/cleanup/CleanupService.js';
import { selectProjectIndexModuleMiningModules } from '../../daemon/ModuleMiningSelection.js';
import {
  attachProjectScopeSourceIdentitiesToView,
  buildProjectScopeAnalysisLogMeta,
  collectProjectScopeSourceIdentities,
  resolveProjectScopeAnalysisContext,
} from '../../project-scope/ProjectScopeAnalysis.js';
import {
  dispatchAiDimensionRuns,
  startAiDimensionSession,
} from '../ai-execution/AiDimensionDispatcher.js';
import { runAiDimensionPipelineForResult } from '../ai-execution/AiDimensionPipeline.js';
import { presentProjectContextRescanResponse } from '../project-context/ProjectContextPresenters.js';
import {
  buildProjectContextFillView,
  buildProjectContextMissionArtifacts,
  buildProjectContextWorkflowFacts,
  createProjectContextWorkflowSession,
  openOrReturnProjectContextWorkflowSession,
  type ProjectContextDimensionResultHookInput,
  type ProjectContextWorkflowFacts,
  registerProjectContextWorkflowSessionReleaseOnBootstrapCompletion,
  releaseProjectContextWorkflowSession,
  saveProjectContextFileSnapshot,
} from '../project-context/ProjectContextWorkflowFacts.js';
import {
  type ProjectIndexMcpContext,
  registerProjectIndexWorkflowImplementation,
  runProjectIndexWorkflow,
} from '../project-index/ProjectIndexWorkflow.js';
import {
  buildProduceSessionProjection,
  buildProduceSessionRoutePlan,
  readControllerProduceSessionRequest,
} from './ProduceSessionRoute.js';

type AgentEvolutionAuditRecipe = Parameters<typeof runEvolutionAudit>[0]['recipes'][number];
type EvolutionAuditResult = Awaited<ReturnType<typeof runEvolutionAudit>>;
type RescanCleanPolicyResult = Awaited<ReturnType<typeof runForceRescanCleanPolicy>>;
type SourceRefReconcileReport = Awaited<ReturnType<SourceRefReconciler['reconcile']>>;

type RescanMcpContext = ProjectIndexMcpContext;

interface KnowledgeRescanInlineFillSummary {
  coverageSkippedDimensions: number;
  coverageWrittenCells: number;
  newRecipesThisRound: number;
}

// ── Helpers ──────────────────────────────────────────

type SourceRefRepoT = InstanceType<
  typeof import('@alembic/core/repositories').RecipeSourceRefRepositoryImpl
>;
type KnowledgeRepoT = InstanceType<
  typeof import('@alembic/core/repositories').KnowledgeRepositoryImpl
>;

interface KnowledgeRepos {
  sourceRefRepo: SourceRefRepoT;
  knowledgeRepo: KnowledgeRepoT;
}

function toAgentEvolutionAuditRecipe(recipe: CoreEvolutionAuditRecipe): AgentEvolutionAuditRecipe {
  const content =
    recipe.content && typeof recipe.content === 'object'
      ? {
          markdown:
            typeof (recipe.content as { markdown?: unknown }).markdown === 'string'
              ? (recipe.content as { markdown: string }).markdown
              : undefined,
          rationale:
            typeof (recipe.content as { rationale?: unknown }).rationale === 'string'
              ? (recipe.content as { rationale: string }).rationale
              : undefined,
          coreCode:
            typeof (recipe.content as { coreCode?: unknown }).coreCode === 'string'
              ? (recipe.content as { coreCode: string }).coreCode
              : undefined,
        }
      : undefined;

  return {
    id: recipe.id,
    title: recipe.title,
    trigger: recipe.trigger,
    content,
    sourceRefs: recipe.sourceRefs,
    auditHint: null,
    impactEvidence: recipe.impactEvidence,
  };
}

function resolveKnowledgeRepos(container: { get(name: string): unknown }): KnowledgeRepos | null {
  const sourceRefRepo = container.get('recipeSourceRefRepository');
  const knowledgeRepo = container.get('knowledgeRepository');
  if (!sourceRefRepo || !knowledgeRepo) {
    return null;
  }
  return {
    sourceRefRepo: sourceRefRepo as SourceRefRepoT,
    knowledgeRepo: knowledgeRepo as KnowledgeRepoT,
  };
}

function countImpactProposalOutcomes(result: RescanImpactSubmissionResult | null): number {
  if (!result) {
    return 0;
  }
  return result.results.filter(
    (r) => r.outcome === 'proposal-created' || r.outcome === 'proposal-upgraded'
  ).length;
}

function countImpactImmediateDeprecations(result: RescanImpactSubmissionResult | null): number {
  if (!result) {
    return 0;
  }
  return result.results.filter(
    (r) => r.action === 'deprecate' && r.outcome === 'immediately-executed'
  ).length;
}

// ── 主入口 ──────────────────────────────────────────────

/**
 * rescanKnowledge — Alembic API AI 知识重扫
 *
 * 同步返回骨架（含 audit 摘要 + 异步会话 ID），
 * 后台通过 AI dimension execution 对 gap 维度执行 AI 补齐。
 */
export async function runKnowledgeRescanWorkflow(ctx: RescanMcpContext, args: KnowledgeRescanArgs) {
  return runProjectIndexWorkflow(ctx, args, { mode: 'incremental' });
}

async function runKnowledgeRescanProjectIndexWorkflow(
  ctx: RescanMcpContext,
  args: KnowledgeRescanArgs
) {
  const t0 = Date.now();
  const analysisScope = resolveProjectScopeAnalysisContext(ctx.container);
  const { dataRoot, projectRoot } = analysisScope;
  const db = ctx.container.get('database');
  const intent = createKnowledgeRescanIntent(args);
  const miningMode = knowledgeRescanMiningModeArg(args.miningMode);
  const runInternalFillInline = shouldRunInternalRescanFillInline(args);
  let inlineFillSummary: KnowledgeRescanInlineFillSummary | null = null;
  const plan = buildKnowledgeRescanWorkflowPlan({ intent, projectRoot, dataRoot });
  ctx.logger.info(
    '[KnowledgeRescanWorkflow] ProjectScope analysis context resolved',
    buildProjectScopeAnalysisLogMeta(analysisScope)
  );

  // ═══════════════════════════════════════════════════════════
  // Step 0: 清理策略（根据 intent 决定）
  // ═══════════════════════════════════════════════════════════

  let recipeSnapshot: RescanCleanPolicyResult['recipeSnapshot'];
  let cleanResult: RescanCleanPolicyResult['cleanResult'];

  if (intent.cleanupPolicy === 'force-rescan') {
    const result = await runForceRescanCleanPolicy({
      projectRoot: plan.cleanup.projectRoot,
      dataRoot,
      db,
      logger: ctx.logger,
      createCleanupService,
    });
    recipeSnapshot = result.recipeSnapshot;
    cleanResult = result.cleanResult;
  } else if (intent.cleanupPolicy === 'rescan-clean') {
    const result = await runRescanCleanPolicy({
      projectRoot: plan.cleanup.projectRoot,
      dataRoot,
      db,
      logger: ctx.logger,
      createCleanupService,
    });
    recipeSnapshot = result.recipeSnapshot;
    cleanResult = result.cleanResult;
  } else {
    const cleanupService = new CleanupService({
      projectRoot: plan.cleanup.projectRoot,
      dataRoot,
      db,
      logger: ctx.logger,
    });
    recipeSnapshot = await cleanupService.snapshotRecipes();
    cleanResult = {
      deletedFiles: 0,
      clearedTables: [],
      preservedRecipes: recipeSnapshot.count,
      errors: [],
    };
  }

  ctx.logger.info(`[KnowledgeRescanWorkflow] Preserved ${recipeSnapshot.count} recipes`, {
    cleanupPolicy: intent.cleanupPolicy,
    coverageByDimension: recipeSnapshot.coverageByDimension,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 0.5: Recipe 文件 ↔ DB 一致性恢复
  // ═══════════════════════════════════════════════════════════

  syncKnowledgeStoreForRescan({
    container: ctx.container,
    db,
    logger: ctx.logger,
    logPrefix: 'KnowledgeRescanWorkflow',
  });

  // ═══════════════════════════════════════════════════════════
  // Step 1: Phase 1-4 项目分析（含增量 diff 计算）
  // ═══════════════════════════════════════════════════════════

  const projectContextFacts = await buildProjectContextWorkflowFacts({
    analysisScope,
    projectRoot: plan.projectAnalysis.projectRoot,
    contentMaxLines: intent.projectAnalysis.contentMaxLines,
    ctx,
    maxFiles: intent.projectAnalysis.maxFiles,
    source: 'alembic-main-rescan',
  });

  if (projectContextFacts.isEmpty) {
    return presentKnowledgeRescanEmptyProject({ responseTimeMs: Date.now() - t0 });
  }

  const {
    allFiles,
    primaryLang,
    dimensions: allDimensions,
    incrementalPlan: _incrementalPlan,
  } = projectContextFacts;

  // ═══════════════════════════════════════════════════════════
  // Step 1.5: SourceRef 校验 + ProjectScope 反向清理
  // ═══════════════════════════════════════════════════════════

  const sourceIdentities = collectProjectScopeSourceIdentities(projectContextFacts);
  let reconcileReport: SourceRefReconcileReport | null = null;
  try {
    const repos = resolveKnowledgeRepos(ctx.container);
    if (repos) {
      const signalBus = ctx.container.get('signalBus') as ConstructorParameters<
        typeof SourceRefReconciler
      >[3] extends { signalBus?: infer S }
        ? S
        : never;
      type SourceRefReconcilerOptions = NonNullable<
        ConstructorParameters<typeof SourceRefReconciler>[3]
      >;
      const sourceRefReconcilerOptions: SourceRefReconcilerOptions = {
        signalBus,
      };
      const reconciler = new SourceRefReconciler(
        projectRoot,
        repos.sourceRefRepo,
        repos.knowledgeRepo,
        sourceRefReconcilerOptions
      );
      reconcileReport = await reconciler.reconcile({ force: true });
      await reconciler.repairRenames();
      await reconciler.applyRepairs();
      ctx.logger.info('[KnowledgeRescanWorkflow] SourceRef reconcile complete', {
        active: reconcileReport.active,
        cleaned: reconcileReport.cleaned ?? 0,
        inserted: reconcileReport.inserted,
        projectScopeId: analysisScope.projectScopeId,
        sourceIdentities: sourceIdentities.length,
        stale: reconcileReport.stale,
      });
    }
  } catch (err: unknown) {
    ctx.logger.warn('[KnowledgeRescanWorkflow] SourceRef reconcile failed, continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Step 2: 构建进化候选（基于增量 diff）
  // ═══════════════════════════════════════════════════════════

  let candidatePlan: EvolutionCandidatePlan | null = null;
  try {
    const repos = resolveKnowledgeRepos(ctx.container);
    if (repos) {
      const diff = _incrementalPlan?.diff ?? null;
      const impactPlanner = new RecipeImpactPlanner(
        projectRoot,
        repos.sourceRefRepo,
        repos.knowledgeRepo
      );
      candidatePlan = await impactPlanner.plan(diff);
      ctx.logger.info('[KnowledgeRescanWorkflow] Impact planning complete', candidatePlan.summary);
    }
  } catch (err: unknown) {
    ctx.logger.warn('[KnowledgeRescanWorkflow] Impact planning failed, continuing', {
      error: (err as Error).message,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Step 3: Evolution Agent 验证
  // ═══════════════════════════════════════════════════════════

  let impactSubmissionResult: RescanImpactSubmissionResult | null = null;
  let evolutionAuditResult: EvolutionAuditResult | null = null;
  if (candidatePlan && candidatePlan.candidates.length > 0) {
    try {
      const gateway = ctx.container.get('evolutionGateway') as Parameters<
        typeof submitRescanImpactDecisions
      >[1];
      if (gateway) {
        impactSubmissionResult = await submitRescanImpactDecisions(candidatePlan, gateway, {
          source: 'rescan-evolution',
        });
        ctx.logger.info('[KnowledgeRescanWorkflow] Impact decisions submitted', {
          submitted: impactSubmissionResult.submitted,
          skipped: impactSubmissionResult.skipped,
          errors: impactSubmissionResult.errors.length,
          processedRecipeIds: impactSubmissionResult.processedRecipeIds,
        });
      }
    } catch (err: unknown) {
      ctx.logger.warn('[KnowledgeRescanWorkflow] Impact decision submission failed', {
        error: (err as Error).message,
      });
    }

    try {
      const agentService = ctx.container.get('agentService');
      const repos = resolveKnowledgeRepos(ctx.container);
      if (agentService && repos) {
        const preprocessedIds = new Set(impactSubmissionResult?.processedRecipeIds ?? []);
        const agentCandidates = candidatePlan.candidates.filter(
          (c) => !preprocessedIds.has(c.recipeId)
        );
        const auditRecipes = await Promise.all(
          agentCandidates.map((c) => toEvolutionAuditRecipe(c, repos.knowledgeRepo))
        );
        if (auditRecipes.length > 0) {
          evolutionAuditResult = await runEvolutionAudit({
            agentService: agentService as AgentService,
            recipes: auditRecipes.map(toAgentEvolutionAuditRecipe),
            projectOverview: {
              primaryLang: primaryLang || 'unknown',
              fileCount: allFiles.length,
              modules: projectContextFacts.presenterInput.modules.map(
                (module) => module.module.name
              ),
            },
            proposalSource: 'rescan-evolution',
          });
          ctx.logger.info('[KnowledgeRescanWorkflow] Evolution audit complete', {
            proposed: evolutionAuditResult.proposed,
            deprecated: evolutionAuditResult.deprecated,
            skipped: evolutionAuditResult.skipped,
            toolCalls: evolutionAuditResult.toolCalls,
          });
        } else {
          ctx.logger.info(
            '[KnowledgeRescanWorkflow] Evolution audit skipped — impact decisions covered all candidates'
          );
        }
      }
    } catch (err: unknown) {
      ctx.logger.warn('[KnowledgeRescanWorkflow] Evolution audit failed', {
        error: (err as Error).message,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Step 4: Recipe 证据验证 + 快速衰退（保留用于 gap analysis）
  // ═══════════════════════════════════════════════════════════

  const rawAuditSummary = await auditRecipesForRescan({
    container: ctx.container,
    logger: ctx.logger,
    recipeEntries: recipeSnapshot.entries,
    allFiles,
    projectRoot,
    candidatePlan,
  });
  const auditSummary = {
    ...rawAuditSummary,
    proposalsCreated:
      rawAuditSummary.proposalsCreated +
      countImpactProposalOutcomes(impactSubmissionResult) +
      (evolutionAuditResult?.proposed ?? 0),
    immediateDeprecated:
      rawAuditSummary.immediateDeprecated +
      countImpactImmediateDeprecations(impactSubmissionResult) +
      (evolutionAuditResult?.deprecated ?? 0),
  };
  const miningPlanOptions = buildKnowledgeRescanMiningPlanOptions({
    args,
    ctx,
    miningMode,
    projectContextFacts,
    projectRoot,
  });

  ctx.logger.info('[KnowledgeRescanWorkflow] Relevance audit complete', {
    total: auditSummary.totalAudited,
    healthy: auditSummary.healthy,
    watch: auditSummary.watch,
    decay: auditSummary.decay,
    severe: auditSummary.severe,
    dead: auditSummary.dead,
  });

  const knowledgeRescanPlan = buildKnowledgeRescanPlan({
    recipeEntries: recipeSnapshot.entries,
    auditSummary,
    dimensions: applyTestDimensionFilter(
      allDimensions as unknown as Parameters<typeof applyTestDimensionFilter>[0],
      'rescan'
    ) as DimensionDef[],
    requestedDimensionIds: intent.dimensionIds,
    ...miningPlanOptions.planOptions,
    fileDiff: _incrementalPlan?.diff
      ? {
          affectedDimensionIds: _incrementalPlan.affectedDimensions,
          changedFiles: [
            ...(_incrementalPlan.diff.added || []),
            ...(_incrementalPlan.diff.modified || []),
            ...(_incrementalPlan.diff.deleted || []),
          ],
        }
      : null,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 4.5: ★ Evolution Prescreen + Evolution Pass 候选收集
  // healthy → auto-skip, dead → auto-deprecated, 只保留需要验证的
  // ═══════════════════════════════════════════════════════════

  const prescreen = buildRescanPrescreen(
    auditSummary,
    recipeSnapshot.entries,
    knowledgeRescanPlan.requestedDimensions
  );

  ctx.logger.info('[KnowledgeRescanWorkflow] Evolution prescreen built', {
    needsVerification: prescreen.needsVerification.length,
    autoResolved: prescreen.autoResolved.length,
  });

  const evolutionCandidates = auditSummary.results.filter(
    (r: { verdict: string }) => r.verdict === 'decay' || r.verdict === 'severe'
  );

  if (evolutionCandidates.length > 0) {
    ctx.logger.info('[KnowledgeRescanWorkflow] Evolution candidates collected', {
      count: evolutionCandidates.length,
      byVerdict: {
        decay: evolutionCandidates.filter((c: { verdict: string }) => c.verdict === 'decay').length,
        severe: evolutionCandidates.filter((c: { verdict: string }) => c.verdict === 'severe')
          .length,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Step 5: 计算 gap 维度 + 过滤出需要补齐的维度
  // ═══════════════════════════════════════════════════════════

  // 按维度统计已有 recipe 覆盖（加权策略）：
  //   - active/evolving: 确认知识，始终计入
  //   - staging + audit healthy/watch: 有效候选，计入
  //   - staging + audit decay/severe/dead: 过时候选，不计入覆盖
  const gapPlan = projectKnowledgeRescanGapPlan(knowledgeRescanPlan);
  const {
    requestedDimensions,
    executionDimensions,
    produceDimensions,
    gapDimensions,
    skippedDimensions,
    targetPerDimension,
  } = gapPlan;
  const controllerProduceSessionRequest = readControllerProduceSessionRequest(args);
  const produceSessionPlan = buildProduceSessionRoutePlan({
    allDimensions: allDimensions as DimensionDef[],
    gapPlan: {
      executionDecisions: knowledgeRescanPlan.executionDecisions,
      occupiedTriggers: knowledgeRescanPlan.occupiedTriggers,
      produceDimensions,
    },
    request: controllerProduceSessionRequest,
  });
  const sessionDimensions = controllerProduceSessionRequest.enabled
    ? produceSessionPlan.dimensions
    : executionDimensions;

  ctx.logger.info('[KnowledgeRescanWorkflow] Gap analysis', {
    controllerProduceSessionRequested: controllerProduceSessionRequest.enabled,
    totalDimensions: requestedDimensions.length,
    executionDimensions: executionDimensions.length,
    produceSessionDimensions: sessionDimensions.map((dimension) => dimension.id),
    produceDimensions: produceDimensions.length,
    gapDimensions: gapDimensions.length,
    skippedDimensions: skippedDimensions.length,
    gapDetails: knowledgeRescanPlan.dimensionPlans.map((dimensionPlan) => ({
      id: dimensionPlan.dimension.id,
      existing: dimensionPlan.existingCount,
      gap: dimensionPlan.gap,
      mode: dimensionPlan.execution.mode,
      createBudget: dimensionPlan.execution.createBudget,
      reasons: dimensionPlan.executionReasons.map((reason) => reason.kind),
      target: targetPerDimension,
    })),
  });

  // ═══════════════════════════════════════════════════════════
  // Step 5.5: BootstrapSessionManager — 缓存 Phase 结果供复用
  // （与 cold-start Phase 4.6 对齐）
  // ═══════════════════════════════════════════════════════════

  const workflowSessionState =
    controllerProduceSessionRequest.enabled && sessionDimensions.length === 0
      ? { reusedExisting: false, session: null }
      : controllerProduceSessionRequest.enabled
        ? openOrReturnProjectContextWorkflowSession({
            container: ctx.container,
            dimensions: sessionDimensions,
            facts: projectContextFacts,
            projectRoot,
          })
        : {
            reusedExisting: false,
            session: createProjectContextWorkflowSession({
              container: ctx.container,
              dimensions: sessionDimensions,
              facts: projectContextFacts,
              projectRoot,
            }),
          };
  const workflowSession = workflowSessionState.session;
  const sessionId = workflowSession?.id ?? null;
  if (workflowSession) {
    const projectContextArtifacts = buildProjectContextMissionArtifacts({
      dimensions: sessionDimensions,
      facts: projectContextFacts,
      profile: 'rescan',
      rescan: {
        evidencePlan: projectKnowledgeRescanEvidencePlan(knowledgeRescanPlan),
        prescreen,
      },
      session: workflowSession,
    });
    projectContextFacts.report.projectContextMissionBriefing = {
      briefingMeta: projectContextArtifacts.briefing.meta,
      ideAgentProfile: projectContextArtifacts.ideAgentPacket.profile,
    };
  }
  const produceSession = buildProduceSessionProjection({
    occupiedTriggers: knowledgeRescanPlan.occupiedTriggers,
    plan: produceSessionPlan,
    projectRoot,
    reusedExistingSession: workflowSessionState.reusedExisting,
    session: workflowSession,
  });
  if (controllerProduceSessionRequest.enabled) {
    ctx.logger.info('[KnowledgeRescanWorkflow] Controller produce session route resolved', {
      dimensions: produceSession.dimensions.map((dimension) => dimension.id),
      reusedExistingSession: produceSession.reusedExistingSession,
      sessionId: produceSession.sessionId ?? null,
      status: produceSession.status,
      usable: produceSession.usable,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Step 6: 构建 targetFileMap + 任务清单 → 快速返回骨架
  // ═══════════════════════════════════════════════════════════

  // 任务定义由统一 Rescan plan 决定：coverage gap、recipe decay、file diff 都可触发。
  const perModuleMining = miningMode === 'moduleMining' || miningMode === 'per-module';
  let moduleMiningResult: Record<string, unknown> | null = null;
  const bootstrapSession = controllerProduceSessionRequest.enabled
    ? null
    : perModuleMining
      ? null
      : startAiDimensionSession({
          container: ctx.container,
          dimensions: executionDimensions,
          logger: ctx.logger,
          logPrefix: 'KnowledgeRescanWorkflow',
        }).bootstrapSession;
  const willRunInternalRescanFill =
    !controllerProduceSessionRequest.enabled &&
    !perModuleMining &&
    executionDimensions.length > 0 &&
    !intent.internalExecution?.skipAsyncFill;
  if (willRunInternalRescanFill && workflowSession && bootstrapSession) {
    registerProjectContextWorkflowSessionReleaseOnBootstrapCompletion({
      bootstrapSessionId: bootstrapSession.id,
      container: ctx.container,
      logger: ctx.logger,
      projectRoot,
      workflow: 'rescan',
      workflowSessionId: workflowSession.id,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Step 7: 异步后台填充 gap 维度
  // ═══════════════════════════════════════════════════════════

  if (
    perModuleMining &&
    !controllerProduceSessionRequest.enabled &&
    !intent.internalExecution?.skipAsyncFill
  ) {
    const modules = selectProjectIndexModuleMiningModules({
      bindings: miningPlanOptions.moduleMiningBindings,
      executionDimensions: executionDimensions.map((dimension) => dimension.id),
      facts: projectContextFacts,
      moduleScope: miningPlanOptions.moduleScope,
    });
    if (modules.length === 0) {
      throw new Error('KnowledgeRescanWorkflow moduleMining requires ProjectMap modules.');
    }
    const scaleCap = positiveInteger(args.scaleCap) ?? modules.length;
    const result = await runModuleMining({
      agentService: ctx.container.get('agentService') as Pick<AgentService, 'run'>,
      budget: {
        contentMaxLines: intent.projectAnalysis.contentMaxLines,
        maxFiles: intent.projectAnalysis.maxFiles,
      },
      modules: modules.slice(0, scaleCap),
      projectFacts: projectContextFacts,
      scaleCap,
    });
    moduleMiningResult = result as unknown as Record<string, unknown>;
    if (workflowSession) {
      releaseProjectContextWorkflowSession({
        container: ctx.container,
        logger: ctx.logger,
        projectRoot,
        reason: 'rescan:module-mining-completed',
        workflowSessionId: workflowSession.id,
      });
    }
  } else if (
    !controllerProduceSessionRequest.enabled &&
    executionDimensions.length > 0 &&
    !intent.internalExecution?.skipAsyncFill
  ) {
    const allExistingRecipes = projectKnowledgeRescanPromptRecipes(knowledgeRescanPlan);
    const fillSummary: KnowledgeRescanInlineFillSummary = {
      coverageSkippedDimensions: 0,
      coverageWrittenCells: 0,
      newRecipesThisRound: 0,
    };
    const fillView = attachProjectScopeSourceIdentitiesToView(
      {
        ...buildProjectContextFillView({
          bootstrapSession,
          ctx: ctx as Record<string, unknown>,
          existingRecipes: allExistingRecipes,
          evolutionPrescreen: prescreen,
          facts: projectContextFacts,
          mode: 'rescan',
          projectRoot,
          rescanExecutionDecisions: knowledgeRescanPlan.executionDecisions,
        }),
        ctx: ctx as RescanMcpContext,
        existingRecipes: allExistingRecipes,
        evolutionPrescreen: prescreen,
        onDimensionResult: (result: ProjectContextDimensionResultHookInput) => {
          const coverageResult = writeKnowledgeRescanCoverageLedgerForDimension({
            acceptedSourceRefs: result.acceptedSourceRefs,
            candidateCount: result.candidateCount,
            ctx,
            dimensionId: result.dimensionId,
            projectContextFacts,
            projectRoot,
            referencedFiles: result.referencedFiles,
            roundIndex: nonNegativeInteger((args as Record<string, unknown>).roundIndex),
          });
          if ('writtenCells' in coverageResult) {
            fillSummary.coverageWrittenCells += coverageResult.writtenCells;
            if (coverageResult.writtenCells > 0) {
              fillSummary.newRecipesThisRound += Math.max(0, result.candidateCount);
            }
          } else {
            fillSummary.coverageSkippedDimensions += 1;
          }
        },
        rescanExecutionDecisions: knowledgeRescanPlan.executionDecisions,
      },
      sourceIdentities
    );
    if (runInternalFillInline) {
      ctx.logger.info('[KnowledgeRescanWorkflow] Running rescan dimension fill inline', {
        dimensions: executionDimensions.map((dimension) => dimension.id),
        miningMode,
      });
      await runAiDimensionPipelineForResult(fillView, executionDimensions);
      inlineFillSummary = fillSummary;
    } else {
      dispatchAiDimensionRuns({
        view: fillView,
        dimensions: executionDimensions,
        logPrefix: 'KnowledgeRescanWorkflow',
      });
    }
  } else if (executionDimensions.length === 0) {
    ctx.logger.info(
      '[KnowledgeRescanWorkflow] All dimensions fully covered and healthy — no async fill needed'
    );
    try {
      const snapshotId = saveProjectContextFileSnapshot({
        ctx,
        projectRoot,
        sessionId: bootstrapSession?.id ?? sessionId ?? `rescan-${Date.now()}`,
        allFiles,
        primaryLang,
        plan: _incrementalPlan,
      });
      ctx.logger.info('[KnowledgeRescanWorkflow] Snapshot saved for no-fill rescan', {
        snapshotId,
      });
    } catch (err: unknown) {
      ctx.logger.warn('[KnowledgeRescanWorkflow] Snapshot save skipped for no-fill rescan', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (workflowSession && !controllerProduceSessionRequest.enabled) {
      releaseProjectContextWorkflowSession({
        container: ctx.container,
        logger: ctx.logger,
        projectRoot,
        reason: 'rescan:no-fill-completed',
        workflowSessionId: workflowSession.id,
      });
    }
  }

  // ── SkillHooks: onRescanComplete (fire-and-forget) ──
  try {
    const skillHooks = ctx.container.get('skillHooks') as WorkflowSkillHooks;
    const database = ctx.container.get('database') as WorkflowDatabaseLike | null | undefined;
    skillHooks
      .run(
        'onRescanComplete',
        {
          filesScanned: allFiles.length,
          targetsFound: projectContextFacts.targetCount,
          gapDimensions: gapDimensions.length,
          executionDimensions: executionDimensions.length,
          preservedRecipes: recipeSnapshot.count,
          auditSummary: {
            healthy: auditSummary.healthy,
            decay: auditSummary.decay,
            dead: auditSummary.dead,
          },
        },
        { projectRoot: database?.filename || '' }
      )
      .catch(() => {}); // fire-and-forget
  } catch {
    /* skillHooks not available */
  }

  return presentProjectContextRescanResponse({
    recipeSnapshot,
    cleanResult: cleanResult as unknown as Record<string, unknown>,
    auditSummary,
    gapPlan,
    facts: projectContextFacts,
    bootstrapSession,
    produceSession: produceSession as unknown as Record<string, unknown>,
    sessionId,
    evolutionAudit: evolutionAuditResult as unknown as Record<string, unknown> | null,
    miningMode,
    moduleMining: moduleMiningResult,
    inlineFill: inlineFillSummary,
    reason: intent.reason,
    responseTimeMs: Date.now() - t0,
  });
}

registerProjectIndexWorkflowImplementation('incremental', runKnowledgeRescanProjectIndexWorkflow);

type KnowledgeRescanMiningMode = 'deepMining' | 'moduleMining' | 'per-module';

interface ModuleDimensionTarget {
  dimensionId: string;
  moduleId?: string;
  moduleName?: string;
  targetRecipes: number;
}

interface CoverageLedgerRepositoryLike {
  getCell(scope: { dimensionId: string; moduleId: string; projectRoot: string }): {
    coveredCount: number;
  } | null;
  listByProjectRoot(projectRoot: string): Array<{
    coveredCount: number;
    dimensionId: string;
  }>;
}

export interface KnowledgeRescanCoverageLedgerWriteInput {
  acceptedSourceRefs?: readonly string[];
  candidateCount: number;
  ctx: RescanMcpContext;
  dimensionId: string;
  projectContextFacts: Pick<ProjectContextWorkflowFacts, 'projectMapModules'>;
  projectRoot: string;
  referencedFiles: readonly string[];
  roundIndex?: number | null;
}

export interface KnowledgeRescanCoverageLedgerSkippedResult {
  reason: string;
  skipped: true;
}

export type KnowledgeRescanCoverageLedgerWriteResult =
  | (CoverageLedgerWriteResult & { skipped?: false })
  | KnowledgeRescanCoverageLedgerSkippedResult;

export function writeKnowledgeRescanCoverageLedgerForDimension(
  input: KnowledgeRescanCoverageLedgerWriteInput
): KnowledgeRescanCoverageLedgerWriteResult {
  if (input.candidateCount <= 0) {
    return { skipped: true, reason: 'no-accepted-candidates' };
  }

  const repository = getCoverageLedgerRepository(input.ctx.container);
  if (!repository) {
    input.ctx.logger.debug?.(
      '[KnowledgeRescanWorkflow] coverage ledger write skipped: repository unavailable'
    );
    return { skipped: true, reason: 'repository-unavailable' };
  }

  const modules = buildKnowledgeRescanCoverageLedgerModules(input.projectContextFacts);
  if (modules.length === 0) {
    input.ctx.logger.debug?.(
      '[KnowledgeRescanWorkflow] coverage ledger write skipped: no ProjectMap modules'
    );
    return { skipped: true, reason: 'no-project-map-modules' };
  }

  const sourceRefsForCoverage = input.acceptedSourceRefs ?? input.referencedFiles;
  const coveredPaths = uniqueStrings(
    sourceRefsForCoverage.map(stripSourceRefLineAnchor).filter((path) => path.length > 0)
  );
  if (coveredPaths.length === 0) {
    input.ctx.logger.debug?.(
      '[KnowledgeRescanWorkflow] coverage ledger write skipped: accepted candidates without source refs'
    );
    return { skipped: true, reason: 'no-source-refs' };
  }

  const candidates = buildKnowledgeRescanCoverageLedgerCandidates({
    coveredPaths,
    dimensionId: input.dimensionId,
    modules,
  });
  const tier = resolveModuleTier(modules.length);
  const perCellTarget = resolvePerCellTargetDefault(tier);
  const latestRound =
    input.roundIndex ?? latestCoverageLedgerRoundIndex(repository, input.projectRoot) ?? null;

  const result = writeCoverageLedgerForCompletion({
    repository,
    projectRoot: input.projectRoot,
    modules,
    dimensionIds: [input.dimensionId],
    candidates,
    coveredPaths,
    perCellTarget,
    lastRound: latestRound,
    logger: input.ctx.logger,
  });
  return { ...result, skipped: false };
}

function buildKnowledgeRescanCoverageLedgerModules(
  facts: Pick<ProjectContextWorkflowFacts, 'projectMapModules'>
): CoverageLedgerModuleAxis[] {
  return buildCoverageLedgerModuleAxisFromSummaries({
    modules: facts.projectMapModules
      .filter((module) => {
        const ownedFiles = uniqueStrings(module.ownedFiles ?? []);
        return (
          module.moduleId.trim().length > 0 &&
          (ownedFiles.length > 0 || Boolean(module.modulePath?.trim()))
        );
      })
      .map((module) => ({
        moduleId: module.moduleId,
        moduleName: module.moduleName || module.moduleId,
        modulePath: module.modulePath,
        ownedFiles: module.ownedFiles,
      })),
  });
}

function buildKnowledgeRescanCoverageLedgerCandidates({
  coveredPaths,
  dimensionId,
  modules,
}: {
  coveredPaths: readonly string[];
  dimensionId: string;
  modules: readonly CoverageLedgerModuleAxis[];
}): CoverageLedgerCandidate[] {
  return [
    ...coveredPaths.map((path) => ({
      dimensionIds: [dimensionId],
      sourceRefPaths: [path],
      importance: 60,
    })),
    ...modules.map((module) => ({
      dimensionIds: [dimensionId],
      sourceRefPaths: [...module.ownedPaths],
      importance: 50,
    })),
  ];
}

function latestCoverageLedgerRoundIndex(
  repository: EvolutionCoverageLedgerRepository,
  projectRoot: string
): number | null {
  return repository.listRoundsByProjectRoot(projectRoot).reduce<number | null>((latest, round) => {
    const roundIndex = nonNegativeInteger(round.roundIndex);
    if (roundIndex === null) {
      return latest;
    }
    return latest === null || roundIndex > latest ? roundIndex : latest;
  }, null);
}

function stripSourceRefLineAnchor(sourceRef: string): string {
  return sourceRef.trim().replace(/:\d+(?:-\d+)?$/, '');
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function buildKnowledgeRescanMiningPlanOptions(input: {
  args: KnowledgeRescanArgs;
  ctx: RescanMcpContext;
  miningMode?: KnowledgeRescanMiningMode;
  projectContextFacts: ProjectContextWorkflowFacts;
  projectRoot: string;
}) {
  const moduleScope = normalizeStringArray(input.args.moduleScope);
  if (!input.miningMode) {
    return { moduleMiningBindings: [], moduleScope, planOptions: {} };
  }

  const coverageLedgerRepository = getCoverageLedgerRepository(input.ctx.container);
  const moduleDimensionTargets = normalizeModuleDimensionTargets(input.args.moduleDimensionTargets);
  const moduleBindings = moduleDimensionTargets.map((target) => {
    const moduleId = target.moduleId || target.moduleName;
    const cell =
      moduleId && coverageLedgerRepository
        ? coverageLedgerRepository.getCell({
            dimensionId: target.dimensionId,
            moduleId,
            projectRoot: input.projectRoot,
          })
        : null;
    return {
      dimensionId: target.dimensionId,
      moduleId,
      moduleName: target.moduleName,
      perCellCoverage: cell?.coveredCount ?? 0,
      targetRecipes: target.targetRecipes,
    };
  });

  return {
    moduleMiningBindings: moduleDimensionTargets.map((target) => ({
      dimensions: [target.dimensionId],
      moduleId: target.moduleId,
      moduleName: target.moduleName,
    })),
    moduleScope,
    planOptions: {
      ledgerCoverageByDimension: coverageLedgerRepository
        ? buildLedgerCoverageByDimension(coverageLedgerRepository, input.projectRoot)
        : undefined,
      moduleBindings: moduleBindings.length > 0 ? moduleBindings : undefined,
      moduleCount:
        input.projectContextFacts.projectMapModules.length || input.projectContextFacts.moduleCount,
      perDimensionTargets: normalizeNumberRecord(input.args.perDimensionTargets),
    },
  };
}

function buildLedgerCoverageByDimension(
  repository: CoverageLedgerRepositoryLike,
  projectRoot: string
): Record<string, number> {
  const coverage: Record<string, number> = {};
  for (const cell of repository.listByProjectRoot(projectRoot)) {
    coverage[cell.dimensionId] = (coverage[cell.dimensionId] ?? 0) + cell.coveredCount;
  }
  return coverage;
}

function getCoverageLedgerRepository(container: {
  get(name: string): unknown;
}): EvolutionCoverageLedgerRepository | null {
  try {
    const repository = container.get('coverageLedgerRepository');
    if (
      repository &&
      typeof (repository as CoverageLedgerRepositoryLike).getCell === 'function' &&
      typeof (repository as CoverageLedgerRepositoryLike).listByProjectRoot === 'function' &&
      typeof (repository as { listRoundsByProjectRoot?: unknown }).listRoundsByProjectRoot ===
        'function' &&
      typeof (repository as { upsertCell?: unknown }).upsertCell === 'function'
    ) {
      return repository as EvolutionCoverageLedgerRepository;
    }
  } catch {
    return null;
  }
  return null;
}

function knowledgeRescanMiningModeArg(value: unknown): KnowledgeRescanMiningMode | undefined {
  return value === 'deepMining' || value === 'moduleMining' || value === 'per-module'
    ? value
    : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function normalizeNumberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, raw]) => [key.trim(), nonNegativeInteger(raw)] as const)
    .filter(
      (entry): entry is readonly [string, number] => entry[0].length > 0 && entry[1] !== null
    );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeModuleDimensionTargets(value: unknown): ModuleDimensionTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const dimensionId = stringValue(item.dimensionId);
    const targetRecipes = nonNegativeInteger(item.targetRecipes);
    if (!dimensionId || targetRecipes === null) {
      return [];
    }
    return [
      {
        dimensionId,
        moduleId: stringValue(item.moduleId),
        moduleName: stringValue(item.moduleName),
        targetRecipes,
      },
    ];
  });
}

function shouldRunInternalRescanFillInline(args: KnowledgeRescanArgs): boolean {
  const internalExecution = args.internalExecution;
  return isRecord(internalExecution) && internalExecution.runAsyncFillInline === true;
}

function positiveInteger(value: unknown): number | undefined {
  const normalized = nonNegativeInteger(value);
  return normalized !== null && normalized > 0 ? normalized : undefined;
}

function nonNegativeInteger(value: unknown): number | null {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : null;
  if (numericValue === null || !Number.isFinite(numericValue) || numericValue < 0) {
    return null;
  }
  return Math.floor(numericValue);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function createCleanupService(ctx: {
  dataRoot?: string;
  db?: unknown;
  logger?: ConstructorParameters<typeof CleanupService>[0]['logger'];
  projectRoot: string;
}) {
  return new CleanupService({
    projectRoot: ctx.projectRoot,
    dataRoot: ctx.dataRoot,
    db: ctx.db,
    logger: ctx.logger,
  });
}
