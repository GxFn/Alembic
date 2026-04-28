/**
 * MCP Handler — 外部 Agent 驱动的 Bootstrap (External-Agent-Driven)
 *
 * `alembic_bootstrap` 的主入口（无参数）：
 *   Phase 1-4 同步执行（文件收集 / AST / 依赖图 / Guard）
 *   → 构建 Mission Briefing 一次性返回
 *   → 不启动 Phase 5 异步 AI pipeline
 *   → 等待外部 Agent (Cursor/Copilot) 主动提交知识 + 完成维度
 *
 * 与 bootstrap-internal.js 的关系：
 *   - 本文件: 外部 Agent 路径 — Agent 自己分析代码 + 提交知识，不需要 AI Provider
 *   - bootstrap-internal.js: 内部 Agent 路径 — 内置 Analyst/Producer pipeline，需要 API Key
 *   - 两者共享 Phase 1-4 的分析逻辑 → bootstrap/shared/bootstrap-phases.js
 *
 * @module handlers/bootstrap-external
 */

import path from 'node:path';
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import { CleanupService } from '#service/cleanup/CleanupService.js';
import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import type { MissionBriefingResult } from '#types/project-snapshot.js';
import { toSessionCache } from '#types/snapshot-views.js';
import { buildMissionBriefing } from '#workflows/deprecated-cold-start/briefing/MissionBriefingBuilder.js';
import { ScanLifecycleRunner } from '#workflows/scan/lifecycle/ScanLifecycleRunner.js';
import { envelope } from '../envelope.js';
import { getOrCreateSessionManager } from './bootstrap/shared/session-helpers.js';
import { buildLanguageExtension } from './LanguageExtensions.js';

/** MCP handler context passed from McpServer */
interface McpContext {
  container: ServiceContainer;
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
  startedAt?: number;
  [key: string]: unknown;
}

// ── 主入口 ─────────────────────────────────────────────────────

/**
 * bootstrapExternal — 外部 Agent 驱动的一键冷启动
 *
 * 无参数调用，返回 Mission Briefing。
 * Phase 1-4 复用现有 bootstrap.js 逻辑，Phase 5 不启动。
 *
 * @param ctx { container, logger, startedAt }
 * @returns envelope({ success, data: MissionBriefing })
 */
export async function bootstrapExternal(ctx: McpContext) {
  const t0 = Date.now();
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveDataRoot(ctx.container);

  // ═══════════════════════════════════════════════════════════
  // Step 1: 全量清理 (CleanupService.fullReset)
  // ═══════════════════════════════════════════════════════════

  const db = ctx.container.get('database');
  const cleanupService = new CleanupService({
    projectRoot: dataRoot,
    db,
    logger: ctx.logger,
  });
  const cleanupResult = await cleanupService.fullReset();
  const scanLifecycleRunner = ScanLifecycleRunner.fromContainer(ctx.container, ctx.logger);

  // ═══════════════════════════════════════════════════════════
  // Phase 1-4: 共享数据收集管线（永远全量，无增量检测）
  // ═══════════════════════════════════════════════════════════

  const { phaseResults, snapshot, scanContext } =
    await scanLifecycleRunner.prepareColdStartBaseline(
      {
        projectRoot,
        ctx,
        sourceTag: 'bootstrap-external',
        phaseOptions: {
          maxFiles: 500,
          contentMaxLines: 120,
          summaryPrefix: 'Bootstrap-external scan',
          clearOldData: true,
          generateReport: true,
          incremental: false,
          dataRoot,
        },
      },
      {
        enabled: true,
        retrieveEvidence: true,
      }
    );

  // 空项目 fast-path
  if (snapshot.isEmpty) {
    return envelope({
      success: true,
      data: { message: 'No source files found. Nothing to bootstrap.' },
      meta: { tool: 'alembic_bootstrap', responseTimeMs: Date.now() - t0 },
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
    activeDimensions: dimensions,
    targetsSummary,
    localPackageModules,
    langProfile,
  } = phaseResults;

  // ═══════════════════════════════════════════════════════════
  // Phase 4: 构建 Mission Briefing
  // ═══════════════════════════════════════════════════════════

  // 创建 BootstrapSession
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

  // 缓存 Phase 结果供 wiki_plan 复用
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
    languageExtension: buildLanguageExtension(primaryLang), // §7.1
    languageStats: langStats,
    panoramaResult: snapshot.panorama, // §M1: Phase 2.2 全景数据
    localPackageModules, // 本地子包模块信息
  });

  // 附加 warnings
  if (phaseResults.warnings.length > 0) {
    briefing.meta = briefing.meta || {};
    briefing.meta.warnings = [...(briefing.meta.warnings || []), ...phaseResults.warnings];
  }

  const completed = scanLifecycleRunner.completeAndProjectColdStartRun(scanContext, {
    missionBriefing: true,
    dimensions: dimensions.length,
    files: allFiles.length,
    targets: targetsSummary.length,
  });
  briefing.meta = briefing.meta || {};
  briefing.meta.scanContext = completed.summary;

  ctx.logger.info(
    `[BootstrapExternal] Mission Briefing ready: ${allFiles.length} files, ${dimensions.length} dims, ` +
      `${briefing.meta?.responseSizeKB || '?'}KB — session ${session.id}`
  );

  return envelope({
    success: true,
    data: {
      cleanup: {
        deletedRecipes: cleanupResult.deletedFiles,
        clearedTables: cleanupResult.clearedTables.length,
        dbCleared: true,
        errors: cleanupResult.errors,
        trash: cleanupResult.trash ?? null,
        purgedTrash: cleanupResult.purgedTrash ?? null,
      },
      ...briefing,
    },
    message:
      `⚠️ Bootstrap 仅完成第一步（项目扫描），你必须继续完成全部 ${dimensions.length} 个维度的分析。` +
      `请立即按 executionPlan.tiers 的顺序，对每个维度执行：` +
      `(1) 用你的代码阅读能力分析该维度相关文件 → ` +
      `(2) 调用 alembic_submit_knowledge_batch 提交候选知识（**每维度最少 3 条，目标 5 条**，不同关注点拆为独立候选） → ` +
      `(3) 调用 alembic_dimension_complete 标记维度完成。` +
      `不要停下来等待用户确认，直接开始第一个维度。`,
    meta: { tool: 'alembic_bootstrap', responseTimeMs: Date.now() - t0 },
  });
}

/**
 * 获取当前 active session（供其他 handler 使用）
 *
 * 当指定了 sessionId 时，如果 active session 已过期但 id 匹配，
 * 仍然返回该 session（支持新 bootstrap 创建后旧 session 的 dimension_complete 继续工作）。
 */
export function getActiveSession(container: ServiceContainer, sessionId?: string) {
  const mgr = getOrCreateSessionManager(container);
  const session = mgr.getSession(sessionId);
  if (session) {
    return session;
  }

  // 当指定了 sessionId 但 active session 已过期/被替换时，
  // 尝试用 getAnySession() 恢复 — 防止正在进行的维度完成调用因新 bootstrap 而失败
  if (sessionId) {
    const anySession = mgr.getAnySession();
    if (anySession && anySession.id === sessionId) {
      return anySession;
    }
  }

  return null;
}
