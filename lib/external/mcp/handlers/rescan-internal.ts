/**
 * rescan-internal.ts — 内部 Agent 增量扫描
 *
 * 与 rescan-external.ts（为外部 IDE Agent 生成 Mission Briefing）不同，
 * 本文件由内置 AI pipeline（fillDimensionsV3）在服务端自动完成知识补齐。
 *
 * 流程:
 *   1. snapshotRecipes — 快照保留知识
 *   2. rescanClean — 清理衍生缓存
 *   2.5 Recipe 文件 ↔ DB 一致性恢复
 *   3. Phase 1-4 全量分析（文件收集→AST→依赖→Guard→维度）
 *   4. RecipeRelevanceAuditor — 证据验证 + 快速衰退
 *   5. 计算 gap 维度（需要补齐的维度）
 *   5.5 BootstrapSessionManager — 缓存 Phase 结果供复用
 *   6. 快速返回骨架 → 异步 fillDimensionsV3 填充 gap 维度
 *   7. 前端通过 Socket.io 接收维度完成进度
 *
 * @module handlers/rescan-internal
 */

import path from 'node:path';
import { CleanupService } from '#service/cleanup/CleanupService.js';
import { RelevanceAuditor } from '#service/evolution/RelevanceAuditor.js';
import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import type { RescanInput } from '#shared/schemas/mcp-tools.js';
import type {
  AstSummary,
  DimensionDef,
  GuardAudit,
  ProjectSnapshot,
} from '#types/project-snapshot.js';
import { buildProjectSnapshot } from '#types/project-snapshot-builder.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import { toSessionCache } from '#types/snapshot-views.js';
import { envelope } from '../envelope.js';
import { fillDimensionsV3 } from './bootstrap/pipeline/orchestrator.js';
import {
  buildTaskDefs,
  dispatchPipelineFill,
  startTaskManagerSession,
} from './bootstrap/shared/async-fill-helpers.js';
import { extractCodeEntities, extractDependencyEdges } from './bootstrap/shared/audit-helpers.js';
import { runAllPhases } from './bootstrap/shared/bootstrap-phases.js';
import { summarizePanorama } from './bootstrap/shared/panorama-utils.js';
import { getOrCreateSessionManager } from './bootstrap/shared/session-helpers.js';
import { buildTargetFileMap } from './bootstrap/shared/target-file-map.js';
import { buildEvolutionPrescreen } from './evolution-prescreen.js';
import type { McpContext } from './types.js';

// ── Local types ──────────────────────────────────────────

interface RescanLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface RescanMcpContext extends McpContext {
  logger: RescanLogger;
}

interface RescanInternalArgs extends RescanInput {
  /** 跳过异步填充（测试用） */
  skipAsyncFill?: boolean;
}

// ── 主入口 ──────────────────────────────────────────────

const TARGET_PER_DIM = 5;

/**
 * rescanInternal — 内部 Agent 增量扫描
 *
 * 同步返回骨架（含 audit 摘要 + 异步会话 ID），
 * 后台通过 fillDimensionsV3 对 gap 维度执行 AI 补齐。
 */
