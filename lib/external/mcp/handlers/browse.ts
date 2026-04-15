/**
 * MCP Handlers — 知识浏览类 (V3: 使用 knowledgeService)
 * listByKind, listRecipes, getRecipe, recipeInsights, confirmUsage
 *
 * 投影原则：只交付 Agent 可操作的信号，不交付内部运营/审计数据。
 *   - _projectItem   → list 列表摘要（精简 ~10 字段）
 *   - _projectForAgent → get 详情（去除噪音 ~25 字段）
 */

import { envelope } from '../envelope.js';
import type {
  BrowseGetArgs,
  BrowseListArgs,
  ConfirmUsageArgs,
  KnowledgeEntryJSON,
  McpContext,
} from './types.js';

// ─── 通用投影辅助 ────────────────────────────────────────────

/**
 * 构建 actionHint — "whenClause → doClause" 的一句话可操作摘要。
 * Agent 在列表/搜索中即可判断是否需要深入获取该条目。
 */
function _buildActionHint(json: KnowledgeEntryJSON) {
  const doText = json.doClause || '';
  const whenText = json.whenClause || '';
  if (!doText && !whenText) {
    return undefined;
  }
  return `${whenText ? `${whenText} → ` : ''}${doText}`.replace(/ → $/, '');
}

/** 只保留非空关系桶，压缩 Relations 输出体积。 */
function _compactRelations(relations: Record<string, unknown[]> | undefined) {
  if (!relations) {
    return undefined;
  }
  const compact: Record<string, unknown[]> = {};
  for (const [type, list] of Object.entries(relations)) {
    if (Array.isArray(list) && list.length > 0) {
      compact[type] = list;
    }
  }
  return Object.keys(compact).length > 0 ? compact : undefined;
}

// ─── 列表投影 ────────────────────────────────────────────────

/**
 * 将 KnowledgeEntry 投影为列表摘要（精简版）
 * 移除: quality, stats, scope, tags, knowledgeType, 重复的 status/statistics
 * 新增: actionHint
 */
function _projectItem(r: KnowledgeEntryJSON) {
  const json = typeof r.toJSON === 'function' ? r.toJSON() : r;
  return {
    id: json.id,
    title: json.title,
    trigger: json.trigger || '',
    kind: json.kind,
    language: json.language,
    category: json.category,
    lifecycle: json.lifecycle,
    complexity: json.complexity,
    description: (json.description || '').slice(0, 120),
    actionHint: _buildActionHint(json),
  };
}

// ─── 详情投影 ────────────────────────────────────────────────

/**
 * 将 KnowledgeEntry 投影为 Agent 消费的详情格式。
 *
 * Tier 1（黄金字段）: trigger, doClause, dontClause, whenClause, coreCode, title, content.pattern, kind
 * Tier 2（上下文）  : language, category, description, tags, rationale, steps, headers, reasoning.whyStandard
 * Tier 3（去除噪音）: lifecycleHistory, autoApprovable, reviewedBy/At, sourceFile,
 *                    publishedAt/By, headerPaths, includeHeaders, quality.*, stats.*,
 *                    reasoning.sources/qualitySignals/alternatives, content.codeChanges/verification
 */
function _projectForAgent(json: KnowledgeEntryJSON) {
  // content 精简：保留 pattern/markdown/rationale/steps，去除 codeChanges/verification
  const content = json.content
    ? {
        ...(json.content.pattern ? { pattern: json.content.pattern } : {}),
        ...(json.content.markdown ? { markdown: json.content.markdown } : {}),
        ...(json.content.rationale ? { rationale: json.content.rationale } : {}),
        ...((json.content.steps?.length ?? 0) > 0 ? { steps: json.content.steps } : {}),
      }
    : undefined;

  // reasoning 精简：保留 whyStandard + confidence + sources（可信度证据链）
  const reasoning = json.reasoning
    ? {
        ...(json.reasoning.whyStandard ? { whyStandard: json.reasoning.whyStandard } : {}),
        ...(json.reasoning.confidence != null ? { confidence: json.reasoning.confidence } : {}),
        ...((json.reasoning.sources?.length ?? 0) > 0 ? { sources: json.reasoning.sources } : {}),
      }
    : undefined;

  // constraints 精简：仅保留 guards 和 sideEffects
  const constraints =
    (json.constraints?.guards?.length ?? 0) > 0 || (json.constraints?.sideEffects?.length ?? 0) > 0
      ? {
          ...((json.constraints?.guards?.length ?? 0) > 0
            ? { guards: json.constraints!.guards }
            : {}),
          ...((json.constraints?.sideEffects?.length ?? 0) > 0
            ? { sideEffects: json.constraints!.sideEffects }
            : {}),
        }
      : undefined;

  return {
    // ── 标识 ──
    id: json.id,
    title: json.title,
    description: json.description,
    trigger: json.trigger || '',

    // ── 分类 ──
    kind: json.kind,
    language: json.language,
    category: json.category,
    knowledgeType: json.knowledgeType,
    complexity: json.complexity,
    tags: (json.tags?.length ?? 0) > 0 ? json.tags : undefined,

    // ── Agent 可操作指令（Tier 1 黄金字段） ──
    whenClause: json.whenClause || undefined,
    doClause: json.doClause || undefined,
    dontClause: json.dontClause || undefined,
    coreCode: json.coreCode || undefined,

    // ── 内容 ──
    content: content && Object.keys(content).length > 0 ? content : undefined,

    // ── 上下文 ──
    headers: (json.headers?.length ?? 0) > 0 ? json.headers : undefined,
    reasoning: reasoning && Object.keys(reasoning).length > 0 ? reasoning : undefined,

    // ── 关系（仅非空桶） ──
    relations: _compactRelations(json.relations),

    // ── 约束（仅 guards + sideEffects） ──
    constraints,
  };
}

