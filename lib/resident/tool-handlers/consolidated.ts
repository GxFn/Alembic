/**
 * MCP 整合 Handler — 参数路由层
 *
 * 将整合后的工具（alembic_search / knowledge / structure / graph / guard / skill）
 * 按 operation / mode 参数路由到已有 handler 实现。
 *
 * 不包含业务逻辑，仅做参数解构 → 路由 → 转发。
 *
 * alembic_bootstrap 已迁移到 host-agent recoverable workflow 路径。
 */

import { dimensionTags } from '@alembic/core/dimensions';
import { getRequiredFieldsDescription } from '@alembic/core/knowledge';
import { getDeveloperIdentity } from '@alembic/core/shared';
import { envelope } from '../tool-schema/envelope.js';
import { buildToolUsageProblem } from '../tool-schema/problem.js';
import type {
  ConsolidatedGraphArgs,
  ConsolidatedGuardArgs,
  ConsolidatedKnowledgeArgs,
  ConsolidatedSearchArgs,
  ConsolidatedSkillArgs,
  ConsolidatedStructureArgs,
  McpContext,
} from '../tool-schema/types.js';
import * as browseHandlers from './browse.js';
import * as guardHandlers from './guard.js';
import * as searchHandlers from './search.js';
import * as skillHandlers from './skill.js';
import * as structureHandlers from './structure.js';

// ─── alembic_search (整合 4 → 1) ────────────────────────

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

// ─── alembic_knowledge (整合 7 → 1) ─────────────────────

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

// ─── alembic_structure (整合 3 → 1) ─────────────────────

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

// ─── alembic_call_context (Phase 5) ─────────────────────

/** 调用链上下文查询：直接转发到 structure.callContext */
export async function consolidatedCallContext(ctx: McpContext, args: ConsolidatedStructureArgs) {
  return structureHandlers.callContext(ctx, args);
}

// ─── alembic_graph (整合 4 → 1) ─────────────────────────

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

// ─── alembic_guard (整合 3 → 1) ─────────────────────────

/**
 * Guard 检查：按参数自动路由
 *   operation: 'coverage_matrix'    → guardCoverageMatrix()    (模块覆盖率矩阵)
 *   operation: 'compliance_report'  → guardComplianceReport()  (3D 合规报告)
 *   无参数       → guardReview()    (自动 git diff 检测 + inline recipe)
 *   有 files     → guardReview()    (指定文件 + inline recipe) — files 为 string[] 或 {path}[]
 *   有 code      → guardCheck()     (单文件内联检查)
 */
export async function consolidatedGuard(ctx: McpContext, args: ConsolidatedGuardArgs) {
  // operation 显式路由
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

// ─── alembic_skill (整合 6 → 1) ─────────────────────────

/**
 * Skill 管理：根据 operation 参数路由
 *   list    → listSkills()
 *   load    → loadSkill()
 *   create  → createSkill()
 *   update  → updateSkill()
 *   delete  → deleteSkill()
 */
export async function consolidatedSkill(ctx: McpContext, args: ConsolidatedSkillArgs) {
  const op = args.operation;
  if (!op) {
    throw new Error(
      'Missing required parameter: operation. Expected: list, load, create, update, delete'
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
    default:
      throw new Error(
        `Unknown skill operation: ${op}. Expected: list, load, create, update, delete`
      );
  }
}

// ─── alembic_submit_knowledge (unified pipeline) ──────────────────────

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
  const { RecipeProductionGateway } = await import('@alembic/core/knowledge');
  const { findSimilarRecipes } = await import('@alembic/core/service/candidate');

  const items = args.items as Record<string, unknown>[] | undefined;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return envelope({
      success: false,
      errorCode: 'INVALID_INPUT',
      message: 'items 数组是必需的且不能为空。请传入 items: [{ title, language, ... }]',
      meta: { tool: 'alembic_submit_knowledge' },
    });
  }

  const options = readSubmitKnowledgeOptions(args);
  const saveContext = await resolveSubmitKnowledgeSaveContext(ctx, options.clientId);
  if (!saveContext.allowed) {
    return saveContext.response;
  }

  // ── Step 2: MCP 特有预处理 ──
  prepareSubmitKnowledgeItems(items, options);
  const routeDiagnostics = describeSubmitKnowledgeProductionRoute(ctx, args, items);

  // 获取 bootstrapSession 已提交标题用于跨维度去重
  const submissionSets = readBootstrapSubmissionSets(ctx);

  // ── Step 3: 委托 RecipeProductionGateway 统一管道 ──
  const gateway = createRecipeProductionGateway(
    ctx,
    RecipeProductionGateway,
    saveContext.dataRoot,
    findSimilarRecipes
  );
  const gatewayResult = (await gateway.create({
    source: 'mcp-external',
    items: items as import('@alembic/core/knowledge').CreateRecipeItem[],
    options: {
      skipConsolidation: options.skipConsolidation,
      supersedes: options.supersedes,
      existingTitles: submissionSets.existingTitles,
      existingTriggers: submissionSets.existingTriggers,
      userId: getDeveloperIdentity(),
    },
  })) as RecipeGatewayResultLike;

  // ── Step 4: Bootstrap session 追踪 ──
  trackGatewayResult(ctx, items, options.dimensionId, gatewayResult);

  // ── Step 5: 构建统一响应 ──
  const successCount = gatewayResult.created.length;
  const data = buildSubmitKnowledgeResponseData(
    items,
    gatewayResult,
    routeDiagnostics,
    options.supersedes
  );

  // 全部拒绝 → 特殊错误响应（MT3: 附带 taxonomy problem + 字段级细节，
  // 修复认证矩阵标记的 zh-only 无结构拒绝）
  if (successCount === 0 && gatewayResult.rejected.length === items.length) {
    return buildAllRejectedSubmitKnowledgeResponse(items, gatewayResult, data);
  }

  const allOk = successCount === items.length;
  return envelope({
    success: successCount > 0,
    data,
    message: allOk
      ? `已提交 ${successCount} 条知识条目。`
      : `已提交 ${successCount}/${items.length} 条知识条目。`,
    meta: { tool: 'alembic_submit_knowledge' },
  });
}