export async function rescanInternal(ctx: RescanMcpContext, args: RescanInternalArgs) {
  const t0 = Date.now();
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveDataRoot(ctx.container);
  const db = ctx.container.get('database');

  // ═══════════════════════════════════════════════════════════
  // Step 1: 快照现有知识
  // ═══════════════════════════════════════════════════════════

  const cleanupService = new CleanupService({
    projectRoot: dataRoot,
    db,
    logger: ctx.logger,
  });
  const recipeSnapshot = await cleanupService.snapshotRecipes();

  ctx.logger.info(`[Rescan-Internal] Preserved ${recipeSnapshot.count} recipes`, {
    coverageByDimension: recipeSnapshot.coverageByDimension,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 2: 清理衍生缓存
  // ═══════════════════════════════════════════════════════════

  const cleanResult = await cleanupService.rescanClean();

  // ═══════════════════════════════════════════════════════════
  // Step 2.5: Recipe 文件 ↔ DB 一致性恢复
  // ═══════════════════════════════════════════════════════════

  try {
    let syncService: {
      sync: (
        db: unknown,
        opts: { force: boolean }
      ) => { synced: number; created: number; updated: number };
    } | null = null;
    try {
      syncService = ctx.container.get('knowledgeSyncService');
    } catch {
      /* not registered */
    }
    if (syncService) {
      const syncReport = syncService.sync(db, {
        force: true,
      });
      ctx.logger.info('[Rescan-Internal] KnowledgeSyncService sync complete', {
        synced: syncReport.synced,
        created: syncReport.created,
        updated: syncReport.updated,
      });
    }
  } catch (e: unknown) {
    ctx.logger.warn(
      `[Rescan-Internal] KnowledgeSyncService sync failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // ═══════════════════════════════════════════════════════════
  // Step 3: Phase 1-4 全量分析
  // ═══════════════════════════════════════════════════════════

  const contentMaxLines = 120;
  const phaseResults = await runAllPhases(projectRoot, ctx, {
    maxFiles: 500,
    contentMaxLines,
    sourceTag: 'rescan-internal',
    summaryPrefix: 'Rescan-Internal scan',
    clearOldData: false, // 已由 rescanClean 清理
    generateReport: true,
    generateAstContext: true,
    incremental: false,
  });

  if (phaseResults.isEmpty) {
    return envelope({
      success: true,
      data: { message: 'No source files found. Nothing to rescan.' },
      meta: { tool: 'alembic_rescan', responseTimeMs: Date.now() - t0 },
    });
  }

  const {
    allFiles,
    allTargets,
    primaryLang,
    depGraphData,
    astProjectSummary,
    guardAudit,
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

  const auditor = new RelevanceAuditor({
    knowledgeRepo: ctx.container.get(
      'knowledgeRepository'
    ) as import('../../../repository/knowledge/KnowledgeRepository.impl.js').default,
    evolutionGateway: ctx.container.get(
      'evolutionGateway'
    ) as import('../../../service/evolution/EvolutionGateway.js').EvolutionGateway,
    logger: ctx.logger,
  });

  const codeEntities = extractCodeEntities(astProjectSummary);
  const dependencyEdges = extractDependencyEdges(depGraphData);

  const auditSummary = await auditor.audit(recipeSnapshot.entries, {
    fileList: allFiles.map((f) => f.relativePath || f.name),
    codeEntities,
    dependencyGraph: dependencyEdges,
  });

  ctx.logger.info('[Rescan-Internal] Relevance audit complete', {
    total: auditSummary.totalAudited,
    healthy: auditSummary.healthy,
    watch: auditSummary.watch,
    decay: auditSummary.decay,
    severe: auditSummary.severe,
    dead: auditSummary.dead,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 4.5: ★ Evolution Prescreen + Evolution Pass 候选收集
  // healthy → auto-skip, dead → auto-deprecated, 只保留需要验证的
  // ═══════════════════════════════════════════════════════════

  const prescreen = buildEvolutionPrescreen(
    auditSummary,
    recipeSnapshot.entries,
    allDimensions as Array<{ id: string }>
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
  const auditVerdictMap = new Map(auditSummary.results.map((r) => [r.recipeId, r.verdict]));
  const coverageByDim: Record<string, number> = {};
  for (const entry of recipeSnapshot.entries) {
    const dim = entry.knowledgeType || 'unknown';
    const isConfirmed = entry.lifecycle === 'active' || entry.lifecycle === 'evolving';
    const verdict = auditVerdictMap.get(entry.id);
    const isHealthyStaging =
      entry.lifecycle === 'staging' && (!verdict || verdict === 'healthy' || verdict === 'watch');

    if (isConfirmed || isHealthyStaging) {
      coverageByDim[dim] = (coverageByDim[dim] || 0) + 1;
    }
  }

  // 过滤需要补齐的维度
  const requestedDimensions = args.dimensions?.length
    ? (allDimensions as DimensionDef[]).filter((d) => args.dimensions?.includes(d.id))
    : (allDimensions as DimensionDef[]);

  const gapDimensions = requestedDimensions.filter((d) => {
    const existing = coverageByDim[d.id] || 0;
    return existing < TARGET_PER_DIM;
  });

  const skippedDimensions = requestedDimensions.filter((d) => {
    const existing = coverageByDim[d.id] || 0;
    return existing >= TARGET_PER_DIM;
  });

  ctx.logger.info('[Rescan-Internal] Gap analysis', {
    totalDimensions: requestedDimensions.length,
    gapDimensions: gapDimensions.length,
    skippedDimensions: skippedDimensions.length,
    gapDetails: gapDimensions.map((d) => ({
      id: d.id,
      existing: coverageByDim[d.id] || 0,
      gap: TARGET_PER_DIM - (coverageByDim[d.id] || 0),
    })),
  });

  // ═══════════════════════════════════════════════════════════
  // Step 5.5: BootstrapSessionManager — 缓存 Phase 结果供复用
  // （与 bootstrap-internal Phase 4.6 对齐）
  // ═══════════════════════════════════════════════════════════

  let sessionId: string | null = null;
  try {
    const sessionManager = getOrCreateSessionManager(ctx.container);
    const bsSession = sessionManager.createSession({
      projectRoot,
      dimensions: gapDimensions.map((d) => ({
        ...d,
        skillMeta: d.skillMeta ?? undefined,
      })),
      projectContext: {
        projectName: path.basename(projectRoot),
        primaryLang,
        fileCount: allFiles.length,
        modules: depGraphData?.nodes?.length || 0,
      },
    });
    bsSession.setSnapshotCache(toSessionCache(snapshot));
    sessionId = bsSession.id;
  } catch (e: unknown) {
    ctx.logger.warn(
      `[Rescan-Internal] BootstrapSessionManager setup failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // ═══════════════════════════════════════════════════════════
  // Step 6: 构建 targetFileMap + 任务清单 → 快速返回骨架
  // ═══════════════════════════════════════════════════════════

  const targetFileMap = buildTargetFileMap(
    allFiles as unknown as Array<{
      name: string;
      relativePath: string;
      targetName: string;
      content: string;
    }>,
    contentMaxLines
  );

  // 任务定义仅包含 gap 维度
  const taskDefs = buildTaskDefs(gapDimensions);

  // 启动 BootstrapTaskManager 会话
  const bootstrapSession = startTaskManagerSession(
    ctx.container,
    taskDefs,
    ctx.logger,
    'Rescan-Internal'
  );

  // 构建骨架响应
  const responseData = {
    rescan: {
      preservedRecipes: recipeSnapshot.count,
      cleanedTables: cleanResult.clearedTables.length,
      cleanedFiles: cleanResult.deletedFiles,
      reason: args.reason || null,
    },
    relevanceAudit: {
      totalAudited: auditSummary.totalAudited,
      healthy: auditSummary.healthy,
      watch: auditSummary.watch,
      decay: auditSummary.decay,
      severe: auditSummary.severe,
      dead: auditSummary.dead,
      proposalsCreated: auditSummary.proposalsCreated,
      immediateDeprecated: auditSummary.immediateDeprecated,
    },
    gapAnalysis: {
      totalDimensions: requestedDimensions.length,
      gapDimensions: gapDimensions.length,
      skippedDimensions: skippedDimensions.map((d) => d.id),
      gaps: gapDimensions.map((d) => ({
        dimensionId: d.id,
        label: d.label,
        existing: coverageByDim[d.id] || 0,
        gap: TARGET_PER_DIM - (coverageByDim[d.id] || 0),
      })),
    },
    // Phase 1-4 分析摘要 (与 bootstrap-internal 对齐)
    languageStats: phaseResults.langStats || null,
    primaryLanguage: primaryLang,
    guardSummary: guardAudit
      ? {
          totalViolations: (guardAudit as GuardAudit).summary?.totalViolations || 0,
          errors: (guardAudit as GuardAudit).summary?.errors || 0,
          warnings: (guardAudit as GuardAudit).summary?.warnings || 0,
        }
      : null,
    astSummary: astProjectSummary
      ? {
          classes: (astProjectSummary as AstSummary).classes?.length || 0,
          protocols: (astProjectSummary as AstSummary).protocols?.length || 0,
          categories: (astProjectSummary as AstSummary).categories?.length || 0,
        }
      : null,
    codeEntityGraph: phaseResults.codeEntityResult
      ? {
          totalEntities:
            (phaseResults.codeEntityResult as { entityCount?: number }).entityCount || 0,
          totalEdges: (phaseResults.codeEntityResult as { edgeCount?: number }).edgeCount || 0,
        }
      : null,
    callGraph: phaseResults.callGraphResult
      ? {
          entitiesUpserted:
            (phaseResults.callGraphResult as { entitiesUpserted?: number }).entitiesUpserted || 0,
          edgesCreated:
            (phaseResults.callGraphResult as { edgesCreated?: number }).edgesCreated || 0,
        }
      : null,
    panorama: snapshot.panorama ? summarizePanorama(snapshot.panorama) : null,
    bootstrapSession: bootstrapSession ? bootstrapSession.toJSON() : null,
    sessionId,
    asyncFill: gapDimensions.length > 0,
    status: gapDimensions.length > 0 ? 'filling' : 'complete',
    files: allFiles.length,
    targets: allTargets.length,
  };

  // ═══════════════════════════════════════════════════════════
  // Step 7: 异步后台填充 gap 维度
  // ═══════════════════════════════════════════════════════════

  if (gapDimensions.length > 0 && !args.skipAsyncFill) {
    const fillView: PipelineFillView = {
      snapshot,
      ctx: ctx as RescanMcpContext & { logger: RescanLogger },
      bootstrapSession,
      targetFileMap,
      projectRoot,
    };

    // 构建 existingRecipes（含审计状态 + 完整内容），供管线内 Evolution Stage 使用
    const allExistingRecipes = recipeSnapshot.entries.map((e) => {
      const auditResult = auditSummary.results.find(
        (r: { recipeId: string }) => r.recipeId === e.id
      );
      const verdict = auditVerdictMap.get(e.id);
      const isDecaying = e.lifecycle === 'decaying' || verdict === 'decay' || verdict === 'severe';
      return {
        id: e.id,
        title: e.title,
        trigger: e.trigger,
        knowledgeType: e.knowledgeType,
        status: isDecaying ? ('decaying' as const) : ('healthy' as const),
        decayReason:
          isDecaying && auditResult?.decayReasons
            ? (auditResult.decayReasons as string[]).join('; ')
            : undefined,
        auditScore: (auditResult as { relevanceScore?: number } | undefined)?.relevanceScore,
        // Evolution Agent 需要完整内容来验证 Recipe 真实性
        content: e.content as
          | { markdown?: string; rationale?: string; coreCode?: string }
          | undefined,
        sourceRefs: e.sourceRefs as string[] | undefined,
        auditEvidence: (auditResult as { evidence?: Record<string, unknown> } | undefined)
          ?.evidence,
      };
    });
    dispatchPipelineFill(
      { ...fillView, existingRecipes: allExistingRecipes, evolutionPrescreen: prescreen },
      gapDimensions,
      fillDimensionsV3,
      'Rescan-Internal'
    );
  } else if (gapDimensions.length === 0) {
    ctx.logger.info('[Rescan-Internal] All dimensions fully covered — no async fill needed');
  }

  // ── SkillHooks: onRescanComplete (fire-and-forget) ──
  try {
    const skillHooks = ctx.container.get('skillHooks');
    skillHooks
      .run(
        'onRescanComplete',
        {
          filesScanned: allFiles.length,
          targetsFound: allTargets.length,
          gapDimensions: gapDimensions.length,
          preservedRecipes: recipeSnapshot.count,
          auditSummary: {
            healthy: auditSummary.healthy,
            decay: auditSummary.decay,
            dead: auditSummary.dead,
          },
        },
        { projectRoot: ctx.container.get('database')?.filename || '' }
      )
      .catch(() => {}); // fire-and-forget
  } catch {
    /* skillHooks not available */
  }

  return envelope({
    success: true,
    data: responseData,
    message:
      gapDimensions.length > 0
        ? `增量扫描骨架已创建：保留 ${recipeSnapshot.count} 个 Recipe，${gapDimensions.length} 个维度需要补齐，正在后台填充...`
        : `增量扫描完成：保留 ${recipeSnapshot.count} 个 Recipe，所有维度已充分覆盖。`,
    meta: { tool: 'alembic_rescan', responseTimeMs: Date.now() - t0 },
  });
}
