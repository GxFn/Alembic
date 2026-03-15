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
import type { ServiceContainer } from '#inject/ServiceContainer.js';
import { resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { envelope } from '../envelope.js';
import { BootstrapSessionManager } from './bootstrap/BootstrapSession.js';
import { buildMissionBriefing } from './bootstrap/MissionBriefingBuilder.js';
import { runAllPhases } from './bootstrap/shared/bootstrap-phases.js';
import { buildLanguageExtension } from './LanguageExtensions.js';

/** MCP handler context passed from McpServer */
interface McpContext {
  container: ServiceContainer;
  logger: { info(msg: string, meta?: Record<string, unknown>): void };
  startedAt?: number;
  [key: string]: unknown;
}

/** Shape of the mission briefing returned by buildMissionBriefing */
interface MissionBriefingResult {
  meta?: {
    warnings?: string[];
    responseSizeKB?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ── 进程级 Session 管理器 ─────────────────────────────────

let _sessionManager: BootstrapSessionManager | null = null;

/**
 * 获取或创建 BootstrapSessionManager
 * @param container ServiceContainer
 */
function getSessionManager(container: ServiceContainer): BootstrapSessionManager {
  // 优先使用容器注册的 (如果已注册)
  try {
    const mgr = container.get('bootstrapSessionManager');
    if (mgr) {
      return mgr as unknown as BootstrapSessionManager;
    }
  } catch {
    /* not registered yet */
  }

  // 降级为模块级单例
  if (!_sessionManager) {
    _sessionManager = new BootstrapSessionManager();
  }

  // 注册到容器，让 submitKnowledgeBatch / consolidated 等 handler 也能访问
  try {
    container.register('bootstrapSessionManager', () => _sessionManager);
  } catch {
    /* already registered or container doesn't support register */
  }

  return _sessionManager;
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
    langProfile,
    incrementalPlan,
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
    secondaryLanguages: (langProfile as { secondary?: string[] }).secondary || [],
    isMultiLang: (langProfile as { isMultiLang?: boolean }).isMultiLang || false,
    fileCount: allFiles.length,
    projectType: phaseResults.discoverer.id,
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
    message:
      `⚠️ Bootstrap 仅完成第一步（项目扫描），你必须继续完成全部 ${dimensions.length} 个维度的分析。` +
      `请立即按 executionPlan.tiers 的顺序，对每个维度执行：` +
      `(1) 用你的代码阅读能力分析该维度相关文件 → ` +
      `(2) 调用 autosnippet_submit_knowledge_batch 提交候选知识（**每维度最少 3 条，目标 5 条**，不同关注点拆为独立候选） → ` +
      `(3) 调用 autosnippet_dimension_complete 标记维度完成。` +
      `不要停下来等待用户确认，直接开始第一个维度。`,
    meta: { tool: 'autosnippet_bootstrap', responseTimeMs: Date.now() - t0 },
  });
}

/**
 * 获取当前 active session（供其他 handler 使用）
 *
 * 当指定了 sessionId 时，如果 active session 已过期但 id 匹配，
 * 仍然返回该 session（支持新 bootstrap 创建后旧 session 的 dimension_complete 继续工作）。
 */
export function getActiveSession(container: ServiceContainer, sessionId?: string) {
  const mgr = getSessionManager(container);
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
