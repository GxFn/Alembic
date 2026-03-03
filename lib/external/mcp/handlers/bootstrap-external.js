/**
 * MCP Handler — 外部 Agent 驱动的 Bootstrap (External-Agent-Driven)
 *
 * `autosnippet_bootstrap` 的主入口（无参数）：
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
import { envelope } from '../envelope.js';
import { BootstrapSessionManager } from './bootstrap/BootstrapSession.js';
import { buildMissionBriefing } from './bootstrap/MissionBriefingBuilder.js';
import { runAllPhases } from './bootstrap/shared/bootstrap-phases.js';
import { buildLanguageExtension } from './LanguageExtensions.js';

// ── 进程级 Session 管理器 ─────────────────────────────────────

let _sessionManager = null;

/**
 * 获取或创建 BootstrapSessionManager
 * @param {object} container — ServiceContainer
 * @returns {BootstrapSessionManager}
 */
function getSessionManager(container) {
  // 优先使用容器注册的 (如果已注册)
  try {
    const mgr = container.get('bootstrapSessionManager');
    if (mgr) return mgr;
  } catch { /* not registered yet */ }

  // 降级为模块级单例
  if (!_sessionManager) {
    _sessionManager = new BootstrapSessionManager();
  }

  // 注册到容器，让 submitKnowledgeBatch / consolidated 等 handler 也能访问
  try {
    container.register('bootstrapSessionManager', () => _sessionManager);
  } catch { /* already registered or container doesn't support register */ }

  return _sessionManager;
}

// ── 主入口 ─────────────────────────────────────────────────────

/**
 * bootstrapExternal — 外部 Agent 驱动的一键冷启动
 *
 * 无参数调用，返回 Mission Briefing。
 * Phase 1-4 复用现有 bootstrap.js 逻辑，Phase 5 不启动。
 *
 * @param {object} ctx — { container, logger, startedAt }
 * @returns {Promise<object>} — envelope({ success, data: MissionBriefing })
 */
export async function bootstrapExternal(ctx) {
  const t0 = Date.now();
  const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();

  // ═══════════════════════════════════════════════════════════
  // Phase 1-4: 共享数据收集管线
  // ═══════════════════════════════════════════════════════════

  const phaseResults = await runAllPhases(projectRoot, ctx, {
    maxFiles: 500,
    contentMaxLines: 120,
    sourceTag: 'bootstrap-external',
    summaryPrefix: 'Bootstrap-external scan',
    clearOldData: true,
    generateReport: true,
    incremental: true,
  });

  // 空项目 fast-path
  if (phaseResults.isEmpty) {
    return envelope({
      success: true,
      data: { message: 'No source files found. Nothing to bootstrap.' },
      meta: { tool: 'autosnippet_bootstrap', responseTimeMs: Date.now() - t0 },
    });
  }

  const {
    allFiles, primaryLang, depGraphData, langStats,
    astProjectSummary, codeEntityResult, callGraphResult, guardAudit,
    activeDimensions: dimensions, targetsSummary,
    langProfile, incrementalPlan,
  } = phaseResults;

  // ═══════════════════════════════════════════════════════════
  // Phase 4: 构建 Mission Briefing
  // ═══════════════════════════════════════════════════════════

  // 创建 BootstrapSession
  const sessionManager = getSessionManager(ctx.container);
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
  session.setPhaseCache({
    allFiles,
    astProjectSummary,
    codeEntityResult,
    callGraphResult,
    depGraphData,
    guardAudit,
    langStats,
    primaryLang,
    targetsSummary,
  });

  // 构建 projectMeta
  const projectMeta = {
    name: path.basename(projectRoot),
    primaryLanguage: primaryLang,
    secondaryLanguages: langProfile.secondary || [],
    isMultiLang: langProfile.isMultiLang || false,
    fileCount: allFiles.length,
    projectType: phaseResults.discoverer.id,
    projectRoot,
  };

  // 构建 Mission Briefing
  const briefing = buildMissionBriefing({
    projectMeta,
    astData: astProjectSummary,
    codeEntityResult,
    callGraphResult,
    depGraphData,
    guardAudit,
    targets: targetsSummary,
    activeDimensions: dimensions,
    session,
    languageExtension: buildLanguageExtension(primaryLang),  // §7.1
    incrementalPlan,
    languageStats: langStats,
  });

  // 附加 warnings
  if (phaseResults.warnings.length > 0) {
    briefing.meta = briefing.meta || {};
    briefing.meta.warnings = [...(briefing.meta.warnings || []), ...phaseResults.warnings];
  }

  ctx.logger.info(
    `[BootstrapExternal] Mission Briefing ready: ${allFiles.length} files, ${dimensions.length} dims, ` +
    `${briefing.meta?.responseSizeKB || '?'}KB — session ${session.id}`
  );

  return envelope({
    success: true,
    data: briefing,
    meta: { tool: 'autosnippet_bootstrap', responseTimeMs: Date.now() - t0 },
  });
}

/**
 * 获取当前 active session（供其他 handler 使用）
 * @param {object} container
 * @param {string} [sessionId]
 * @returns {import('./bootstrap/BootstrapSession.js').BootstrapSession|null}
 */
export function getActiveSession(container, sessionId) {
  const mgr = getSessionManager(container);
  return mgr.getSession(sessionId);
}
