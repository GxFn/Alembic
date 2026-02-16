/**
 * MCP Handlers — V3 知识条目提交 & 生命周期
 * submitKnowledge, submitKnowledgeBatch, knowledgeLifecycle
 */

import { envelope } from '../envelope.js';
import { checkRecipeReadiness } from '../../../shared/RecipeReadinessChecker.js';

// ─── 限流 ──────────────────────────────────────────────────

async function _checkRateLimit(toolName, clientId) {
  const { checkRecipeSave } = await import('../../../http/middleware/RateLimiter.js');
  const projectRoot = process.cwd();
  const limitCheck = checkRecipeSave(projectRoot, clientId || process.env.USER || 'mcp-client');
  if (!limitCheck.allowed) {
    return envelope({
      success: false,
      message: `提交过于频繁，请 ${limitCheck.retryAfter}s 后再试。`,
      errorCode: 'RATE_LIMIT',
      meta: { tool: toolName },
    });
  }
  return null;
}

// ─── V3 wire format → KnowledgeService.create() 直通 ────────

/**
 * 单条知识提交 (autosnippet_submit_knowledge)
 *
 * args 就是 wire format — 直接交给 knowledgeService.create()。
 * 无需字段映射，fromJSON() 处理一切。
 */
export async function submitKnowledge(ctx, args) {
  // 限流
  const blocked = await _checkRateLimit('autosnippet_submit_knowledge', args.client_id);
  if (blocked) return blocked;

  const service = ctx.container.get('knowledgeService');

  // MCP 参数直接是 wire format
  const entry = await service.create(args, { userId: 'mcp' });

  // Recipe-Ready 诊断（兼容旧格式）
  const readinessInput = _toReadinessInput(args);
  const readiness = checkRecipeReadiness(readinessInput);

  const data = {
    id: entry.id,
    lifecycle: entry.lifecycle,
    title: entry.title,
    kind: entry.kind,
  };

  if (!readiness.ready) {
    data.recipeReadyHints = {
      ready: false,
      missingFields: readiness.missing,
      suggestions: readiness.suggestions,
      hint: '请补全以上字段后重新提交，或调用 autosnippet_enrich_candidates 进行完整性诊断',
    };
  }

  return envelope({
    success: true,
    data,
    meta: { tool: 'autosnippet_submit_knowledge' },
  });
}

/**
 * 批量知识提交 (autosnippet_submit_knowledge_batch)
 */
export async function submitKnowledgeBatch(ctx, args) {
  if (!args.target_name || !Array.isArray(args.items) || args.items.length === 0) {
    throw new Error('需要 target_name 与 items（非空数组）');
  }

  // 限流
  const blocked = await _checkRateLimit('autosnippet_submit_knowledge_batch', args.client_id);
  if (blocked) return blocked;

  // 去重（可选）
  let items = args.items;
  if (args.deduplicate !== false) {
    try {
      const { aggregateCandidates } = await import('../../../service/candidate/CandidateAggregator.js');
      // 对 title 字段做去重
      const readinessItems = items.map(it => ({
        ...it,
        code: it.content?.pattern || it.code || '',
      }));
      const result = aggregateCandidates(readinessItems);
      // 保留原始 items 顺序中去重后的
      if (result.items && result.items.length < items.length) {
        const titles = new Set(result.items.map(it => it.title));
        items = items.filter(it => titles.has(it.title));
      }
    } catch {
      // CandidateAggregator 加载失败时降级：不去重
    }
  }

  const service = ctx.container.get('knowledgeService');
  const source = args.source || 'cursor-scan';
  let count = 0;
  const itemErrors = [];

  for (let i = 0; i < items.length; i++) {
    try {
      const itemData = { ...items[i], source };
      await service.create(itemData, { userId: 'mcp' });
      count++;
    } catch (err) {
      itemErrors.push({ index: i, title: items[i].title || '(untitled)', error: err.message });
    }
  }

  const data = { count, total: items.length, targetName: args.target_name };
  if (itemErrors.length > 0) data.errors = itemErrors;

  // Recipe-Ready 统计
  const notReady = items.filter(it => !checkRecipeReadiness(_toReadinessInput(it)).ready);
  if (notReady.length > 0) {
    const allMissing = [...new Set(notReady.flatMap(it => checkRecipeReadiness(_toReadinessInput(it)).missing))];
    data.recipeReadyHints = {
      notReadyCount: notReady.length,
      totalCount: items.length,
      commonMissingFields: allMissing,
      hint: `${notReady.length}/${items.length} 条知识条目缺少必要字段（${allMissing.join(', ')}），请补全后重新提交`,
    };
  }

  return envelope({
    success: true,
    data,
    message: `已提交 ${count}/${items.length} 条知识条目。`,
    meta: { tool: 'autosnippet_submit_knowledge_batch' },
  });
}

/**
 * 知识条目生命周期操作 (autosnippet_knowledge_lifecycle)
 *
 * 简化为 3 状态: pending / active / deprecated
 * 外部 Agent 允许 reactivate（废弃 → 待审核）；发布/废弃由开发者在 Dashboard 操作
 * 外部 Agent 也可以通过 submitKnowledge / submitKnowledgeBatch 提交新条目（→ pending）
 */
const MCP_ALLOWED_LIFECYCLE_ACTIONS = new Set(['reactivate']);

export async function knowledgeLifecycle(ctx, args) {
  const { id, action } = args;
  if (!id || !action) {
    throw new Error('需要 id 和 action');
  }

  if (!MCP_ALLOWED_LIFECYCLE_ACTIONS.has(action)) {
    throw new Error(
      `[PERMISSION_DENIED] 外部 Agent 不允许执行 "${action}" 操作，仅支持: reactivate。发布、废弃等操作请在 Dashboard 中完成。提交新知识请使用 autosnippet_submit_knowledge 工具。`
    );
  }

  const service = ctx.container.get('knowledgeService');
  const context = { userId: 'mcp' };

  const entry = await service.reactivate(id, context);

  return envelope({
    success: true,
    data: {
      id: entry.id,
      lifecycle: entry.lifecycle,
      title: entry.title,
      action,
    },
    meta: { tool: 'autosnippet_knowledge_lifecycle' },
  });
}

// ─── 内部辅助 ──────────────────────────────────────────────

/**
 * V3 wire format → RecipeReadinessChecker 兼容格式
 * RecipeReadinessChecker 期望旧字段名 (code, summary_cn, ...)
 */
function _toReadinessInput(args) {
  return {
    title: args.title,
    code: args.content?.pattern || args.code || '',
    language: args.language,
    category: args.category,
    trigger: args.trigger,
    summary_cn: args.summary_cn,
    summary_en: args.summary_en,
    headers: args.headers,
    reasoning: args.reasoning ? {
      whyStandard: args.reasoning.why_standard || args.reasoning.whyStandard,
      sources: args.reasoning.sources,
      confidence: args.reasoning.confidence,
    } : undefined,
    knowledgeType: args.knowledge_type || args.knowledgeType,
    complexity: args.complexity,
    usageGuide: args.usage_guide_cn || args.usageGuide,
  };
}
