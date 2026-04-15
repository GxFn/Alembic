/**
 * MCP 整合 Handler — 参数路由层
 *
 * 将整合后的工具（asd_search / knowledge / structure / graph / guard / skill）
 * 按 operation / mode 参数路由到已有 handler 实现。
 *
 * 不包含业务逻辑，仅做参数解构 → 路由 → 转发。
 *
 * asd_bootstrap 已迁移到 bootstrap-external.js（外部 Agent 路径）。
 */

import { getRequiredFieldsDescription } from '#domain/knowledge/FieldSpec.js';
import { getDeveloperIdentity } from '#shared/developer-identity.js';
import { envelope } from '../envelope.js';
import * as browseHandlers from './browse.js';
import * as guardHandlers from './guard.js';
import * as searchHandlers from './search.js';
import * as skillHandlers from './skill.js';
import * as structureHandlers from './structure.js';
import type {
  ConsolidatedGraphArgs,
  ConsolidatedGuardArgs,
  ConsolidatedKnowledgeArgs,
  ConsolidatedSearchArgs,
  ConsolidatedSkillArgs,
  ConsolidatedStructureArgs,
  McpContext,
} from './types.js';

// ─── asd_search (整合 4 → 1) ────────────────────────

/**
 * 统合搜索：根据 mode 参数路由到对应搜索 handler
 *   auto (默认) → search()
 *   keyword     → keywordSearch()
 *   semantic    → semanticSearch()
 *   context     → contextSearch()
 */
export async function consolidatedSearch(ctx: McpContext, args: ConsolidatedSearchArgs) {
  const mode = args.mode || 'auto';
  switch (mode) {
    case 'keyword':
      return searchHandlers.keywordSearch(ctx, args);
    case 'semantic':
      return searchHandlers.semanticSearch(ctx, args);
    case 'context':
      return searchHandlers.contextSearch(ctx, args);
    default:
      return searchHandlers.search(ctx, { ...args, mode });
  }
}

// ─── asd_knowledge (整合 7 → 1) ─────────────────────

/**
 * 知识浏览：根据 operation 参数路由
 *   list (默认) → listByKind() 或 listRecipes()
 *   get          → getRecipe()
 *   insights     → recipeInsights()
 *   confirm_usage → confirmUsage()
 */
export async function consolidatedKnowledge(ctx: McpContext, args: ConsolidatedKnowledgeArgs) {
  const op = args.operation || 'list';
  switch (op) {
    case 'list': {
      const kind = args.kind;
      if (kind && kind !== 'all') {
        return browseHandlers.listByKind(ctx, kind, args);
      }
      return browseHandlers.listRecipes(ctx, args);
    }
    case 'get':
      return browseHandlers.getRecipe(ctx, args);
    case 'insights':
      return browseHandlers.recipeInsights(ctx, args);
    case 'confirm_usage':
      // confirmUsage expects { recipeId, usageType, feedback }
      // 适配：如果传了 id 但没传 recipeId，自动映射
      if (args.id && !args.recipeId) {
        args.recipeId = args.id;
      }
      return browseHandlers.confirmUsage(ctx, args);
    default:
      throw new Error(
        `Unknown knowledge operation: ${op}. Expected: list, get, insights, confirm_usage`
      );
  }
}

// ─── asd_structure (整合 3 → 1) ─────────────────────

/**
 * 项目结构：根据 operation 参数路由
 *   targets (默认) → getTargets()
 *   files          → getTargetFiles()
 *   metadata       → getTargetMetadata()
 */
export async function consolidatedStructure(ctx: McpContext, args: ConsolidatedStructureArgs) {
  const op = args.operation || 'targets';
  switch (op) {
    case 'targets':
      return structureHandlers.getTargets(ctx, args);
    case 'files':
      return structureHandlers.getTargetFiles(ctx, args);
    case 'metadata':
      return structureHandlers.getTargetMetadata(ctx, args);
    default:
      throw new Error(`Unknown structure operation: ${op}. Expected: targets, files, metadata`);
  }
}

// ─── asd_call_context (Phase 5) ─────────────────────

/** 调用链上下文查询：直接转发到 structure.callContext */
export async function consolidatedCallContext(ctx: McpContext, args: ConsolidatedStructureArgs) {
  return structureHandlers.callContext(ctx, args);
}

// ─── asd_graph (整合 4 → 1) ─────────────────────────

