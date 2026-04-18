/**
 * MCP Handler — asd_rescan (增量知识更新)
 *
 * 保留已审核 Recipe，清理衍生缓存，全量/指定维度重新扫描，
 * 新知识通过批量提交走正常的进化架构。
 *
 * 流程:
 *   1. snapshotRecipes — 快照保留知识
 *   2. rescanClean — 清理衍生缓存
 *   3. Phase 1-4 全量分析
 *   4. RecipeRelevanceAuditor — 证据验证 + 快速衰退
 *   5. 构建 Mission Briefing（含 allRecipes + evolutionGuide）
 *   6. 返回给 Agent 按维度执行: evolve → gap-fill → dimension_complete
 *
 * @module handlers/rescan-external
 */

import path from 'node:path';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import { CleanupService } from '#service/cleanup/CleanupService.js';
import { RelevanceAuditor } from '#service/evolution/RelevanceAuditor.js';
import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import type { RescanInput } from '#shared/schemas/mcp-tools.js';
import type { MissionBriefingResult, ProjectSnapshot } from '#types/project-snapshot.js';
import { buildProjectSnapshot } from '#types/project-snapshot-builder.js';
import { toSessionCache } from '#types/snapshot-views.js';
import { envelope } from '../envelope.js';
import { buildMissionBriefing } from './bootstrap/MissionBriefingBuilder.js';
import { extractCodeEntities, extractDependencyEdges } from './bootstrap/shared/audit-helpers.js';
import { runAllPhases } from './bootstrap/shared/bootstrap-phases.js';
import { getOrCreateSessionManager } from './bootstrap/shared/session-helpers.js';
import { buildEvolutionPrescreen } from './evolution-prescreen.js';
import { buildLanguageExtension } from './LanguageExtensions.js';

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

// ── Helpers ─────────────────────────────────────────────────

