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

import type { ServiceContainer } from '#inject/ServiceContainer.js';
import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import type { ProjectSnapshot } from '#types/project-snapshot.js';
import { buildProjectSnapshot } from '#types/project-snapshot-builder.js';
import { createExternalColdStartIntent } from '#workflows/cold-start/ColdStartIntent.js';
import { buildColdStartWorkflowPlan } from '#workflows/cold-start/ColdStartPlan.js';
import {
  presentExternalColdStartEmptyProject,
  presentExternalColdStartResponse,
} from '#workflows/cold-start/ColdStartPresenters.js';
import {
  buildExternalMissionBriefing,
  createExternalWorkflowSession,
  getActiveExternalWorkflowSession,
} from '#workflows/common-capabilities/agent-execution/ExternalMissionWorkflow.js';
import { runFullResetPolicy } from '#workflows/common-capabilities/cleanup/CleanupPolicies.js';
import { ProjectAnalysisCapability } from '#workflows/common-capabilities/project-analysis/ProjectAnalysisWorkflow.js';

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
export async function runExternalColdStartWorkflow(ctx: McpContext) {
  const t0 = Date.now();
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveDataRoot(ctx.container);
  const intent = createExternalColdStartIntent();
  const plan = buildColdStartWorkflowPlan({ intent, projectRoot, dataRoot });

  // ═══════════════════════════════════════════════════════════
  // Step 1: 全量清理 (CleanupService.fullReset)
  // ═══════════════════════════════════════════════════════════

  const db = ctx.container.get('database');
  const cleanupResult = await runFullResetPolicy({
    projectRoot: plan.cleanup.projectRoot,
    db,
    logger: ctx.logger,
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 1-4: 共享数据收集管线（永远全量，无增量检测）
  // ═══════════════════════════════════════════════════════════

  const phaseResults = await ProjectAnalysisCapability.run({
    projectRoot: plan.projectAnalysis.projectRoot,
    ctx,
    prepare: plan.projectAnalysis.prepare,
    scan: plan.projectAnalysis.scan,
    materialize: plan.projectAnalysis.materialize,
  });

  // 空项目 fast-path
  if (phaseResults.isEmpty) {
    return presentExternalColdStartEmptyProject({ responseTimeMs: Date.now() - t0 });
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

  // ── Build immutable ProjectSnapshot ──
  const snapshot: ProjectSnapshot = buildProjectSnapshot({
    projectRoot,
    sourceTag: 'bootstrap-external',
    ...phaseResults,
    report: phaseResults.report,
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 4: 构建 Mission Briefing
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
    profile: 'cold-start-external',
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

  ctx.logger.info(
    `[BootstrapExternal] Mission Briefing ready: ${allFiles.length} files, ${dimensions.length} dims, ` +
      `${briefing.meta?.responseSizeKB || '?'}KB — session ${session.id}`
  );

  return presentExternalColdStartResponse({
    cleanupResult,
    briefing,
    dimensionCount: dimensions.length,
    responseTimeMs: Date.now() - t0,
  });
}

/**
 * 获取当前 active session（供其他 handler 使用）
 *
 * 当指定了 sessionId 时，如果 active session 已过期但 id 匹配，
 * 仍然返回该 session（支持新 bootstrap 创建后旧 session 的 dimension_complete 继续工作）。
 */
export { getActiveExternalWorkflowSession as getActiveSession };