/**
 * 知识图谱：根据 operation 参数路由
 *   query   → graphQuery()
 *   impact  → graphImpact()
 *   path    → graphPath()
 *   stats   → graphStats()
 */
export async function consolidatedGraph(ctx: McpContext, args: ConsolidatedGraphArgs) {
  const op = args.operation;
  if (!op) {
    throw new Error('Missing required parameter: operation. Expected: query, impact, path, stats');
  }
  switch (op) {
    case 'query':
      return structureHandlers.graphQuery(ctx, args);
    case 'impact':
      return structureHandlers.graphImpact(ctx, args);
    case 'path':
      return structureHandlers.graphPath(ctx, args);
    case 'stats':
      return structureHandlers.graphStats(ctx);
    default:
      throw new Error(`Unknown graph operation: ${op}. Expected: query, impact, path, stats`);
  }
}

// ─── asd_guard (整合 3 → 1) ─────────────────────────

/**
 * Guard 检查：按参数自动路由
 *   operation: 'reverse_audit'      → guardReverseAudit()     (Recipe→Code 反向验证)
 *   operation: 'coverage_matrix'    → guardCoverageMatrix()    (模块覆盖率矩阵)
 *   operation: 'compliance_report'  → guardComplianceReport()  (3D 合规报告)
 *   无参数       → guardReview()    (自动 git diff 检测 + inline recipe)
 *   有 files     → guardReview()    (指定文件 + inline recipe) — files 为 string[] 或 {path}[]
 *   有 code      → guardCheck()     (单文件内联检查)
 */
export async function consolidatedGuard(ctx: McpContext, args: ConsolidatedGuardArgs) {
  // operation 显式路由
  if (args.operation === 'reverse_audit') {
    return guardHandlers.guardReverseAudit(ctx, args);
  }
  if (args.operation === 'coverage_matrix') {
    return guardHandlers.guardCoverageMatrix(ctx, args);
  }
  if (args.operation === 'compliance_report') {
    return guardHandlers.guardComplianceReport(ctx, args);
  }
  // 有 code → 单文件检查（旧模式）
  if (args.code) {
    return guardHandlers.guardCheck(ctx, args);
  }
  // 有 files（string[] 或 {path}[]）或无参数 → review 模式
  // review 模式内部处理 files 参数和自动检测
  return guardHandlers.guardReview(ctx, args);
}

// ─── asd_skill (整合 6 → 1) ─────────────────────────

/**
 * Skill 管理：根据 operation 参数路由
 *   list    → listSkills()
 *   load    → loadSkill()
 *   create  → createSkill()
 *   update  → updateSkill()
 *   delete  → deleteSkill()
 *   suggest → suggestSkills()
 */
export async function consolidatedSkill(ctx: McpContext, args: ConsolidatedSkillArgs) {
  const op = args.operation;
  if (!op) {
    throw new Error(
      'Missing required parameter: operation. Expected: list, load, create, update, delete, suggest, feedback'
    );
  }

  // loadSkill expects { skillName }, map from { name }
  if (args.name && !args.skillName) {
    args.skillName = args.name;
  }

  switch (op) {
    case 'list':
      return skillHandlers.listSkills(ctx);
    case 'load':
      return skillHandlers.loadSkill(ctx, args);
    case 'create':
      return skillHandlers.createSkill(ctx, args);
    case 'update':
      return skillHandlers.updateSkill(ctx, args);
    case 'delete':
      return skillHandlers.deleteSkill(ctx, args);
    case 'suggest':
      return skillHandlers.suggestSkills(ctx);
    case 'feedback':
      return skillHandlers.recordFeedback(ctx, args as Record<string, unknown>);
    default:
      throw new Error(
        `Unknown skill operation: ${op}. Expected: list, load, create, update, delete, suggest, feedback`
      );
  }
}

// ─── asd_submit_knowledge (unified pipeline) ──────────────────────

/**
 * 统一提交管线：单条与批量走同一代码路径。
 *
 * 流程:
 *   1. 限流
 *   2. V3 字段增强（MCP 特有预处理）
 *   3. RecipeProductionGateway.create() — 统一管道
 *   4. Bootstrap session 追踪
 *   5. 返回统一结果
 *
 * 设计原则：
 *   - 不降级：缺字段不自动补全，要求 Agent 一次性生成完整数据
 *   - 不碎片化：优先增强已有 Recipe，而非总新建
 *   - 不重复提交：拒绝时不创建任何记录
 *   - 单条/批量完全一致的校验与融合逻辑
 */