interface SubmitKnowledgeOptions {
  clientId?: string;
  dimensionId?: string;
  skipConsolidation: boolean;
  source: string;
  supersedes?: string;
}

interface RecipeGatewayResultLike {
  blocked: unknown[];
  created: Array<{ id: string; title: string }>;
  merged: Array<{
    expiresAt: number;
    message: string;
    proposalId: string;
    status: string;
    targetRecipeId: string;
    targetTitle: string;
    type: string;
  }>;
  pendingSemanticReview?: Array<{ reason?: string }>;
  rejected: Array<{ errors: string[]; index: number; title: string; warnings?: unknown }>;
  supersedeProposal?: { proposalId: string };
}

type RecipeProductionGatewayConstructor =
  typeof import('@alembic/core/knowledge').RecipeProductionGateway;
type FindSimilarRecipes = typeof import('@alembic/core/service/candidate').findSimilarRecipes;

function readSubmitKnowledgeOptions(args: Record<string, unknown>): SubmitKnowledgeOptions {
  return {
    clientId: args.client_id as string | undefined,
    dimensionId: args.dimensionId as string | undefined,
    skipConsolidation: (args.skipConsolidation as boolean) === true,
    source: (args.source as string) || 'mcp',
    supersedes: args.supersedes as string | undefined,
  };
}

async function resolveSubmitKnowledgeSaveContext(ctx: McpContext, clientId: string | undefined) {
  // AD4: limiter relocated to infrastructure (former resident -> http inversion)
  const { resolveRecipeSaveRateLimiter } = await import(
    '../../infrastructure/rate-limit/RecipeSaveRateLimiter.js'
  );
  const { resolveDataRoot, resolveProjectRoot } = await import('@alembic/core/workspace');
  const projectRoot = resolveProjectRoot(ctx.container);
  const dataRoot = resolveDataRoot(ctx.container as never) || projectRoot;
  const limitCheck = resolveRecipeSaveRateLimiter(ctx.container).check(
    projectRoot,
    clientId || process.env.USER || 'mcp-client'
  );

  if (!limitCheck.allowed) {
    return {
      allowed: false as const,
      response: envelope({
        success: false,
        message: `提交过于频繁，请 ${limitCheck.retryAfter}s 后再试。`,
        errorCode: 'RATE_LIMIT',
        meta: { tool: 'alembic_submit_knowledge' },
      }),
    };
  }

  return { allowed: true as const, dataRoot };
}

function prepareSubmitKnowledgeItems(
  items: Record<string, unknown>[],
  options: SubmitKnowledgeOptions
) {
  for (const item of items) {
    if (!item.source) {
      item.source = options.source;
    }
    if (options.dimensionId && !item.dimensionId) {
      item.dimensionId = options.dimensionId;
    }
    if (item.dimensionId && typeof item.dimensionId === 'string') {
      const existingTags = Array.isArray(item.tags)
        ? item.tags.filter((tag): tag is string => typeof tag === 'string')
        : [];
      item.tags = dimensionTags(item.dimensionId, existingTags);
    }
  }
}

