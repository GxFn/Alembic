/**
 * MCP Handlers — 知识浏览类 (V3: 使用 knowledgeService)
 * listByKind, listRecipes, getRecipe, recipeInsights, confirmUsage
 */

import { envelope } from '../envelope.js';

/** 将 KnowledgeEntry 的 V3 字段投影为列表摘要 */
function _projectItem(r) {
  const json = typeof r.toJSON === 'function' ? r.toJSON() : r;
  return {
    id: json.id,
    title: json.title,
    description: json.description,
    trigger: json.trigger || '',
    lifecycle: json.lifecycle,
    kind: json.kind,
    language: json.language,
    category: json.category,
    knowledgeType: json.knowledgeType,
    complexity: json.complexity,
    scope: json.scope,
    tags: json.tags || [],
    quality: json.quality || null,
    stats: json.stats || null,
    status: json.lifecycle,
    statistics: json.stats,
  };
}

export async function listByKind(ctx, kind, args) {
  const ks = ctx.container.get('knowledgeService');
  const filters = { kind };
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
    meta: { tool: `autosnippet_list_${kind}s` },
  });
}

export async function listRecipes(ctx, args) {
  const ks = ctx.container.get('knowledgeService');
  const filters = {};
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
    meta: { tool: 'autosnippet_list_recipes' },
  });
}

export async function getRecipe(ctx, args) {
  if (!args.id) {
    throw new Error('id is required');
  }
  const ks = ctx.container.get('knowledgeService');
  const entry = await ks.get(args.id);
  if (!entry) {
    throw new Error(`Knowledge entry not found: ${args.id}`);
  }
  const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
  return envelope({ success: true, data: json, meta: { tool: 'autosnippet_get_recipe' } });
}

export async function recipeInsights(ctx, args) {
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
  const relationsSummary = {};
  if (json.relations) {
    for (const [type, targets] of Object.entries(json.relations)) {
      if (Array.isArray(targets) && targets.length > 0) {
        relationsSummary[type] = targets.length;
      }
    }
  }

  // 约束条件概览
  const constraintsSummary = {};
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

  return envelope({ success: true, data: insights, meta: { tool: 'autosnippet_recipe_insights' } });
}

export async function confirmUsage(ctx, args) {
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
    meta: { tool: 'autosnippet_confirm_usage' },
  });
}