export async function enhancedSubmitKnowledge(ctx: McpContext, args: Record<string, unknown>) {
  const { RecipeProductionGateway } = await import('#service/knowledge/RecipeProductionGateway.js');

  const items = args.items as Record<string, unknown>[] | undefined;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return envelope({
      success: false,
      errorCode: 'INVALID_INPUT',
      message: 'items 数组是必需的且不能为空。请传入 items: [{ title, language, ... }]',
      meta: { tool: 'asd_submit_knowledge' },
    });
  }

  const skipConsolidation = (args.skipConsolidation as boolean) === true;
  const source = (args.source as string) || 'mcp';
  const dimensionId = args.dimensionId as string | undefined;
  const clientId = args.client_id as string | undefined;
  const supersedes = args.supersedes as string | undefined;

  // ── Step 1: 限流 ──
  const { checkRecipeSave } = await import('#http/middleware/RateLimiter.js');
  const { resolveProjectRoot } = await import('#shared/resolveProjectRoot.js');
  const projectRoot = resolveProjectRoot(ctx.container);
  const limitCheck = checkRecipeSave(projectRoot, clientId || process.env.USER || 'mcp-client');
  if (!limitCheck.allowed) {
    return envelope({
      success: false,
      message: `提交过于频繁，请 ${limitCheck.retryAfter}s 后再试。`,
      errorCode: 'RATE_LIMIT',
      meta: { tool: 'asd_submit_knowledge' },
    });
  }

  // ── Step 2: MCP 特有预处理 ──
  // 注入批次级选项到各条目
  for (const item of items) {
    if (!item.source) {
      item.source = source;
    }
    if (dimensionId && !item.dimensionId) {
      item.dimensionId = dimensionId;
    }
  }

  // 获取 bootstrapSession 已提交标题用于跨维度去重
  let existingTitles: Set<string> | undefined;
  try {
    const sessionManager = ctx.container.get('bootstrapSessionManager');
    const bsSession = sessionManager?.getSession?.();
    if (bsSession?.submissionTracker?.getAllSubmittedTitles) {
      existingTitles = bsSession.submissionTracker.getAllSubmittedTitles();
    }
  } catch {
    /* best effort */
  }

  // ── Step 3: 委托 RecipeProductionGateway 统一管道 ──
  const knowledgeService = ctx.container.get('knowledgeService');
  let consolidationAdvisor = null;
  try {
    consolidationAdvisor = ctx.container.get('consolidationAdvisor');
  } catch {
    /* not registered */
  }
  let proposalRepository = null;
  try {
    proposalRepository = ctx.container.get('proposalRepository');
  } catch {
    /* not registered */
  }

  const gateway = new RecipeProductionGateway({
    knowledgeService,
    projectRoot,
    consolidationAdvisor: consolidationAdvisor ?? null,
    proposalRepository: proposalRepository ?? null,
  });

  const gatewayResult = await gateway.create({
    source: 'mcp-external',
    items: items as import('#service/knowledge/RecipeProductionGateway.js').CreateRecipeItem[],
    options: {
      skipSimilarityCheck: true,
      skipConsolidation,
      supersedes,
      existingTitles,
      userId: getDeveloperIdentity(),
    },
  });

  // ── Step 4: Bootstrap session 追踪 ──
  for (const created of gatewayResult.created) {
    _trackSubmission(
      ctx,
      items.find((it) => it.title === created.title) || {},
      dimensionId,
      created.id
    );
  }
  for (const rej of gatewayResult.rejected) {
    const item = items[rej.index] || {};
    _trackRejection(ctx, item, dimensionId);
  }

  // ── Step 5: 构建统一响应 ──
  const successCount = gatewayResult.created.length;
  const data: Record<string, unknown> = {
    count: successCount,
    total: items.length,
  };

  if (gatewayResult.created.length > 0) {
    data.ids = gatewayResult.created.map((c) => c.id);
  }

  if (gatewayResult.rejected.length > 0) {
    const rejectedItems = gatewayResult.rejected.map((r) => ({
      index: r.index,
      title: r.title,
      errors: r.errors,
      warnings: r.warnings,
    }));
    const allMissing = [...new Set(rejectedItems.flatMap((it) => it.errors))];
    data.rejectedItems = rejectedItems;
    data.rejectedSummary = {
      rejectedCount: rejectedItems.length,
      commonErrors: allMissing,
      message: `${rejectedItems.length}/${items.length} 条知识条目因校验未通过被拒绝。`,
    };
  }

  if (gatewayResult.blocked.length > 0) {
    data.blockedItems = gatewayResult.blocked;
    data.blockedSummary = {
      blockedCount: gatewayResult.blocked.length,
      message: `${gatewayResult.blocked.length} 条因融合分析被阻塞（与已有 Recipe 重叠或实质性不足）。设 skipConsolidation: true 可跳过。`,
    };
  }

  const createdProposals: unknown[] = [];
  for (const m of gatewayResult.merged) {
    createdProposals.push({
      proposalId: m.proposalId,
      type: m.type,
      targetRecipe: { id: m.targetRecipeId, title: m.targetTitle },
      status: m.status,
      expiresAt: m.expiresAt,
      message: m.message,
    });
  }

  if (gatewayResult.supersedeProposal) {
    createdProposals.push({
      proposalId: gatewayResult.supersedeProposal.proposalId,
      type: 'supersede',
      targetRecipe: { id: supersedes, title: supersedes },
      status: 'observing',
      expiresAt: 0,
      message: `已创建替代提案。`,
    });
  }

  if (createdProposals.length > 0) {
    data.proposals = createdProposals;
    data.proposalSummary = {
      proposalCount: createdProposals.length,
      message: `${createdProposals.length} 条已创建进化提案，系统将在观察窗口到期后自动执行。无需额外操作。`,
    };
  }

  // 全部拒绝 → 特殊错误响应
  if (successCount === 0 && gatewayResult.rejected.length === items.length) {
    const allMissing = [...new Set(gatewayResult.rejected.flatMap((it) => it.errors))];
    return envelope({
      success: false,
      errorCode: 'INCOMPLETE_SUBMISSION',
      message: `全部 ${items.length} 条知识条目被拒绝。请在单次调用中补齐所有字段后重新提交。`,
      data: {
        rejectedItems: data.rejectedItems,
        requiredFields: getRequiredFieldsDescription(),
        commonErrors: allMissing,
      },
      meta: { tool: 'asd_submit_knowledge' },
    });
  }

  const allOk = successCount === items.length;
  return envelope({
    success: successCount > 0,
    data,
    message: allOk
      ? `已提交 ${successCount} 条知识条目。`
      : `已提交 ${successCount}/${items.length} 条知识条目。`,
    meta: { tool: 'asd_submit_knowledge' },
  });
}

