/**
 * MCP 整合 Handler — 参数路由层
 *
 * 将整合后的工具（autosnippet_search / knowledge / structure / graph / guard / skill）
 * 按 operation / mode 参数路由到已有 handler 实现。
 *
 * 不包含业务逻辑，仅做参数解构 → 路由 → 转发。
 *
 * autosnippet_bootstrap 已迁移到 bootstrap-external.js（外部 Agent 路径）。
 */

import { getRequiredFieldsDescription } from '#domain/knowledge/FieldSpec.js';
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

// ─── autosnippet_search (整合 4 → 1) ────────────────────────

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

// ─── autosnippet_knowledge (整合 7 → 1) ─────────────────────

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

// ─── autosnippet_structure (整合 3 → 1) ─────────────────────

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

// ─── autosnippet_call_context (Phase 5) ─────────────────────

/** 调用链上下文查询：直接转发到 structure.callContext */
export async function consolidatedCallContext(ctx: McpContext, args: ConsolidatedStructureArgs) {
  return structureHandlers.callContext(ctx, args);
}

// ─── autosnippet_graph (整合 4 → 1) ─────────────────────────

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

// ─── autosnippet_guard (整合 3 → 1) ─────────────────────────

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

// ─── autosnippet_skill (整合 6 → 1) ─────────────────────────

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

// ─── autosnippet_submit_knowledge (unified pipeline) ──────────────────────

/**
 * 统一提交管线：单条与批量走同一代码路径。
 *
 * 流程:
 *   1. 解析 items[] → 限流
 *   2. 严格校验所有条目（UnifiedValidator）→ valid[] + rejected[]
 *   3. 融合分析（ConsolidationAdvisor.analyzeBatch）→ submittable[] + blocked[]
 *   4. 提交 submittable → enrich + service.create()
 *   5. 返回统一结果
 *
 * 设计原则：
 *   - 不降级：缺字段不自动补全，要求 Agent 一次性生成完整数据
 *   - 不碎片化：优先增强已有 Recipe，而非总新建
 *   - 不重复提交：拒绝时不创建任何记录
 *   - 单条/批量完全一致的校验与融合逻辑
 */
