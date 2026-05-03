/**
 * InternalColdStartWorkflow — 内部 Agent 冷启动知识库初始化
 *
 * 由 Alembic AgentRuntime 自动完成知识提取。需要配置 AI Provider (API Key)。
 *
 * 调用方:
 *   - CLI: `alembic bootstrap --knowledge`
 *   - MCP: `alembic_bootstrap` (带 knowledge 参数)
 *   - Dashboard HTTP: POST /api/bootstrap/knowledge
 *
 * 外部 Agent 路径请参见 ExternalColdStartWorkflow。
 *
 * 流程 (Async Fill):
 *
 * 同步阶段（快速返回，~1-3s）:
 *   Phase 1   → 文件收集
 *   Phase 1.5 → AST 代码结构分析（Tree-sitter）
 *   Phase 2   → SPM 依赖关系 → knowledge_edges（模块级图谱）
 *   Phase 3   → Guard 规则审计
 *   Phase 4   → 构建响应骨架（filesByTarget + analysisFramework + 任务清单）
 *
 * 异步阶段（后台逐一填充，通过 Socket.io 推送进度）:
 *   Phase 5   → 微观维度 × 子主题提取代码特征 → 创建 N 条 Candidate（PENDING 状态）
 *              skillWorthy 维度仅提取内容，不创建 Candidate（避免与 Skill 重复）
 *              anti-pattern 已移除 — 代码问题由 Guard 独立处理
 *   Phase 5.5 → 宏观维度（architecture/code-standard/project-profile/agent-guidelines）
 *              自动聚合为 Project Skill → 写入 Alembic/skills/（不产生 Candidate）
 *
 * 进度推送事件（Socket.io + EventBus）:
 *   bootstrap:started        — 骨架创建完成，携带任务清单
 *   bootstrap:task-started   — 单个维度开始填充
 *   bootstrap:task-completed — 单个维度填充完成
 *   bootstrap:task-failed    — 单个维度失败
 *   bootstrap:all-completed  — 全部维度完成（前端弹出通知）
 *
 */

import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { applyTestDimensionFilter } from '#shared/test-mode.js';
import type { DimensionDef, ProjectSnapshot } from '#types/project-snapshot.js';
import { buildProjectSnapshot } from '#types/project-snapshot-builder.js';
import type { McpContext, WorkflowDatabaseLike, WorkflowSkillHooks } from '#types/workflows.js';
import { cacheProjectAnalysisSession } from '#workflows/capabilities/execution/external/SessionSupport.js';
import {
  dispatchInternalDimensionExecution,
  startInternalDimensionExecutionSession,
} from '#workflows/capabilities/execution/internal-agent/InternalDimensionExecutionWorkflow.js';
import { ProjectIntelligenceCapability } from '#workflows/capabilities/project-intelligence/ProjectIntelligenceCapability.js';
import { runFullResetPolicy } from '#workflows/capabilities/WorkflowCleanupPolicies.js';
import {
  createInternalColdStartIntent,
  type InternalColdStartArgs,
} from '#workflows/cold-start/ColdStartIntent.js';
import {
  buildColdStartWorkflowPlan,
  selectColdStartDimensions,
} from '#workflows/cold-start/ColdStartPlan.js';
import {
  buildInternalColdStartReport,
  buildInternalColdStartTargetFileMap,
  presentInternalColdStartEmptyProject,
  presentInternalColdStartResponse,
} from '#workflows/cold-start/ColdStartPresenters.js';

import type { WorkflowMcpContext } from '#workflows/shared/WorkflowTypes.js';

type BootstrapMcpContext = WorkflowMcpContext & McpContext;

/**
 * bootstrapKnowledge — 一键初始化知识库 (Skill-aware)
 *
 * 覆盖 7 大知识维度: 项目规范、使用习惯、架构模式、代码模式、最佳实践、项目库特征、Agent开发注意事项
 * （注意：反模式/代码问题由 Guard 独立处理，不在 Bootstrap 覆盖范围）
 * 为每个维度自动创建 Candidate（PENDING），由内置 Analyst/Producer pipeline 分析代码。
 *
 * ⚠️ 本函数是内部 Agent 路径。外部 Agent 使用 bootstrap-external.js 的 Mission Briefing + dimension_complete 流程。
 *
 * @param ctx { container, logger }
 * @param [args.maxFiles=500] 最大扫描文件数
 * @param [args.skipGuard=false] 是否跳过 Guard 审计
 * @param [args.contentMaxLines=120] 每文件读取最大行数
 * @param [args.incremental] 冷启动忽略文件快照增量；需要历史复用时应走 knowledge-rescan
 */