// ── BootstrapSession 提交追踪辅助函数 ───────────────────────

interface SessionTrackerLike {
  submissionTracker?: {
    recordRejection(dimId: string, title: string, reason: string): void;
    recordSubmission(dimId: string, item: unknown, recipeId: string): void;
  };
  getProgress(): { remainingDimIds: string[] };
}

function _getSession(ctx: McpContext): { session: SessionTrackerLike; dimId: string } | null {
  try {
    const sessionManager = ctx.container.get('bootstrapSessionManager');
    const session: SessionTrackerLike | null = sessionManager?.getSession?.();
    if (!session?.submissionTracker) {
      return null;
    }
    const progress = session.getProgress();
    return { session, dimId: progress.remainingDimIds[0] || 'unknown' };
  } catch {
    return null;
  }
}

function _trackSubmission(
  ctx: McpContext,
  item: Record<string, unknown>,
  dimensionId: string | undefined,
  recipeId: string
) {
  const s = _getSession(ctx);
  if (!s) {
    return;
  }
  try {
    const dimId = dimensionId || (item.dimensionId as string) || s.dimId;
    s.session.submissionTracker?.recordSubmission(dimId, item, recipeId);
  } catch {
    /* best effort */
  }
}

function _trackRejection(
  ctx: McpContext,
  item: Record<string, unknown>,
  dimensionId: string | undefined
) {
  const s = _getSession(ctx);
  if (!s) {
    return;
  }
  try {
    const dimId = dimensionId || (item.dimensionId as string) || s.dimId;
    s.session.submissionTracker?.recordRejection(
      dimId,
      (item.title as string) || '(untitled)',
      'validation failed'
    );
  } catch {
    /* best effort */
  }
}