function readBootstrapSubmissionSets(ctx: McpContext) {
  let existingTitles: Set<string> | undefined;
  let existingTriggers: Set<string> | undefined;
  try {
    const sessionManager = ctx.container.get('bootstrapSessionManager');
    const bsSession = sessionManager?.getSession?.();
    if (bsSession?.submissionTracker?.getAllSubmittedTitles) {
      existingTitles = bsSession.submissionTracker.getAllSubmittedTitles();
    }
    if (bsSession?.submissionTracker?.getAllSubmittedTriggers) {
      existingTriggers = bsSession.submissionTracker.getAllSubmittedTriggers();
    }
  } catch {
    /* best effort */
  }
  return { existingTitles, existingTriggers };
}

function createRecipeProductionGateway(
  ctx: McpContext,
  RecipeProductionGateway: RecipeProductionGatewayConstructor,
  dataRoot: string,
  findSimilarRecipes: FindSimilarRecipes
) {
  return new RecipeProductionGateway({
    knowledgeService: ctx.container.get('knowledgeService'),
    projectRoot: dataRoot,
    consolidationAdvisor: getOptionalService(ctx, 'consolidationAdvisor'),
    proposalRepository: getOptionalService(ctx, 'proposalRepository'),
    evolutionGateway: getOptionalService(ctx, 'evolutionGateway'),
    findSimilarRecipes,
  });
}

function getOptionalService(ctx: McpContext, name: string) {
  try {
    return ctx.container.get(name) ?? null;
  } catch {
    return null;
  }
}

function trackGatewayResult(
  ctx: McpContext,
  items: Record<string, unknown>[],
  dimensionId: string | undefined,
  gatewayResult: RecipeGatewayResultLike
) {
  for (const created of gatewayResult.created) {
    _trackSubmission(
      ctx,
      items.find((it) => it.title === created.title) || {},
      dimensionId,
      created.id
    );
  }
  for (const rej of gatewayResult.rejected) {
    _trackRejection(ctx, items[rej.index] || {}, dimensionId);
  }
}

function buildSubmitKnowledgeResponseData(
  items: Record<string, unknown>[],
  gatewayResult: RecipeGatewayResultLike,
  routeDiagnostics: ReturnType<typeof describeSubmitKnowledgeProductionRoute>,
  supersedes: string | undefined
) {
  const data: Record<string, unknown> = {
    count: gatewayResult.created.length,
    total: items.length,
  };

  if (gatewayResult.created.length > 0) {
    data.ids = gatewayResult.created.map((c) => c.id);
  }
  data.productionRoute = {
    ...routeDiagnostics,
    createdIds: gatewayResult.created.map((c) => c.id),
    pendingPublication: gatewayResult.created.length > 0,
  };
  appendRejectedResponseData(data, gatewayResult, items.length);
  appendBlockedResponseData(data, gatewayResult);
  appendProposalResponseData(data, gatewayResult, supersedes);
  appendPendingSemanticReviewResponseData(data, gatewayResult);
  return data;
}

function appendRejectedResponseData(
  data: Record<string, unknown>,
  gatewayResult: RecipeGatewayResultLike,
  itemCount: number
) {
  if (gatewayResult.rejected.length === 0) {
    return;
  }
  const rejectedItems = gatewayResult.rejected.map((r) => ({
    index: r.index,
    title: r.title,
    errors: r.errors,
    warnings: r.warnings,
  }));
  data.rejectedItems = rejectedItems;
  data.rejectedSummary = {
    rejectedCount: rejectedItems.length,
    commonErrors: [...new Set(rejectedItems.flatMap((it) => it.errors))],
    message: `${rejectedItems.length}/${itemCount} 条知识条目因校验未通过被拒绝。`,
  };
}

function appendBlockedResponseData(
  data: Record<string, unknown>,
  gatewayResult: RecipeGatewayResultLike
) {
  if (gatewayResult.blocked.length === 0) {
    return;
  }
  data.blockedItems = gatewayResult.blocked;
  data.blockedSummary = {
    blockedCount: gatewayResult.blocked.length,
    message: `${gatewayResult.blocked.length} 条因融合分析被阻塞（与已有 Recipe 重叠或实质性不足）。设 skipConsolidation: true 可跳过。`,
  };
}

