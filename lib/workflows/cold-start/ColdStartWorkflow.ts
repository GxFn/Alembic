/**
 * ColdStartWorkflow — Alembic API AI 冷启动知识库初始化
 *
 * 由 Alembic AgentRuntime 自动完成知识提取。需要配置 AI Provider (API Key)。
 *
 * 调用方:
 *   - CLI: `alembic bootstrap --knowledge`
 *   - MCP: `alembic_bootstrap` (带 knowledge 参数)
 *   - Dashboard HTTP: POST /api/bootstrap/knowledge
 *
 * Codex 宿主 Agent 路径由 AlembicPlugin 维护。
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

import {
  buildColdStartWorkflowPlan,
  type InternalColdStartArgs as ColdStartArgs,
  createInternalColdStartIntent as createColdStartIntent,
  runFullResetPolicy,
} from '@alembic/core/host-agent-workflows';
import type { PlanSelectionProjection } from '@alembic/core/plans';
import { applyTestDimensionFilter } from '@alembic/core/shared';
import type { DimensionDef, WorkflowDatabaseLike, WorkflowSkillHooks } from '@alembic/core/types';
import { CleanupService } from '#service/cleanup/CleanupService.js';
import {
  attachProjectScopeSourceIdentitiesToView,
  buildProjectScopeAnalysisLogMeta,
  collectProjectScopeSourceIdentities,
  resolveProjectScopeAnalysisContext,
} from '../../project-scope/ProjectScopeAnalysis.js';
import {
  dispatchAiDimensionRuns,
  startAiDimensionSession,
} from '../ai-execution/AiDimensionDispatcher.js';
import {
  presentProjectContextColdStartEmptyProject,
  presentProjectContextColdStartResponse,
} from '../project-context/ProjectContextPresenters.js';
import {
  buildProjectContextFillView,
  buildProjectContextMissionArtifacts,
  buildProjectContextWorkflowFacts,
  createProjectContextWorkflowSession,
  type ProjectContextWorkflowFacts,
  registerProjectContextWorkflowSessionReleaseOnBootstrapCompletion,
  selectProjectContextWorkflowDimensions,
} from '../project-context/ProjectContextWorkflowFacts.js';
import {
  type ProjectIndexMcpContext,
  registerProjectIndexWorkflowImplementation,
  runProjectIndexWorkflow,
} from '../project-index/ProjectIndexWorkflow.js';

type BootstrapMcpContext = ProjectIndexMcpContext;
type ColdStartDimensionSelectionSource = 'base' | 'explicit' | 'plan';
type AlembicMainColdStartArgs = ColdStartArgs & {
  planSelectionProjection?: PlanSelectionProjection;
  projectContextFacts?: ProjectContextWorkflowFacts;
};

/**
 * bootstrapKnowledge — 一键初始化知识库 (Skill-aware)
 *
 * 覆盖 7 大知识维度: 项目规范、使用习惯、架构模式、代码模式、最佳实践、项目库特征、Agent开发注意事项
 * （注意：反模式/代码问题由 Guard 独立处理，不在 Bootstrap 覆盖范围）
 * 为每个维度自动创建 Candidate（PENDING），由内置 Analyst/Producer pipeline 分析代码。
 *
 * ⚠️ 本函数是 Alembic API AI 工作流路径。Codex 宿主 Agent 流程由 AlembicPlugin 维护。
 *
 * @param ctx { container, logger }
 * @param [args.maxFiles=500] 最大扫描文件数
 * @param [args.skipGuard=false] 是否跳过 Guard 审计
 * @param [args.contentMaxLines=120] 每文件读取最大行数
 * @param [args.incremental] 冷启动忽略文件快照增量；需要历史复用时应走 knowledge-rescan
 */
export async function runColdStartWorkflow(
  ctx: BootstrapMcpContext,
  args: AlembicMainColdStartArgs
) {
  return runProjectIndexWorkflow(ctx, args, { mode: 'full' });
}

