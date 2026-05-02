/**
 * ExternalKnowledgeRescanWorkflow — 外部 Agent 增量知识重扫
 *
 * 保留已审核 Recipe，清理衍生缓存，全量/指定维度重新扫描。
 *
 * 流程:
 *   1. snapshotRecipes — 快照保留知识
 *   2. rescanClean — 清理衍生缓存
 *   3. Phase 1-4 全量分析 (ProjectIntelligenceCapability)
 *   4. 构建 Mission Briefing（含 allRecipes + evolutionGuide）
 *   5. 返回给外部 Agent 按维度执行: evolve → gap-fill → dimension_complete
 */

import type { ServiceContainer } from '#inject/ServiceContainer.js';
import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import type { RescanInput } from '#shared/schemas/mcp-tools.js';
import type { DimensionDef, ProjectSnapshot } from '#types/project-snapshot.js';
import { buildProjectSnapshot } from '#types/project-snapshot-builder.js';
import {
  buildExternalMissionBriefing,
  createExternalWorkflowSession,
} from '#workflows/capabilities/execution/external/ExternalMissionWorkflow.js';
import {
  auditRecipesForRescan,
  buildKnowledgeRescanPlan,
  buildRescanPrescreen,
  projectExternalRescanEvidencePlan,
  syncKnowledgeStoreForRescan,
} from '#workflows/capabilities/planning/knowledge/KnowledgeRescanPlanner.js';
import { ProjectIntelligenceCapability } from '#workflows/capabilities/project-intelligence/ProjectIntelligenceCapability.js';
import {
  runForceRescanCleanPolicy,
  runRescanCleanPolicy,
} from '#workflows/capabilities/WorkflowCleanupPolicies.js';
import { createExternalKnowledgeRescanIntent } from '#workflows/knowledge-rescan/KnowledgeRescanIntent.js';
import {
  presentExternalKnowledgeRescanEmptyProject,
  presentExternalKnowledgeRescanResponse,
} from '#workflows/knowledge-rescan/KnowledgeRescanPresenters.js';
import { buildKnowledgeRescanWorkflowPlan } from '#workflows/knowledge-rescan/KnowledgeRescanWorkflowPlan.js';

/** MCP handler context */
interface McpContext {
  container: ServiceContainer;
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
  startedAt?: number;
  [key: string]: unknown;
}

// ── 主入口 ─────────────────────────────────────────────────