function appendProposalResponseData(
  data: Record<string, unknown>,
  gatewayResult: RecipeGatewayResultLike,
  supersedes: string | undefined
) {
  const createdProposals = buildCreatedProposals(gatewayResult, supersedes);
  if (createdProposals.length === 0) {
    return;
  }
  data.proposals = createdProposals;
  data.proposalSummary = {
    proposalCount: createdProposals.length,
    message: `${createdProposals.length} 条已创建进化提案，系统将在观察窗口到期后自动执行。无需额外操作。`,
  };
}

function buildCreatedProposals(
  gatewayResult: RecipeGatewayResultLike,
  supersedes: string | undefined
) {
  const createdProposals: unknown[] = gatewayResult.merged.map((m) => ({
    proposalId: m.proposalId,
    type: m.type,
    targetRecipe: { id: m.targetRecipeId, title: m.targetTitle },
    status: m.status,
    expiresAt: m.expiresAt,
    message: m.message,
  }));

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
  return createdProposals;
}

function appendPendingSemanticReviewResponseData(
  data: Record<string, unknown>,
  gatewayResult: RecipeGatewayResultLike
) {
  const pendingSemanticReview = gatewayResult.pendingSemanticReview ?? [];
  if (pendingSemanticReview.length === 0) {
    return;
  }
  data.pendingSemanticReview = pendingSemanticReview;
  data.nextAction = {
    tool: 'alembic_consolidate',
    args: {
      decisions: pendingSemanticReview.map((r) => ({
        newRecipeId: '',
        action: 'keep',
        reasoning: r.reason,
      })),
    },
    required: false,
    reason:
      `${pendingSemanticReview.length} 条候选处于相似度模糊区间（0.4-0.65），` +
      `字段分析不明确，建议阅读源代码后调用 alembic_consolidate 判断是否需要合并。`,
  };
}

function buildAllRejectedSubmitKnowledgeResponse(
  items: Record<string, unknown>[],
  gatewayResult: RecipeGatewayResultLike,
  data: Record<string, unknown>
) {
  const allMissing = [...new Set(gatewayResult.rejected.flatMap((it) => it.errors))];
  const fieldProblems = gatewayResult.rejected.flatMap((it, idx) =>
    it.errors.map((error: string) => ({
      field: `items[${typeof it.index === 'number' ? it.index : idx}]`,
      error,
    }))
  );
  return envelope({
    success: false,
    errorCode: 'INCOMPLETE_SUBMISSION',
    message:
      `全部 ${items.length} 条知识条目被拒绝。请在单次调用中补齐所有字段后重新提交。` +
      ` All ${items.length} items were rejected; see problem.fieldProblems for per-item missing fields.`,
    data: {
      rejectedItems: data.rejectedItems,
      requiredFields: getRequiredFieldsDescription(),
      commonErrors: allMissing,
    },
    problem: buildToolUsageProblem({
      code: 'INCOMPLETE_SUBMISSION',
      reasonCode: 'invalid-input',
      failingStep: 'recipe-production-gateway-validation',
      nextAction:
        'Fill the missing required fields listed in problem.fieldProblems (full contract in data.requiredFields) and resubmit ALL items in one call.',
      retryable: true,
      fieldProblems,
    }),
    meta: { tool: 'alembic_submit_knowledge' },
  });
}

// ── BootstrapSession 提交追踪辅助函数 ───────────────────────

