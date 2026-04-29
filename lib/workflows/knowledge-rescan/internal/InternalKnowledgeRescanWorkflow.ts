/**
 * rescan-internal.ts — 内部 Agent 知识重扫
 *
 * 与 rescan-external.ts（为外部 IDE Agent 生成 Mission Briefing）不同，
 * 本文件由内置 AI dimension execution 在服务端自动完成知识补齐。
 *
 * 流程:
 *   1. snapshotRecipes — 快照保留知识
 *   2. rescanClean — 清理衍生缓存
 *   2.5 Recipe 文件 ↔ DB 一致性恢复
 *   3. Phase 1-4 全量分析（文件收集→AST→依赖→Guard→维度）
 *   4. RecipeRelevanceAuditor — 证据验证 + 快速衰退
 *   5. 计算 gap 维度（需要补齐的维度）
 *   5.5 BootstrapSessionManager — 缓存 Phase 结果供复用
 *   6. 快速返回骨架 → 异步 internal dimension execution 填充 gap 维度
 *   7. 前端通过 Socket.io 接收维度完成进度
 *
 * @module handlers/rescan-internal
 */

import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import type { DimensionDef, ProjectSnapshot } from '#types/project-snapshot.js';
import { buildProjectSnapshot } from '#types/project-snapshot-builder.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import type { McpContext, WorkflowDatabaseLike, WorkflowSkillHooks } from '#types/workflows.js';
import {
  dispatchInternalDimensionExecution,
  startInternalDimensionExecutionSession,
} from '#workflows/common-capabilities/agent-execution/InternalDimensionExecutionWorkflow.js';
import { runRescanCleanPolicy } from '#workflows/common-capabilities/cleanup/CleanupPolicies.js';
import {
  auditRecipesForRescan,
  buildKnowledgeRescanPlan,
  buildRescanPrescreen,
  projectInternalRescanGapPlan,
  projectInternalRescanPromptRecipes,
  syncKnowledgeStoreForRescan,
} from '#workflows/common-capabilities/knowledge-rescan/KnowledgeRescanPlanner.js';
import { cacheProjectAnalysisSession } from '#workflows/common-capabilities/progress/WorkflowSessionCache.js';
import { ProjectAnalysisCapability } from '#workflows/common-capabilities/project-analysis/ProjectAnalysisWorkflow.js';
import {
  createInternalKnowledgeRescanIntent,
  type InternalKnowledgeRescanArgs,
} from '#workflows/knowledge-rescan/KnowledgeRescanIntent.js';
import {
  buildInternalKnowledgeRescanTargetFileMap,
  presentInternalKnowledgeRescanEmptyProject,
  presentInternalKnowledgeRescanResponse,
} from '#workflows/knowledge-rescan/KnowledgeRescanPresenters.js';
import { buildKnowledgeRescanWorkflowPlan } from '#workflows/knowledge-rescan/KnowledgeRescanWorkflowPlan.js';

// ── Local types ──────────────────────────────────────────

interface RescanLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface RescanMcpContext extends McpContext {
  logger: RescanLogger;
}

// ── 主入口 ──────────────────────────────────────────────

/**
 * rescanInternal — 内部 Agent 知识重扫
 *
 * 同步返回骨架（含 audit 摘要 + 异步会话 ID），
 * 后台通过 internal dimension execution 对 gap 维度执行 AI 补齐。
 */