export async function enhancedSubmitKnowledge(ctx: McpContext, args: Record<string, unknown>) {
  const { submitKnowledge } = await import('./knowledge.js');
  const { UnifiedValidator } = await import('#domain/knowledge/UnifiedValidator.js');

  const items = args.items as Record<string, unknown>[] | undefined;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return envelope({
      success: false,
      errorCode: 'INVALID_INPUT',
      message: 'items 数组是必需的且不能为空。请传入 items: [{ title, language, ... }]',
      meta: { tool: 'autosnippet_submit_knowledge' },
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
      meta: { tool: 'autosnippet_submit_knowledge' },
    });
  }

  // ── Step 2: 严格校验所有条目 ──
  // v3: 注入前序维度已提交的标题，实现跨维度硬去重
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
  const validator = new UnifiedValidator(existingTitles ? { existingTitles } : {});
  const validItems: { index: number; item: Record<string, unknown> }[] = [];
  const rejectedItems: { index: number; title: string; errors: string[]; warnings: string[] }[] =
    [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // 合并批次级选项到条目
    if (!item.source) {
      item.source = source;
    }
    if (dimensionId && !item.dimensionId) {
      item.dimensionId = dimensionId;
    }

    const validation = validator.validate(item, { skipUniqueness: false });
    if (validation.pass) {
      validItems.push({ index: i, item });
      // 记录标题/指纹供后续去重检测
      validator.recordSubmission(
        item.title as string,
        (item.content as Record<string, unknown>)?.pattern as string
      );
    } else {
      rejectedItems.push({
        index: i,
        title: (item.title as string) || '(untitled)',
        errors: validation.errors,
        warnings: validation.warnings,
      });
      // 记录拒绝到 BootstrapSession tracker
      _trackRejection(ctx, item, dimensionId);
      // 仍然记录标题/指纹防止后续条目重复
      validator.recordSubmission(
        item.title as string,
        (item.content as Record<string, unknown>)?.pattern as string
      );
    }
  }

  // 全部被拒绝
  if (validItems.length === 0) {
    const allMissing = [...new Set(rejectedItems.flatMap((it) => it.errors))];
    return envelope({
      success: false,
      errorCode: 'INCOMPLETE_SUBMISSION',
      message: `全部 ${items.length} 条知识条目被拒绝。请在单次调用中补齐所有字段后重新提交。`,
      data: {
        rejectedItems,
        requiredFields: getRequiredFieldsDescription(),
        commonErrors: allMissing,
      },
      meta: { tool: 'autosnippet_submit_knowledge' },
    });
  }

  // ── Step 3: 融合分析（统一对所有有效条目运行） ──
  const submittableItems: { index: number; item: Record<string, unknown> }[] = [];
  const blockedItems: { index: number; title: string; consolidation: unknown }[] = [];
  const createdProposals: {
    proposalId: string;
    type: string;
    targetRecipe: { id: string; title: string };
    status: string;
    expiresAt: number;
    message: string;
  }[] = [];

  if (skipConsolidation) {
    submittableItems.push(...validItems);
  } else {
    const advisor = ctx.container.get('consolidationAdvisor');
    if (!advisor || typeof advisor.analyzeBatch !== 'function') {
      // DI 未注册时降级放行
      submittableItems.push(...validItems);
    } else {
      try {
        const candidates = validItems.map((v) => ({
          title: (v.item.title as string) || '',
          description: (v.item.description as string) || '',
          doClause: v.item.doClause as string | undefined,
          dontClause: v.item.dontClause as string | undefined,
          coreCode: v.item.coreCode as string | undefined,
          category: v.item.category as string | undefined,
          trigger: v.item.trigger as string | undefined,
          whenClause: v.item.whenClause as string | undefined,
          kind: v.item.kind as string | undefined,
          content: v.item.content as
            | { pattern?: string; markdown?: string; [key: string]: unknown }
            | undefined,
        }));

        const batchAdvice = advisor.analyzeBatch(candidates);

        // 尝试获取 ProposalRepository 以创建 Proposal（降级容忍）
        let proposalRepo:
          | import('../../../repository/evolution/ProposalRepository.js').ProposalRepository
          | null = null;
        try {
          proposalRepo = ctx.container.get('proposalRepository') ?? null;
        } catch {
          /* ProposalRepository 未注册，降级为旧的 blocked 模式 */
        }

        for (const { index: adviceIdx, advice } of batchAdvice.items) {
          const validEntry = validItems[adviceIdx];
          if (advice.action === 'create') {
            submittableItems.push(validEntry);
          } else if (
            proposalRepo &&
            (advice.action === 'merge' ||
              advice.action === 'reorganize' ||
              advice.action === 'insufficient')
          ) {
            // 创建 Proposal 而非简单 block — 系统后续自动处理
            const proposal = _createProposalFromAdvice(proposalRepo, advice, validEntry.item);
            if (proposal) {
              createdProposals.push(proposal);
            } else {
              // Proposal 创建失败（可能去重）→ 仍作为 blocked 返回
              blockedItems.push({
                index: validEntry.index,
                title: (validEntry.item.title as string) || '(untitled)',
                consolidation: advice,
              });
            }
          } else {
            blockedItems.push({
              index: validEntry.index,
              title: (validEntry.item.title as string) || '(untitled)',
              consolidation: advice,
            });
          }
        }

        // 将批次内重叠信息附加到 blockedItems
        if (batchAdvice.internalOverlaps.length > 0) {
          for (const overlap of batchAdvice.internalOverlaps) {
            const entryB = validItems[overlap.indexB];
            // 如果 B 已经被放行，降级为 blocked（批次内碎片化警告）
            const alreadyBlocked = blockedItems.some((b) => b.index === entryB.index);
            if (!alreadyBlocked) {
              const entryA = validItems[overlap.indexA];
              blockedItems.push({
                index: entryB.index,
                title: (entryB.item.title as string) || '(untitled)',
                consolidation: {
                  action: 'merge',
                  reason: `与同批次候选「${(entryA.item.title as string) || ''}」高度重叠（${(overlap.similarity * 100).toFixed(0)}%），建议合并后再提交。`,
                  internalOverlap: true,
                  overlapWith: {
                    index: entryA.index,
                    title: entryA.item.title,
                    similarity: overlap.similarity,
                  },
                },
              });
              // 从 submittable 中移除
              const subIdx = submittableItems.findIndex((s) => s.index === entryB.index);
              if (subIdx >= 0) {
                submittableItems.splice(subIdx, 1);
              }
            }
          }
        }
      } catch {
        // 分析失败时静默降级放行
        submittableItems.push(
          ...validItems.filter((v) => !submittableItems.some((s) => s.index === v.index))
        );
      }
    }
  }

  // ── Step 4: 提交所有通过的条目 ──
  let successCount = 0;
  const successIds: string[] = [];
  const submitErrors: { index: number; title: string; error: string }[] = [];

  for (const { index, item } of submittableItems) {
    try {
      const result = await submitKnowledge(ctx, {
        ...item,
        source: (item.source as string) || source,
        client_id: clientId,
      });

      if (result?.success && (result.data as Record<string, unknown>)?.id) {
        successCount++;
        const recipeId = (result.data as Record<string, unknown>).id as string;
        successIds.push(recipeId);
        _trackSubmission(ctx, item, dimensionId, recipeId);
      } else {
        submitErrors.push({
          index,
          title: (item.title as string) || '(untitled)',
          error: result?.message || 'unknown error',
        });
      }
    } catch (err: unknown) {
      submitErrors.push({
        index,
        title: (item.title as string) || '(untitled)',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Step 4b: Supersede 提案创建（统一进化架构入口） ──
  // 当 Agent 声明 supersedes 旧 Recipe 时，创建 supersede Proposal
  if (supersedes && successIds.length > 0) {
    const { createSupersedeProposal } = await import(
      '#service/evolution/createSupersedeProposal.js'
    );
    const proposal = createSupersedeProposal(ctx.container, {
      oldRecipeId: supersedes,
      newRecipeIds: successIds,
      source: 'ide-agent',
    });
    if (proposal) {
      createdProposals.push({
        proposalId: proposal.proposalId,
        type: 'supersede',
        targetRecipe: { id: supersedes, title: supersedes },
        status: proposal.status,
        expiresAt: proposal.expiresAt,
        message: proposal.message,
      });
    }
  }

  // ── Step 5: 构建统一响应 ──
  const data: Record<string, unknown> = {
    count: successCount,
    total: items.length,
  };

  if (successIds.length > 0) {
    data.ids = successIds;
  }
  if (submitErrors.length > 0) {
    data.errors = submitErrors;
  }
  if (rejectedItems.length > 0) {
    const allMissing = [...new Set(rejectedItems.flatMap((it) => it.errors))];
    data.rejectedItems = rejectedItems;
    data.rejectedSummary = {
      rejectedCount: rejectedItems.length,
      commonErrors: allMissing,
      message: `${rejectedItems.length}/${items.length} 条知识条目因校验未通过被拒绝。`,
    };
  }
  if (blockedItems.length > 0) {
    data.blockedItems = blockedItems;
    data.blockedSummary = {
      blockedCount: blockedItems.length,
      message: `${blockedItems.length} 条因融合分析被阻塞（与已有 Recipe 重叠或实质性不足）。设 skipConsolidation: true 可跳过。`,
    };
  }
  if (createdProposals.length > 0) {
    data.proposals = createdProposals;
    data.proposalSummary = {
      proposalCount: createdProposals.length,
      message: `${createdProposals.length} 条已创建进化提案，系统将在观察窗口到期后自动执行。无需额外操作。`,
    };
  }

  const allOk = successCount === items.length;
  return envelope({
    success: successCount > 0,
    data,
    message: allOk
      ? `已提交 ${successCount} 条知识条目。`
      : `已提交 ${successCount}/${items.length} 条知识条目。`,
    meta: { tool: 'autosnippet_submit_knowledge' },
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

// ── Proposal 创建辅助函数 ───────────────────────────

/**
 * 将 ConsolidationAdvisor 分析结果转为 evolution_proposals 记录。
 *
 * merge → Proposal(type: merge, target: 已有 Recipe)
 * reorganize → Proposal(type: reorganize, 高风险 → pending 等开发者确认)
 * insufficient → Proposal(type: enhance, target: 最相似 Recipe)
 */
function _createProposalFromAdvice(
  repo: import('../../../repository/evolution/ProposalRepository.js').ProposalRepository,
  advice: {
    action: string;
    confidence: number;
    reason: string;
    targetRecipe?: { id: string; title: string; similarity: number };
    reorganizeTargets?: { id: string; title: string; similarity: number }[];
    coveredBy?: { id: string; title: string; similarity: number }[];
    mergeDirection?: { addedDimensions: string[]; summary: string };
  },
  candidateItem: Record<string, unknown>
): {
  proposalId: string;
  type: string;
  targetRecipe: { id: string; title: string };
  status: string;
  expiresAt: number;
  message: string;
} | null {
  const evidence = [
    {
      snapshotAt: Date.now(),
      candidateTitle: candidateItem.title,
      candidateCategory: candidateItem.category,
      analysisReason: advice.reason,
      mergeDirection: advice.mergeDirection,
    },
  ];

  if (advice.action === 'merge' && advice.targetRecipe) {
    const proposal = repo.create({
      type: 'merge',
      targetRecipeId: advice.targetRecipe.id,
      confidence: advice.confidence,
      source: 'ide-agent',
      description: advice.reason,
      evidence,
    });
    if (!proposal) {
      return null;
    }
    return {
      proposalId: proposal.id,
      type: 'merge',
      targetRecipe: { id: advice.targetRecipe.id, title: advice.targetRecipe.title },
      status: proposal.status,
      expiresAt: proposal.expiresAt,
      message: `已为「${advice.targetRecipe.title}」创建融合提案，${proposal.status === 'observing' ? '观察窗口 72h 后自动执行' : '等待开发者确认'}。`,
    };
  }

  if (advice.action === 'reorganize' && advice.reorganizeTargets?.length) {
    const target = advice.reorganizeTargets[0];
    const proposal = repo.create({
      type: 'reorganize',
      targetRecipeId: target.id,
      relatedRecipeIds: advice.reorganizeTargets.slice(1).map((t) => t.id),
      confidence: advice.confidence,
      source: 'ide-agent',
      description: advice.reason,
      evidence,
    });
    if (!proposal) {
      return null;
    }
    return {
      proposalId: proposal.id,
      type: 'reorganize',
      targetRecipe: { id: target.id, title: target.title },
      status: proposal.status,
      expiresAt: proposal.expiresAt,
      message: `已为 ${advice.reorganizeTargets.length} 条 Recipe 创建重组提案，需开发者在 Dashboard 确认。`,
    };
  }

  if (advice.action === 'insufficient' && advice.coveredBy?.length) {
    const target = advice.coveredBy[0];
    const proposal = repo.create({
      type: 'enhance',
      targetRecipeId: target.id,
      confidence: advice.confidence,
      source: 'ide-agent',
      description: advice.reason,
      evidence,
    });
    if (!proposal) {
      return null;
    }
    return {
      proposalId: proposal.id,
      type: 'enhance',
      targetRecipe: { id: target.id, title: target.title },
      status: proposal.status,
      expiresAt: proposal.expiresAt,
      message: `候选独立价值不足，已创建增强提案建议补充到「${target.title}」。`,
    };
  }

  return null;
}