export async function listByKind(ctx: McpContext, kind: string, args: BrowseListArgs) {
  const ks = ctx.container.get('knowledgeService');
  const filters: Record<string, string> = { kind };
  if (args.language) {
    filters.language = args.language;
  }
  if (args.category) {
    filters.category = args.category;
  }
  const result = await ks.list(filters, { page: 1, pageSize: args.limit || 20 });
  const items = (result?.data || []).map(_projectItem);
  return envelope({
    success: true,
    data: { kind, count: items.length, total: result?.pagination?.total || items.length, items },
    meta: { tool: `asd_list_${kind}s` },
  });
}

export async function listRecipes(ctx: McpContext, args: BrowseListArgs) {
  const ks = ctx.container.get('knowledgeService');
  const filters: Record<string, string> = {};
  if (args.kind) {
    filters.kind = args.kind;
  }
  if (args.language) {
    filters.language = args.language;
  }
  if (args.category) {
    filters.category = args.category;
  }
  if (args.knowledgeType) {
    filters.knowledgeType = args.knowledgeType;
  }
  if (args.complexity) {
    filters.complexity = args.complexity;
  }
  if (args.status) {
    filters.lifecycle = args.status;
  }
  const result = await ks.list(filters, { page: 1, pageSize: args.limit || 20 });
  const items = (result?.data || []).map(_projectItem);
  return envelope({
    success: true,
    data: { count: items.length, total: result?.pagination?.total || items.length, items },
    meta: { tool: 'asd_list_recipes' },
  });
}

export async function getRecipe(ctx: McpContext, args: BrowseGetArgs) {
  if (!args.id) {
    throw new Error('id is required');
  }
  const ks = ctx.container.get('knowledgeService');
  const entry = await ks.get(args.id);
  if (!entry) {
    throw new Error(`Knowledge entry not found: ${args.id}`);
  }
  const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
  // Agent 投影：去除运营/审计/统计噪音，只交付可操作字段
  const projected = _projectForAgent(json);
  return envelope({ success: true, data: projected, meta: { tool: 'asd_get_recipe' } });
}

export async function recipeInsights(ctx: McpContext, args: BrowseGetArgs) {
  if (!args.id) {
    throw new Error('id is required');
  }
  const ks = ctx.container.get('knowledgeService');
  const entry = await ks.get(args.id);
  if (!entry) {
    throw new Error(`Knowledge entry not found: ${args.id}`);
  }
  const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;

  // 聚合关系摘要
  const relationsSummary: Record<string, number> = {};
  if (json.relations) {
    for (const [type, targets] of Object.entries(json.relations)) {
      if (Array.isArray(targets) && targets.length > 0) {
        relationsSummary[type] = targets.length;
      }
    }
  }

  // 约束条件概览
  const constraintsSummary: Record<string, unknown[]> = {};
  if (json.constraints) {
    for (const [type, items] of Object.entries(json.constraints)) {
      if (Array.isArray(items) && items.length > 0) {
        constraintsSummary[type] = items;
      }
    }
  }

  const insights = {
    id: json.id,
    title: json.title,
    trigger: json.trigger || '',
    kind: json.kind,
    lifecycle: json.lifecycle,
    language: json.language,
    category: json.category,
    knowledgeType: json.knowledgeType,
    quality: {
      overall: json.quality?.overall ?? null,
      completeness: json.quality?.completeness ?? null,
      adaptation: json.quality?.adaptation ?? null,
      documentation: json.quality?.documentation ?? null,
    },
    stats: {
      adoptions: json.stats?.adoptions ?? 0,
      applications: json.stats?.applications ?? 0,
      guardHits: json.stats?.guardHits ?? 0,
      views: json.stats?.views ?? 0,
      searchHits: json.stats?.searchHits ?? 0,
    },
    content: {
      hasPattern: !!json.content?.pattern,
      hasRationale: !!json.content?.rationale,
      hasMarkdown: !!json.content?.markdown,
      stepsCount: json.content?.steps?.length ?? 0,
      codeChangesCount: json.content?.codeChanges?.length ?? 0,
    },
    relations: relationsSummary,
    constraints: constraintsSummary,
    tags: json.tags || [],
    complexity: json.complexity,
    scope: json.scope,
    createdBy: json.createdBy,
    createdAt: json.createdAt,
    updatedAt: json.updatedAt,
  };

  return envelope({ success: true, data: insights, meta: { tool: 'asd_recipe_insights' } });
}

export async function confirmUsage(ctx: McpContext, args: ConfirmUsageArgs) {
  if (!args.recipeId) {
    throw new Error('recipeId is required');
  }
  const ks = ctx.container.get('knowledgeService');
  const usageType = args.usageType || 'adoption';
  const feedback = args.feedback || null;

  await ks.incrementUsage(args.recipeId, usageType, {
    feedback,
    actor: 'mcp_user',
  });

  // 持久化反馈到 FeedbackCollector（如有反馈内容）
  if (feedback) {
    try {
      const feedbackCollector = ctx.container.get('feedbackCollector');
      if (feedbackCollector) {
        feedbackCollector.record('feedback', args.recipeId, {
          usageType,
          comment: feedback,
        });
      }
    } catch {
      /* feedbackCollector 降级不影响主流程 */
    }
  }

  return envelope({
    success: true,
    data: { recipeId: args.recipeId, usageType, feedback },
    message: `已记录使用 ${args.recipeId} 的${usageType === 'adoption' ? '采纳' : '应用'}`,
    meta: { tool: 'asd_confirm_usage' },
  });
}