interface SessionTrackerLike {
  id?: string;
  submissionTracker?: {
    getAllSubmittedTriggers?(): Set<string>;
    recordRejection(dimId: string, title: string, reason: string): void;
    recordSubmission(dimId: string, item: unknown, recipeId: string): void;
  };
  getProgress(): { remainingDimIds: string[] };
  toJSON?(): Record<string, unknown>;
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

export function describeSubmitKnowledgeProductionRoute(
  ctx: McpContext,
  args: Record<string, unknown>,
  items: readonly Record<string, unknown>[]
) {
  return {
    session: describeActiveSubmissionSession(ctx, args),
    metadata: summarizeSubmitKnowledgeMetadata(items),
    publication: {
      defaultAgentPublishAllowed: false,
      reason:
        'alembic_submit_knowledge creates reviewed pending entries only; publish remains an explicit admin/controller route.',
      authorizedRoutes: [
        {
          method: 'PATCH',
          path: '/api/v1/knowledge/:id/publish',
          requiredFlag: 'confirmed=true',
        },
        {
          method: 'POST',
          path: '/api/v1/knowledge/batch-publish',
          requiredFlag: 'confirmed=true',
        },
      ],
    },
    searchFreshness: {
      submitBehavior:
        'submit does not make pending entries searchable as active knowledge by itself',
      publishBehavior:
        'authorized publish routes refresh the resident search index and return searchFreshness diagnostics',
      eventBusBehavior:
        'when EventBus/SearchEngine are bound, knowledge:changed also refreshes SearchEngine best-effort',
    },
  };
}

function describeActiveSubmissionSession(ctx: McpContext, args: Record<string, unknown>) {
  const requestedSessionId = normalizeSessionRef(args.sessionId ?? args.bootstrapSessionRef);
  try {
    const sessionManager = ctx.container.get('bootstrapSessionManager') as
      | { getSession?: () => SessionTrackerLike | null }
      | null
      | undefined;
    const session = sessionManager?.getSession?.();
    if (!session) {
      return {
        status: 'missing',
        usable: false,
        requestedSessionId,
        reason:
          'No active bootstrap/rescan produce session is available; use alembic_rescan output or an authorized controller gap-fill session before claiming session-bound production.',
      };
    }

    const sessionId = readSessionId(session);
    if (requestedSessionId && sessionId && requestedSessionId !== sessionId) {
      return {
        status: 'invalid-session',
        usable: false,
        requestedSessionId,
        activeSessionId: sessionId,
        reason: 'Requested session id does not match the active production session.',
      };
    }

    const progress = safeSessionProgress(session);
    const remainingDimIds = progress?.remainingDimIds ?? [];
    const snapshot = safeSessionSnapshot(session);
    const taskCount =
      numberFromRecord(snapshot, 'total') ?? numberFromRecord(snapshot, 'totalTasks');
    const hasProduceWork =
      remainingDimIds.length > 0 || (typeof taskCount === 'number' && taskCount > 0);
    if (!hasProduceWork) {
      return {
        status: 'no-produce-session',
        usable: false,
        requestedSessionId,
        activeSessionId: sessionId,
        remainingDimIds,
        reason:
          'An active session exists, but it has no remaining produce dimensions/tasks for submit tracking.',
      };
    }

    return {
      status: 'active',
      usable: true,
      requestedSessionId,
      activeSessionId: sessionId,
      remainingDimIds,
    };
  } catch (err: unknown) {
    return {
      status: 'unavailable',
      usable: false,
      requestedSessionId,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function summarizeSubmitKnowledgeMetadata(items: readonly Record<string, unknown>[]) {
  const countWith = (field: string) => items.filter((item) => item[field] !== undefined).length;
  return {
    itemCount: items.length,
    preservedFields: [
      'relations',
      'moduleName',
      'headerPaths',
      'includeHeaders',
      'source',
      'sourceFile',
      'sourceCandidateId',
      'sourceRefs',
      'graphRefs',
      'sourceGraphRefs',
      'sourceGraph',
    ],
    itemsWithRelations: countWith('relations'),
    itemsWithModuleName: countWith('moduleName'),
    itemsWithHeaderPaths: countWith('headerPaths'),
    itemsWithIncludeHeaders: countWith('includeHeaders'),
    itemsWithSourceFile: countWith('sourceFile'),
    itemsWithSourceCandidateId: countWith('sourceCandidateId'),
    itemsWithSourceGraph:
      countWith('sourceGraph') + countWith('sourceGraphRefs') + countWith('graphRefs'),
  };
}

function normalizeSessionRef(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  return value.trim().replace(/^bootstrap-session:/, '');
}

function readSessionId(session: SessionTrackerLike): string | null {
  if (typeof session.id === 'string' && session.id.length > 0) {
    return session.id;
  }
  const snapshot = safeSessionSnapshot(session);
  const id = snapshot?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function safeSessionProgress(session: SessionTrackerLike): { remainingDimIds: string[] } | null {
  try {
    const progress = session.getProgress?.();
    if (!progress || !Array.isArray(progress.remainingDimIds)) {
      return null;
    }
    return {
      remainingDimIds: progress.remainingDimIds.filter(
        (dimId): dimId is string => typeof dimId === 'string' && dimId.length > 0
      ),
    };
  } catch {
    return null;
  }
}

function safeSessionSnapshot(session: SessionTrackerLike): Record<string, unknown> | null {
  try {
    const snapshot = session.toJSON?.();
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  } catch {
    return null;
  }
}

function numberFromRecord(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