function truncate(s: string | undefined | null, max: number): string {
  if (!s) {
    return '';
  }
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

// ── 主入口 ─────────────────────────────────────────────────

export async function rescanExternal(ctx: McpContext, args: RescanInput) {
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

  ctx.logger.info(`[Rescan] Preserved ${recipeSnapshot.count} recipes`, {
    coverageByDimension: recipeSnapshot.coverageByDimension,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 2: 清理衍生缓存
  // ═══════════════════════════════════════════════════════════

  const cleanResult = await cleanupService.rescanClean();

  // ═══════════════════════════════════════════════════════════
  // Step 2.5: Recipe 文件 ↔ DB 一致性恢复 + 向量索引重建
  // ═══════════════════════════════════════════════════════════

  // 2.5a: KnowledgeSyncService — 恢复 Recipe 文件 ↔ DB 一致性
  //   rescanClean 保留了 recipes/ 文件和 active/published/staging/evolving DB 记录，
  //   但清除了 recipe_source_refs 等桥接表，需重新同步。
  try {
    const syncService = ctx.container.services.knowledgeSyncService
      ? ctx.container.get('knowledgeSyncService')
      : null;
    if (syncService) {
      const syncReport = syncService.sync(db, {
        force: true,
      });
      ctx.logger.info('[Rescan] KnowledgeSyncService sync complete', {
        synced: syncReport.synced,
        created: syncReport.created,
        updated: syncReport.updated,
      });
    }
  } catch (e: unknown) {
    ctx.logger.warn(
      `[Rescan] KnowledgeSyncService sync failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // NOTE: 不在 rescan 中调用 VectorService.fullBuild()
  // 理由：fullBuild 依赖外部 embedding API（LLM），在 MCP handler 同步路径中
  // 引入 LLM 调用不合理（无超时、可能阻塞、需要 API key）。
  // 向量索引会在后续 Agent 提交新知识时由 SyncCoordinator 增量更新。

  // ═══════════════════════════════════════════════════════════
  // Step 3: Phase 1-4 全量分析
  // ═══════════════════════════════════════════════════════════

  const phaseResults = await runAllPhases(projectRoot, ctx, {
    maxFiles: 500,
    contentMaxLines: 120,
    sourceTag: 'rescan-external',
    summaryPrefix: 'Rescan scan',
    clearOldData: false, // 已由 rescanClean 清理
    generateReport: true,
    incremental: false,
  });

  // 空项目 fast-path
  if (phaseResults.isEmpty) {
    return envelope({
      success: true,
      data: { message: 'No source files found. Nothing to rescan.' },
      meta: { tool: 'asd_rescan', responseTimeMs: Date.now() - t0 },
    });
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

  // ═══════════════════════════════════════════════════════════
  // Step 4.5: 构建进化前置过滤（Phase A）
  // ═══════════════════════════════════════════════════════════

  const prescreen = buildEvolutionPrescreen(auditSummary, recipeSnapshot.entries, allDimensions);

  ctx.logger.info('[Rescan] Evolution prescreen built', {
    needsVerification: prescreen.needsVerification.length,
    autoResolved: prescreen.autoResolved.length,
  });

  // ═══════════════════════════════════════════════════════════
  // Step 5: 构建 Mission Briefing + 过滤维度
  // ═══════════════════════════════════════════════════════════

  // 按需过滤维度
  const dimensions = args.dimensions?.length
    ? allDimensions.filter((d) => args.dimensions?.includes(d.id))
    : allDimensions;

  // 创建 Session
  const sessionManager = getOrCreateSessionManager(ctx.container);
  const session = sessionManager.createSession({
    projectRoot,
    dimensions,
    projectContext: {
      projectName: path.basename(projectRoot),
      primaryLang,
      fileCount: allFiles.length,
      modules: depGraphData?.nodes?.length || 0,
    },
  });

  // 缓存 Phase 结果
  session.setSnapshotCache(toSessionCache(snapshot));

  // 构建 projectMeta
  const projectMeta = {
    name: path.basename(projectRoot),
    primaryLanguage: primaryLang,
    secondaryLanguages: (langProfile as { secondary?: string[] }).secondary || [],
    isMultiLang: (langProfile as { isMultiLang?: boolean }).isMultiLang || false,
    fileCount: allFiles.length,
    projectType: snapshot.discoverer.id,
    projectRoot,
  };

  // 构建 Mission Briefing
  const briefing: MissionBriefingResult = buildMissionBriefing({
    projectMeta,
    astData: astProjectSummary,
    codeEntityResult,
    callGraphResult,
    depGraphData,
    guardAudit,
    targets: targetsSummary,
    activeDimensions: dimensions,
    session,
    languageExtension: buildLanguageExtension(primaryLang),
    languageStats: langStats,
    panoramaResult: snapshot.panorama,
    localPackageModules,
  });

  // 附加 warnings
  if (phaseResults.warnings.length > 0) {
    briefing.meta = briefing.meta || {};
    briefing.meta.warnings = [...(briefing.meta.warnings || []), ...phaseResults.warnings];
  }

  // ═══════════════════════════════════════════════════════════
  // Step 6: 注入 evidenceHints (含 trigger/维度/doClause)
  // ═══════════════════════════════════════════════════════════

  // 建立 recipeId → snapshot entry 映射，用于补充 audit 结果中缺少的字段
  const snapshotById = new Map(recipeSnapshot.entries.map((e) => [e.id, e]));

  // ── 构建 allRecipes: 全部 Recipe (healthy + decaying) 含完整内容 + auditHint ──
  const allRecipes = auditSummary.results
    .filter((r) => r.verdict !== 'dead') // dead 已直接 deprecated
    .map((r) => {
      const snap = snapshotById.get(r.recipeId);
      const content = snap?.content as
        | { markdown?: string; rationale?: string; coreCode?: string }
        | undefined;
      const sourceRefs = (snap?.sourceRefs ?? []) as string[];
      return {
        id: r.recipeId,
        title: r.title,
        trigger: snap?.trigger || '',
        knowledgeType: snap?.knowledgeType || '',
        doClause: snap?.doClause || '',
        lifecycle: snap?.lifecycle || 'active',
        // 完整内容（截断控制）
        content: content
          ? {
              markdown: truncate(content.markdown, 500),
              rationale: truncate(content.rationale, 200),
              coreCode: truncate(content.coreCode, 400),
            }
          : null,
        sourceRefs: sourceRefs.slice(0, 5),
        // 系统预检
        auditHint: {
          relevanceScore: r.relevanceScore,
          verdict: r.verdict as 'healthy' | 'watch' | 'decay' | 'severe',
          decayReasons: r.decayReasons || [],
        },
      };
    });

  const decayCount = allRecipes.filter(
    (r) => r.auditHint.verdict === 'decay' || r.auditHint.verdict === 'severe'
  ).length;

  // ── 按维度分组现有 recipes，计算每维度的补齐配额 ──
  // 覆盖采用加权策略：
  //   - active/evolving: 确认知识，始终计入覆盖
  //   - staging + audit healthy/watch: 待审但仍有效的候选，计入覆盖
  //   - staging + audit decay/severe/dead: 已过时的候选，不计入覆盖但占位去重
  const TARGET_PER_DIM = 5;
  const auditVerdictMap = new Map(auditSummary.results.map((r) => [r.recipeId, r.verdict]));
  const coverageByDim: Record<
    string,
    Array<{ title: string; trigger: string; doClause: string }>
  > = {};
  for (const entry of recipeSnapshot.entries) {
    const dim = entry.knowledgeType || 'unknown';
    const isConfirmed = entry.lifecycle === 'active' || entry.lifecycle === 'evolving';
    const verdict = auditVerdictMap.get(entry.id);
    // staging 条目：无 audit 结果时默认计入（首次冷启动后无 audit 数据），audit 通过时计入
    const isHealthyStaging =
      entry.lifecycle === 'staging' && (!verdict || verdict === 'healthy' || verdict === 'watch');

    if (isConfirmed || isHealthyStaging) {
      if (!coverageByDim[dim]) {
        coverageByDim[dim] = [];
      }
      coverageByDim[dim].push({
        title: entry.title,
        trigger: entry.trigger,
        doClause: entry.doClause || '',
      });
    }
  }

  const dimensionGaps: Array<{
    dimensionId: string;
    existingCount: number;
    gap: number;
    existingTriggers: string[];
  }> = dimensions.map((d) => {
    const existing = coverageByDim[d.id] || [];
    return {
      dimensionId: d.id,
      existingCount: existing.length,
      gap: Math.max(0, TARGET_PER_DIM - existing.length),
      existingTriggers: existing.map((e) => e.trigger).filter(Boolean),
    };
  });

  const totalGap = dimensionGaps.reduce((sum, g) => sum + g.gap, 0);
  // occupiedTriggers 包含全量（含 audit-failed 的 staging），防止 trigger 冲突
  const occupiedTriggers = recipeSnapshot.entries.map((e) => e.trigger).filter(Boolean);

  // ── 注入 evidenceHints (allRecipes + evolutionGuide + dimensionGaps + prescreen) ──
  (briefing as Record<string, unknown>).evidenceHints = {
    allRecipes,
    rescanMode: true,
    dimensionGaps,
    evolutionPrescreen: {
      needsVerification: prescreen.needsVerification,
      autoResolved: prescreen.autoResolved,
      dimensionGapsByPrescreen: prescreen.dimensionGaps,
    },
    evolutionGuide: {
      decayCount,
      totalCount: allRecipes.length,
      instructions:
        decayCount > 0
          ? `${decayCount} 个 Recipe 标记为衰退，需优先验证。每个维度内先 evolve 再补齐。`
          : '所有 Recipe 状态健康，快速确认后补齐新知识。',
    },
    constraints: {
      occupiedTriggers,
      rules: [
        '禁止提交 occupiedTriggers 列表中已存在的 trigger',
        '每个维度的补齐数量参考 dimensionGaps[].gap，gap=0 的维度可以跳过或只提交真正的新发现',
        '专注于尚未覆盖的新模式，不要重复已有知识的内容',
      ],
    },
  };

  // ── 覆盖 executionPlan.workflow 为 rescan 专属版本 (per-dimension evolve + gap-fill) ──
  const briefingRecord = briefing as Record<string, unknown>;
  if (briefingRecord.executionPlan && typeof briefingRecord.executionPlan === 'object') {
    (briefingRecord.executionPlan as Record<string, unknown>).workflow =
      '【增量扫描模式 — 进化前置 + 按维度 Gap-Fill】 ' +
      'Step 0 — 自动前置过滤 (已完成): ' +
      `healthy 无修改的 Recipe 已自动 skip (${prescreen.autoResolved.length} 条)，` +
      `仅 ${prescreen.needsVerification.length} 条需要验证。 ` +
      '对每个维度 (按 tiers 顺序): ' +
      'Step 1 — Evolve (仅 needsVerification 中的 Recipe): ' +
      '读 sourceRefs 源码验证 → 调用 asd_evolve({ decisions: [本维度决策] }) → ' +
      'Step 2 — Gap-Fill: ' +
      '分析代码发现新模式 → 调用 asd_submit_knowledge 提交 (数量参考 gap 值) → ' +
      'Step 3 — Complete: 调用 asd_dimension_complete 完成维度';
  }

  const dimGapLog = dimensionGaps
    .map((g) => `${g.dimensionId}(${g.existingCount}→gap ${g.gap})`)
    .join(', ');
  ctx.logger.info(
    `[Rescan] Mission Briefing ready: ${allFiles.length} files, ${dimensions.length} dims, ` +
      `preserved: ${recipeSnapshot.count}, decayed: ${decayCount}, totalGap: ${totalGap} — session ${session.id}`
  );
  ctx.logger.info(`[Rescan] Dimension gaps: ${dimGapLog}`);

  // ── 构建 gap 摘要信息 ──
  const gapSummaryParts = dimensionGaps
    .filter((g) => g.gap > 0)
    .map((g) => `${g.dimensionId}(需补${g.gap}条)`);
  const coveredDims = dimensionGaps.filter((g) => g.gap === 0).length;
  const gapSummary =
    gapSummaryParts.length > 0
      ? `需补齐维度: ${gapSummaryParts.join('、')}。`
      : '所有维度已充分覆盖，仅在发现全新模式时提交。';

  return envelope({
    success: true,
    data: {
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
      ...briefing,
    },
    message:
      `✅ Rescan 完成项目扫描，保留 ${recipeSnapshot.count} 个 Recipe（衰退 ${decayCount} 个），` +
      `${coveredDims}/${dimensions.length} 个维度已充分覆盖。` +
      `${gapSummary}` +
      `对每个维度执行三步：` +
      `(1) asd_evolve — 过滤 allRecipes 中本维度 Recipe，读源码验证后提交决策 → ` +
      `(2) asd_submit_knowledge — 分析代码，发现未覆盖的新模式 → ` +
      `(3) asd_dimension_complete — 标记维度完成。` +
      `注意: evidenceHints.constraints.occupiedTriggers 中的 trigger 已被占用，请勿重复。`,
    meta: { tool: 'asd_rescan', responseTimeMs: Date.now() - t0 },
  });
}
