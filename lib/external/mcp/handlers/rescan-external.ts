/**
 * MCP Handler — autosnippet_rescan (增量知识更新)
 *
 * 保留已审核 Recipe，清理衍生缓存，全量/指定维度重新扫描，
 * 新知识通过批量提交走正常的进化架构。
 *
 * 流程:
 *   1. snapshotRecipes — 快照保留知识
 *   2. rescanClean — 清理衍生缓存
 *   3. Phase 1-4 全量分析
 *   4. RecipeRelevanceAuditor — 证据验证 + 快速衰退
 *   5. 构建 Mission Briefing（含 existingRecipes / decayedRecipes）
 *   6. 返回给 Agent 执行 Phase 5 维度扫描
 *
 * @module handlers/rescan-external
 */

import path from 'node:path';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import { CleanupService } from '#service/cleanup/CleanupService.js';
import { RecipeRelevanceAuditor } from '#service/evolution/RecipeRelevanceAuditor.js';
import { resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import type { RescanInput } from '#shared/schemas/mcp-tools.js';
import type { MissionBriefingResult, ProjectSnapshot } from '#types/project-snapshot.js';
import { buildProjectSnapshot } from '#types/project-snapshot-builder.js';
import { toSessionCache } from '#types/snapshot-views.js';
import { envelope } from '../envelope.js';
import { buildMissionBriefing } from './bootstrap/MissionBriefingBuilder.js';
import { extractCodeEntities, extractDependencyEdges } from './bootstrap/shared/audit-helpers.js';
import { runAllPhases } from './bootstrap/shared/bootstrap-phases.js';
import { getOrCreateSessionManager } from './bootstrap/shared/session-helpers.js';
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

// ── 主入口 ─────────────────────────────────────────────────

export async function rescanExternal(ctx: McpContext, args: RescanInput) {
  const t0 = Date.now();
  const projectRoot = resolveProjectRoot(ctx.container);
  const db = ctx.container.get('database');

  // ═══════════════════════════════════════════════════════════
  // Step 1: 快照现有知识
  // ═══════════════════════════════════════════════════════════

  const cleanupService = new CleanupService({
    projectRoot,
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
      const rawDb =
        typeof (db as { getDb?: () => unknown })?.getDb === 'function'
          ? (db as { getDb: () => unknown }).getDb()
          : db;
      const syncReport = syncService.sync(rawDb as Parameters<typeof syncService.sync>[0], {
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
      meta: { tool: 'autosnippet_rescan', responseTimeMs: Date.now() - t0 },
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

  const auditor = new RecipeRelevanceAuditor({
    db,
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
  // Step 5: 构建 Mission Briefing + 过滤维度
  // ═══════════════════════════════════════════════════════════

  // 按需过滤维度
  const dimensions = args.dimensions?.length
    ? allDimensions.filter((d) => args.dimensions!.includes(d.id))
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

  const healthyRecipes = auditSummary.results
    .filter((r) => r.verdict === 'healthy' || r.verdict === 'watch')
    .map((r) => {
      const snap = snapshotById.get(r.recipeId);
      return {
        id: r.recipeId,
        title: r.title,
        trigger: snap?.trigger || '',
        knowledgeType: snap?.knowledgeType || '',
        doClause: snap?.doClause || '',
        relevanceScore: r.relevanceScore,
        verdict: r.verdict,
      };
    });

  const decayedRecipes = auditSummary.results
    .filter((r) => r.verdict === 'decay' || r.verdict === 'severe' || r.verdict === 'dead')
    .map((r) => {
      const snap = snapshotById.get(r.recipeId);
      return {
        id: r.recipeId,
        title: r.title,
        trigger: snap?.trigger || '',
        knowledgeType: snap?.knowledgeType || '',
        relevanceScore: r.relevanceScore,
        verdict: r.verdict,
        decayReasons: r.decayReasons,
        action:
          r.verdict === 'dead'
            ? 'deprecated'
            : r.verdict === 'severe'
              ? 'decaying (3d grace)'
              : 'decaying (7d grace)',
      };
    });

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

  // ── 注入 evidenceHints ──
  (briefing as Record<string, unknown>).evidenceHints = {
    existingRecipes: healthyRecipes,
    decayedRecipes,
    rescanMode: true,
    dimensionGaps,
    constraints: {
      occupiedTriggers,
      rules: [
        '禁止提交 occupiedTriggers 列表中已存在的 trigger',
        '每个维度的补齐数量参考 dimensionGaps[].gap，gap=0 的维度可以跳过或只提交真正的新发现',
        '专注于尚未覆盖的新模式，不要重复已有知识的内容',
      ],
    },
    rescanInstructions:
      '这是增量扫描（rescan）模式。以下知识已存在并已审核，你的任务是**补齐**尚未覆盖的知识。' +
      '请查看 dimensionGaps 了解每个维度的现有覆盖和补齐目标。' +
      'gap=0 的维度已覆盖充分，只在发现全新模式时才提交；gap>0 的维度需要补齐。' +
      '标记为衰退的 Recipe 不要重复提交类似内容。',
  };

  // ── 覆盖 executionPlan.workflow 为 rescan 专属版本 ──
  const briefingRecord = briefing as Record<string, unknown>;
  if (briefingRecord.executionPlan && typeof briefingRecord.executionPlan === 'object') {
    (briefingRecord.executionPlan as Record<string, unknown>).workflow =
      '【增量扫描模式】对每个维度: ' +
      '(1) 查看 evidenceHints.dimensionGaps 中该维度的 gap 值和已有 triggers → ' +
      '(2) 用原生能力阅读代码，专注发现已有 recipes 未覆盖的新模式 → ' +
      '(3) 调用 autosnippet_submit_knowledge_batch 提交新发现（数量 = gap 值，gap=0 则跳过或仅提交全新发现） → ' +
      '(4) 调用 autosnippet_dimension_complete 完成维度';
  }

  const dimGapLog = dimensionGaps
    .map((g) => `${g.dimensionId}(${g.existingCount}→gap ${g.gap})`)
    .join(', ');
  ctx.logger.info(
    `[Rescan] Mission Briefing ready: ${allFiles.length} files, ${dimensions.length} dims, ` +
      `preserved: ${recipeSnapshot.count}, decayed: ${decayedRecipes.length}, totalGap: ${totalGap} — session ${session.id}`
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
      `✅ Rescan 完成项目扫描，保留 ${recipeSnapshot.count} 个 Recipe（衰退 ${decayedRecipes.length} 个），` +
      `${coveredDims}/${dimensions.length} 个维度已充分覆盖。` +
      `${gapSummary}` +
      `按 executionPlan.tiers 顺序，对每个维度执行：` +
      `(1) 查看 evidenceHints.dimensionGaps 了解该维度的补齐目标 → ` +
      `(2) 分析代码，专注发现未覆盖的新模式 → ` +
      `(3) 调用 autosnippet_submit_knowledge 提交新发现（数量参考 gap 值） → ` +
      `(4) 调用 autosnippet_dimension_complete 标记完成。` +
      `注意: evidenceHints.constraints.occupiedTriggers 中的 trigger 已被占用，请勿重复。`,
    meta: { tool: 'autosnippet_rescan', responseTimeMs: Date.now() - t0 },
  });
}