async function runColdStartProjectIndexWorkflow(
  ctx: BootstrapMcpContext,
  args: AlembicMainColdStartArgs
) {
  const t0 = Date.now();
  const analysisScope = resolveProjectScopeAnalysisContext(ctx.container);
  const { dataRoot, projectRoot } = analysisScope;
  const intent = createColdStartIntent(args);
  const plan = buildColdStartWorkflowPlan({ intent, projectRoot, dataRoot });
  ctx.logger.info(
    '[ColdStartWorkflow] ProjectScope analysis context resolved',
    buildProjectScopeAnalysisLogMeta(analysisScope)
  );
  if (intent.ignoredFileDiffIncremental) {
    ctx.logger.warn(
      '[ColdStartWorkflow] Ignoring file-diff incremental=true for cold-start; full-reset workflows always run full project analysis'
    );
  }

  // ═══════════════════════════════════════════════════════════
  // Step 0: 全量清理
  // 冷启动需要干净的初始状态：清除 DB + 文件系统缓存
  // ═══════════════════════════════════════════════════════════
  const db = ctx.container.get('database');
  const cleanupResult = await runFullResetPolicy({
    projectRoot: plan.cleanup.projectRoot,
    dataRoot: plan.cleanup.dataRoot,
    db,
    logger: ctx.logger,
    createCleanupService: (cleanupCtx) =>
      new CleanupService({
        projectRoot: cleanupCtx.projectRoot,
        dataRoot: cleanupCtx.dataRoot,
        db: cleanupCtx.db,
        logger: cleanupCtx.logger,
      }),
  });

  ctx.logger.info('[ColdStartWorkflow] fullReset complete', {
    tables: cleanupResult.clearedTables.length,
    files: cleanupResult.deletedFiles,
    errors: cleanupResult.errors.length,
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 1-4: 共享管线（文件收集→AST→依赖→Guard→维度解析）
  // ═══════════════════════════════════════════════════════════
  const projectContextFacts =
    args.projectContextFacts ??
    (await buildProjectContextWorkflowFacts({
      analysisScope,
      projectRoot: plan.projectAnalysis.projectRoot,
      contentMaxLines: intent.projectAnalysis.contentMaxLines,
      ctx,
      maxFiles: intent.projectAnalysis.maxFiles,
      source: 'alembic-main-bootstrap',
    }));
  const sourceIdentities = collectProjectScopeSourceIdentities(projectContextFacts);

  if (projectContextFacts.isEmpty) {
    return presentProjectContextColdStartEmptyProject({
      facts: projectContextFacts,
      responseTimeMs: Date.now() - t0,
    });
  }

  // ProjectContext 仍保留全量 baseDimensions 供 plan 决策；coldStart 执行维度在这里按
  // 显式输入或 plan projection 裁剪，禁止 plan 失败时静默扩大回全量。
  const { dimensions, selectionSummary } = resolveColdStartWorkflowDimensionSelection({
    intentDimensionIds: intent.dimensionIds,
    planSelectionProjection: args.planSelectionProjection,
    projectContextDimensions: projectContextFacts.dimensions,
  });
  projectContextFacts.report.dimensionSelection = selectionSummary;
  if (args.planSelectionProjection) {
    projectContextFacts.report.planSelectionProjection = {
      budget: args.planSelectionProjection.budget,
      executionDimensions: args.planSelectionProjection.executionDimensions,
      moduleScope: args.planSelectionProjection.moduleScope,
      unknownDimensionIds: args.planSelectionProjection.unknownDimensionIds ?? [],
    };
  }
  projectContextFacts.report.projectScopeSourceIdentities = {
    projectScopeId: analysisScope.projectScopeId,
    sourceCount: sourceIdentities.length,
  };
  ctx.logger.info('[ColdStartWorkflow] ProjectScope source identities prepared', {
    projectScopeId: analysisScope.projectScopeId,
    sourceIdentities: sourceIdentities.length,
  });

  // 如果调用方指定了维度子集，只保留匹配的维度；否则按 plan projection 执行。
  if (selectionSummary.source !== 'base') {
    ctx.logger.info(
      `[Bootstrap] Dimension filter (${selectionSummary.source}): selected=${dimensions.map((d) => d.id).join(', ') || 'none'}, ` +
        `unknown=${selectionSummary.unknownRequestedDimensionIds.join(', ') || 'none'}, ` +
        `duplicateCollapsed=${selectionSummary.duplicateCollapsedCount}`
    );
  }

  // ═══════════════════════════════════════════════════════════
  // Phase 4.6: BootstrapSessionManager — 缓存 Phase 结果供 wiki_plan 复用
  // （与本地初始化保持一致）
  // ═══════════════════════════════════════════════════════════
  const workflowSession = createProjectContextWorkflowSession({
    container: ctx.container,
    dimensions,
    facts: projectContextFacts,
    projectRoot,
    replaceExisting: true,
  });
  ctx.logger.info('[ColdStartWorkflow] ProjectContext workflow session opened after fullReset', {
    projectRoot,
    replaceExistingLease: true,
    workflowSessionId: workflowSession.id,
  });
  const cachedSessionId = workflowSession.id;
  const projectContextArtifacts = buildProjectContextMissionArtifacts({
    dimensions,
    facts: projectContextFacts,
    profile: 'cold-start',
    session: workflowSession,
  });
  projectContextFacts.report.projectContextMissionBriefing = {
    briefingMeta: projectContextArtifacts.briefing.meta,
    ideAgentProfile: projectContextArtifacts.ideAgentPacket.profile,
  };

  // ═══════════════════════════════════════════════════════════
  // Phase 5: 创建异步任务 — 骨架先返回，内容后填充
  //
  // 策略变更（v5）：
  //   旧：同步遍历所有维度 → 提取 + 创建 Candidate → 一次性返回
  //   新：快速创建任务清单 → 立即返回骨架 → 异步逐维度填充内容
  //       前端通过 Socket.io 接收进度更新，卡片 loading → 完成
  // ═══════════════════════════════════════════════════════════

  // 构建任务定义列表
  const { taskDefs, bootstrapSession } = startAiDimensionSession({
    container: ctx.container,
    dimensions,
    logger: ctx.logger,
    logPrefix: 'Bootstrap',
  });
  if (!intent.internalExecution?.skipAsyncFill) {
    registerProjectContextWorkflowSessionReleaseOnBootstrapCompletion({
      bootstrapSessionId: bootstrapSession?.id,
      container: ctx.container,
      logger: ctx.logger,
      projectRoot,
      workflow: 'cold-start',
      workflowSessionId: cachedSessionId,
    });
  }

  // ── 异步后台填充（fire-and-forget）──
  // skipAsyncFill: CLI 非 --wait 模式跳过异步填充，避免进程退出后 DB 断连
  if (!intent.internalExecution?.skipAsyncFill) {
    dispatchAiDimensionRuns({
      view: attachProjectScopeSourceIdentitiesToView(
        {
          ...buildProjectContextFillView({
            bootstrapSession,
            ctx: ctx as Record<string, unknown>,
            facts: projectContextFacts,
            mode: 'bootstrap',
            projectRoot,
            skipTargetDelivery: intent.internalExecution?.skipTargetDelivery === true,
          }),
          ctx: ctx as BootstrapMcpContext,
        },
        sourceIdentities
      ),
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
          filesScanned: projectContextFacts.fileCount,
          targetsFound: projectContextFacts.targetCount,
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

  return presentProjectContextColdStartResponse({
    cleanupResult,
    dimensions,
    facts: projectContextFacts,
    cachedSessionId,
    selectionSummary,
    taskCount: taskDefs.length,
    bootstrapSession,
    responseTimeMs: Date.now() - t0,
  });
}

registerProjectIndexWorkflowImplementation('full', runColdStartProjectIndexWorkflow);

// bootstrapRefine → 已迁至 service/bootstrap/BootstrapRefine.js (RIC-3)

function buildProjectContextDimensionSelectionSummary(input: {
  requestedDimensionIds?: readonly string[];
  selectedDimensions: readonly DimensionDef[];
  sourceDimensions: readonly DimensionDef[];
  source: ColdStartDimensionSelectionSource;
}) {
  const known = new Set(input.sourceDimensions.map((dimension) => dimension.id));
  return {
    duplicateCollapsedCount: 0,
    selectedDimensionIds: input.selectedDimensions.map((dimension) => dimension.id),
    source: input.source,
    unknownRequestedDimensionIds: (input.requestedDimensionIds ?? []).filter(
      (id) => !known.has(id)
    ),
  };
}

export function resolveColdStartWorkflowDimensionSelection(input: {
  intentDimensionIds?: readonly string[];
  planSelectionProjection?: PlanSelectionProjection;
  projectContextDimensions: readonly DimensionDef[];
}): {
  dimensions: DimensionDef[];
  selectionSummary: ReturnType<typeof buildProjectContextDimensionSelectionSummary>;
} {
  const explicitDimensionIds = normalizeDimensionIds(input.intentDimensionIds);
  const planDimensionIds = normalizeDimensionIds(
    input.planSelectionProjection?.executionDimensions
  );
  const source: ColdStartDimensionSelectionSource =
    explicitDimensionIds.length > 0 ? 'explicit' : input.planSelectionProjection ? 'plan' : 'base';
  const requestedDimensionIds =
    source === 'explicit' ? explicitDimensionIds : source === 'plan' ? planDimensionIds : undefined;

  if (source === 'plan' && planDimensionIds.length === 0) {
    throw new Error('Plan gate selected no executable dimensions for coldStart.');
  }

  const dimensions = applyTestDimensionFilter(
    selectProjectContextWorkflowDimensions(
      input.projectContextDimensions,
      requestedDimensionIds
    ) as unknown as Parameters<typeof applyTestDimensionFilter>[0],
    'bootstrap'
  ) as DimensionDef[];

  if (source === 'plan' && dimensions.length === 0) {
    throw new Error('Plan gate selected no known ProjectContext dimensions for coldStart.');
  }

  return {
    dimensions,
    selectionSummary: buildProjectContextDimensionSelectionSummary({
      requestedDimensionIds,
      selectedDimensions: dimensions,
      source,
      sourceDimensions: input.projectContextDimensions,
    }),
  };
}

function normalizeDimensionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0)
    ),
  ];
}