export async function runInternalKnowledgeRescanWorkflow(
  ctx: RescanMcpContext,
  args: InternalKnowledgeRescanArgs
) {
  const t0 = Date.now();
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveDataRoot(ctx.container);
  const db = ctx.container.get('database');
  const intent = createInternalKnowledgeRescanIntent(args);
  const plan = buildKnowledgeRescanWorkflowPlan({ intent, projectRoot, dataRoot });

  // ═══════════════════════════════════════════════════════════
  // Step 1: 快照现有知识
  // ═══════════════════════════════════════════════════════════

  const { recipeSnapshot, cleanResult } = await runRescanCleanPolicy({
    projectRoot: plan.cleanup.projectRoot,
    db,
    logger: ctx.logger,
  });

  ctx.logger.info(`[Rescan-Internal] Preserved ${recipeSnapshot.count} recipes`, {
    coverageByDimension: recipeSnapshot.coverageByDimension,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 2.5: Recipe 文件 ↔ DB 一致性恢复
  // ═══════════════════════════════════════════════════════════

  syncKnowledgeStoreForRescan({
    container: ctx.container,
    db,
    logger: ctx.logger,
    logPrefix: 'Rescan-Internal',
  });

  // ═══════════════════════════════════════════════════════════
  // Step 3: Phase 1-4 全量分析
  // ═══════════════════════════════════════════════════════════

  const phaseResults = await ProjectAnalysisCapability.run({
    projectRoot: plan.projectAnalysis.projectRoot,
    ctx,
    prepare: plan.projectAnalysis.prepare,
    scan: plan.projectAnalysis.scan,
    materialize: plan.projectAnalysis.materialize,
  });

  if (phaseResults.isEmpty) {
    return presentInternalKnowledgeRescanEmptyProject({ responseTimeMs: Date.now() - t0 });
  }

  const {
    allFiles,
    primaryLang,
    depGraphData,
    astProjectSummary,
    activeDimensions: allDimensions,
    incrementalPlan: _incrementalPlan,
  } = phaseResults;

  // ── Build immutable ProjectSnapshot ──
  const snapshot: ProjectSnapshot = buildProjectSnapshot({
    projectRoot,
    sourceTag: 'rescan-internal',
    ...phaseResults,
    report: phaseResults.report,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 4: Recipe 证据验证 + 快速衰退
  // ═══════════════════════════════════════════════════════════

  const auditSummary = await auditRecipesForRescan({
    container: ctx.container,
    logger: ctx.logger,
    recipeEntries: recipeSnapshot.entries,
    allFiles,
    astProjectSummary,
    depGraphData,
  });

  ctx.logger.info('[Rescan-Internal] Relevance audit complete', {
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
    dimensions: allDimensions as DimensionDef[],
    requestedDimensionIds: intent.dimensionIds,
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

  ctx.logger.info('[Rescan-Internal] Evolution prescreen built', {
    needsVerification: prescreen.needsVerification.length,
    autoResolved: prescreen.autoResolved.length,
  });

  const evolutionCandidates = auditSummary.results.filter(
    (r: { verdict: string }) => r.verdict === 'decay' || r.verdict === 'severe'
  );

  if (evolutionCandidates.length > 0) {
    ctx.logger.info('[Rescan-Internal] Evolution candidates collected', {
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
  const gapPlan = projectInternalRescanGapPlan(knowledgeRescanPlan);
  const {
    requestedDimensions,
    executionDimensions,
    gapDimensions,
    skippedDimensions,
    targetPerDimension,
  } = gapPlan;

  ctx.logger.info('[Rescan-Internal] Gap analysis', {
    totalDimensions: requestedDimensions.length,
    executionDimensions: executionDimensions.length,
    gapDimensions: gapDimensions.length,
    skippedDimensions: skippedDimensions.length,
    gapDetails: knowledgeRescanPlan.dimensionPlans.map((dimensionPlan) => ({
      id: dimensionPlan.dimension.id,
      existing: dimensionPlan.existingCount,
      gap: dimensionPlan.gap,
      reasons: dimensionPlan.executionReasons.map((reason) => reason.kind),
      target: targetPerDimension,
    })),
  });

  // ═══════════════════════════════════════════════════════════
  // Step 5.5: BootstrapSessionManager — 缓存 Phase 结果供复用
  // （与 bootstrap-internal Phase 4.6 对齐）
  // ═══════════════════════════════════════════════════════════

  const sessionId = cacheProjectAnalysisSession({
    container: ctx.container,
    projectRoot,
    dimensions: executionDimensions,
    snapshot,
    primaryLang,
    fileCount: allFiles.length,
    moduleCount: depGraphData?.nodes?.length || 0,
    logger: ctx.logger,
    logPrefix: 'Rescan-Internal',
  });

  // ═══════════════════════════════════════════════════════════
  // Step 6: 构建 targetFileMap + 任务清单 → 快速返回骨架
  // ═══════════════════════════════════════════════════════════

  const targetFileMap = buildInternalKnowledgeRescanTargetFileMap(
    snapshot,
    intent.projectAnalysis.contentMaxLines
  );

  // 任务定义由统一 Rescan plan 决定：coverage gap、recipe decay、file diff 都可触发。
  const { bootstrapSession } = startInternalDimensionExecutionSession({
    container: ctx.container,
    dimensions: executionDimensions,
    logger: ctx.logger,
    logPrefix: 'Rescan-Internal',
  });

  // ═══════════════════════════════════════════════════════════
  // Step 7: 异步后台填充 gap 维度
  // ═══════════════════════════════════════════════════════════

  if (executionDimensions.length > 0 && !intent.internalExecution?.skipAsyncFill) {
    const fillView: PipelineFillView = {
      snapshot,
      ctx: ctx as RescanMcpContext & { logger: RescanLogger },
      bootstrapSession,
      targetFileMap,
      projectRoot,
    };

    const allExistingRecipes = projectInternalRescanPromptRecipes(knowledgeRescanPlan);
    dispatchInternalDimensionExecution({
      view: { ...fillView, existingRecipes: allExistingRecipes, evolutionPrescreen: prescreen },
      dimensions: executionDimensions,
      logPrefix: 'Rescan-Internal',
    });
  } else if (executionDimensions.length === 0) {
    ctx.logger.info(
      '[Rescan-Internal] All dimensions fully covered and healthy — no async fill needed'
    );
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
          targetsFound: snapshot.allTargets.length,
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

  return presentInternalKnowledgeRescanResponse({
    recipeSnapshot,
    cleanResult,
    auditSummary,
    gapPlan,
    snapshot,
    bootstrapSession,
    sessionId,
    reason: intent.reason,
    responseTimeMs: Date.now() - t0,
  });
}