export async function runExternalKnowledgeRescanWorkflow(ctx: McpContext, args: RescanInput) {
  const t0 = Date.now();
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveDataRoot(ctx.container);
  const db = ctx.container.get('database');
  const intent = createExternalKnowledgeRescanIntent(args);
  const plan = buildKnowledgeRescanWorkflowPlan({ intent, projectRoot, dataRoot });

  // ═══════════════════════════════════════════════════════════
  // Step 0: 清理策略（根据 intent 决定）
  // ═══════════════════════════════════════════════════════════

  let recipeSnapshot;
  let cleanResult;

  if (intent.cleanupPolicy === 'force-rescan') {
    const result = await runForceRescanCleanPolicy({
      projectRoot: plan.cleanup.projectRoot,
      db,
      logger: ctx.logger,
    });
    recipeSnapshot = result.recipeSnapshot;
    cleanResult = result.cleanResult;
  } else if (intent.cleanupPolicy === 'rescan-clean') {
    const result = await runRescanCleanPolicy({
      projectRoot: plan.cleanup.projectRoot,
      db,
      logger: ctx.logger,
    });
    recipeSnapshot = result.recipeSnapshot;
    cleanResult = result.cleanResult;
  } else {
    const { CleanupService } = await import('#service/cleanup/CleanupService.js');
    const cleanupService = new CleanupService({
      projectRoot: plan.cleanup.projectRoot,
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

  ctx.logger.info(`[Rescan] Preserved ${recipeSnapshot.count} recipes`, {
    cleanupPolicy: intent.cleanupPolicy,
    coverageByDimension: recipeSnapshot.coverageByDimension,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 2.5: Recipe 文件 ↔ DB 一致性恢复 + 向量索引重建
  // ═══════════════════════════════════════════════════════════

  // 2.5a: KnowledgeSyncService — 恢复 Recipe 文件 ↔ DB 一致性
  //   rescanClean 保留了 recipes/ 文件和 active/published/staging/evolving DB 记录，
  //   但清除了 recipe_source_refs 等桥接表，需重新同步。
  syncKnowledgeStoreForRescan({
    container: ctx.container,
    db,
    logger: ctx.logger,
    logPrefix: 'Rescan',
  });

  // NOTE: 不在 rescan 中调用 VectorService.fullBuild()
  // 理由：fullBuild 依赖外部 embedding API（LLM），在 MCP handler 同步路径中
  // 引入 LLM 调用不合理（无超时、可能阻塞、需要 API key）。
  // 向量索引会在后续 Agent 提交新知识时由 SyncCoordinator 增量更新。

  // ═══════════════════════════════════════════════════════════
  // Step 3: Phase 1-4 全量分析
  // ═══════════════════════════════════════════════════════════

  const phaseResults = await ProjectIntelligenceCapability.run({
    projectRoot: plan.projectAnalysis.projectRoot,
    ctx,
    prepare: plan.projectAnalysis.prepare,
    scan: plan.projectAnalysis.scan,
    materialize: plan.projectAnalysis.materialize,
  });

  // 空项目 fast-path
  if (phaseResults.isEmpty) {
    return presentExternalKnowledgeRescanEmptyProject({ responseTimeMs: Date.now() - t0 });
  }

  const {
    allFiles,
    primaryLang,
    depGraphData,
    langStats,
    astProjectSummary,
    codeEntityResult,
    callGraphResult,
    guardAudit,
    activeDimensions: allDimensions,
    targetsSummary,
    localPackageModules,
    langProfile,
  } = phaseResults;

  // ── Build immutable ProjectSnapshot ──
  const snapshot: ProjectSnapshot = buildProjectSnapshot({
    projectRoot,
    sourceTag: 'rescan-external',
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
  });

  const knowledgeRescanPlan = buildKnowledgeRescanPlan({
    recipeEntries: recipeSnapshot.entries,
    auditSummary,
    dimensions: allDimensions as DimensionDef[],
    requestedDimensionIds: intent.dimensionIds,
  });
  const dimensions = knowledgeRescanPlan.requestedDimensions;

  // ═══════════════════════════════════════════════════════════
  // Step 4.5: 构建进化前置过滤（Phase A）
  // ═══════════════════════════════════════════════════════════

  const prescreen = buildRescanPrescreen(auditSummary, recipeSnapshot.entries, dimensions);
  const evidencePlan = projectExternalRescanEvidencePlan(knowledgeRescanPlan);

  ctx.logger.info('[Rescan] Evolution prescreen built', {
    needsVerification: prescreen.needsVerification.length,
    autoResolved: prescreen.autoResolved.length,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 5: 构建 Mission Briefing + 过滤维度
  // ═══════════════════════════════════════════════════════════

  const session = createExternalWorkflowSession({
    container: ctx.container,
    projectRoot,
    dimensions,
    snapshot,
    primaryLang,
    fileCount: allFiles.length,
    moduleCount: depGraphData?.nodes?.length || 0,
  });

  const briefing = buildExternalMissionBriefing({
    projectRoot,
    primaryLang,
    secondaryLanguages: (langProfile as { secondary?: string[] }).secondary || [],
    isMultiLang: (langProfile as { isMultiLang?: boolean }).isMultiLang || false,
    fileCount: allFiles.length,
    projectType: snapshot.discoverer.id,
    profile: 'rescan-external',
    rescan: { evidencePlan, prescreen },
    briefing: {
      astData: astProjectSummary,
      codeEntityResult,
      callGraphResult,
      depGraphData,
      guardAudit,
      targets: targetsSummary,
      activeDimensions: dimensions,
      session,
      languageStats: langStats,
      panoramaResult: snapshot.panorama,
      localPackageModules,
    },
  });

  // 附加 warnings
  if (phaseResults.warnings.length > 0) {
    briefing.meta = briefing.meta || {};
    briefing.meta.warnings = [...(briefing.meta.warnings || []), ...phaseResults.warnings];
  }

  const dimGapLog = evidencePlan.dimensionGaps
    .map(
      (dimensionGap) =>
        `${dimensionGap.dimensionId}(${dimensionGap.existingCount}→gap ${dimensionGap.gap})`
    )
    .join(', ');
  ctx.logger.info(
    `[Rescan] Mission Briefing ready: ${allFiles.length} files, ${dimensions.length} dims, ` +
      `preserved: ${recipeSnapshot.count}, decayed: ${evidencePlan.decayCount}, totalGap: ${evidencePlan.totalGap} — session ${session.id}`
  );
  ctx.logger.info(`[Rescan] Dimension gaps: ${dimGapLog}`);
  ctx.logger.info('[Rescan] Execution reasons', {
    executionDimensions: knowledgeRescanPlan.executionDimensions.length,
    reasons: knowledgeRescanPlan.executionReasons,
  });

  return presentExternalKnowledgeRescanResponse({
    recipeSnapshot,
    cleanResult,
    auditSummary,
    briefing: briefing as Record<string, unknown>,
    evidencePlan,
    dimensions,
    reason: intent.reason,
    responseTimeMs: Date.now() - t0,
  });
}