export async function runInternalColdStartWorkflow(
  ctx: BootstrapMcpContext,
  args: InternalColdStartArgs
) {
  const t0 = Date.now();
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveDataRoot(ctx.container) || projectRoot;
  const intent = createInternalColdStartIntent(args);
  const plan = buildColdStartWorkflowPlan({ intent, projectRoot, dataRoot });
  if (intent.ignoredFileDiffIncremental) {
    ctx.logger.warn(
      '[Bootstrap-Internal] Ignoring file-diff incremental=true for cold-start; full-reset workflows always run full project analysis'
    );
  }

  // ═══════════════════════════════════════════════════════════
  // Step 0: 全量清理 (与 bootstrap-external 对齐)
  // 冷启动需要干净的初始状态：清除 DB + 文件系统缓存
  // ═══════════════════════════════════════════════════════════
  const db = ctx.container.get('database');
  const cleanupResult = await runFullResetPolicy({
    projectRoot: plan.cleanup.projectRoot,
    dataRoot: plan.cleanup.dataRoot,
    db,
    logger: ctx.logger,
  });

  ctx.logger.info('[Bootstrap-Internal] fullReset complete', {
    tables: cleanupResult.clearedTables.length,
    files: cleanupResult.deletedFiles,
    errors: cleanupResult.errors.length,
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 1-4: 共享管线（文件收集→AST→依赖→Guard→维度解析）
  // ═══════════════════════════════════════════════════════════
  const phaseResults = await ProjectIntelligenceCapability.run({
    projectRoot: plan.projectAnalysis.projectRoot,
    ctx,
    prepare: plan.projectAnalysis.prepare,
    scan: plan.projectAnalysis.scan,
    materialize: plan.projectAnalysis.materialize,
  });

  if (phaseResults.isEmpty) {
    return presentInternalColdStartEmptyProject({
      report: phaseResults.report,
      responseTimeMs: Date.now() - t0,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 构建 ProjectSnapshot — 统一数据来源
  // ═══════════════════════════════════════════════════════════
  const snapshot: ProjectSnapshot = buildProjectSnapshot({
    projectRoot,
    sourceTag: 'bootstrap',
    ...phaseResults,
    report: phaseResults.report,
  });

  const report = buildInternalColdStartReport({
    snapshot,
    maxFiles: intent.projectAnalysis.maxFiles,
    skipGuard: intent.projectAnalysis.skipGuard,
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 4.5: 构建响应 — filesByTarget + analysisFramework
  // ═══════════════════════════════════════════════════════════
  const targetFileMap = buildInternalColdStartTargetFileMap(
    snapshot,
    intent.projectAnalysis.contentMaxLines
  );

  const dimensions = applyTestDimensionFilter(
    selectColdStartDimensions(snapshot, intent) as DimensionDef[],
    'bootstrap'
  );

  // 如果调用方指定了维度子集，只保留匹配的维度
  if (intent.dimensionIds?.length) {
    ctx.logger.info(`[Bootstrap] Dimension filter: ${dimensions.map((d) => d.id).join(', ')}`);
  }

  // ═══════════════════════════════════════════════════════════
  // Phase 4.6: BootstrapSessionManager — 缓存 Phase 结果供 wiki_plan 复用
  // （与 bootstrap-external 对齐）
  // ═══════════════════════════════════════════════════════════
  const cachedSessionId = cacheProjectAnalysisSession({
    container: ctx.container,
    projectRoot,
    dimensions,
    snapshot,
    primaryLang: snapshot.language.primaryLang,
    fileCount: snapshot.allFiles.length,
    moduleCount: snapshot.dependencyGraph?.nodes?.length || 0,
    logger: ctx.logger,
    logPrefix: 'Bootstrap-Internal',
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 5: 创建异步任务 — 骨架先返回，内容后填充
  //
  // 策略变更（v5）：
  //   旧：同步遍历所有维度 → 提取 + 创建 Candidate → 一次性返回
  //   新：快速创建任务清单 → 立即返回骨架 → 异步逐维度填充内容
  //       前端通过 Socket.io 接收进度更新，卡片 loading → 完成
  // ═══════════════════════════════════════════════════════════

  // 构建任务定义列表
  const { taskDefs, bootstrapSession } = startInternalDimensionExecutionSession({
    container: ctx.container,
    dimensions,
    logger: ctx.logger,
    logPrefix: 'Bootstrap',
  });

  // ── 异步后台填充（fire-and-forget）──
  // skipAsyncFill: CLI 非 --wait 模式跳过异步填充，避免进程退出后 DB 断连
  if (!intent.internalExecution?.skipAsyncFill) {
    dispatchInternalDimensionExecution({
      view: {
        snapshot,
        ctx: ctx as BootstrapMcpContext,
        bootstrapSession,
        targetFileMap,
        projectRoot,
        mode: 'bootstrap',
      },
      dimensions,
      logPrefix: 'Bootstrap',
    });
  } else {
    ctx.logger.info(`[Bootstrap] Async fill skipped (skipAsyncFill=true)`);
  }

  // ── SkillHooks: onBootstrapStarted (fire-and-forget) ──
  try {
    const skillHooks = ctx.container.get('skillHooks') as WorkflowSkillHooks;
    const database = ctx.container.get('database') as WorkflowDatabaseLike | null | undefined;
    skillHooks
      .run(
        'onBootstrapComplete',
        {
          filesScanned: snapshot.allFiles.length,
          targetsFound: snapshot.allTargets.length,
          candidatesCreated: 0, // 异步填充中，初始为 0
          candidatesFailed: 0,
          autoSkillsCreated: 0,
          autoSkills: [],
        },
        { projectRoot: database?.filename || '' }
      )
      .catch(() => {}); // fire-and-forget
  } catch {
    /* skillHooks not available */
  }

  return presentInternalColdStartResponse({
    cleanupResult,
    snapshot,
    report,
    targetFileMap,
    dimensions,
    cachedSessionId,
    taskCount: taskDefs.length,
    bootstrapSession,
    responseTimeMs: Date.now() - t0,
  });
}

// bootstrapRefine → 已提取到 bootstrap/refine.js（通过顶部 re-export）
