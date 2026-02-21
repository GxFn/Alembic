/**
 * MCP Handlers — V3 知识条目提交 & 生命周期
 * submitKnowledge, submitKnowledgeBatch, knowledgeLifecycle
 */

import { checkRecipeReadiness } from '../../../shared/RecipeReadinessChecker.js';
import { envelope } from '../envelope.js';

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

// ─── V3 字段增强 ────────────────────────────────────────────

/**
 * 将 MCP wire format 增强为 V3 KnowledgeEntry 数据：
 *   - 确保 source 为 'mcp'
 *   - QualityScorer 评分（程序化）
 *   - RecipeExtractor 语义标签（程序化）
 *   - 其余 V3 字段由 Cursor 生成，缺失即留空（KnowledgeEntry 构造函数填默认值）
 */
function _enrichToV3(args, container) {
  const data = { ...args };

  // 来源标记（非 Cursor 职责）
  if (!data.source) {
    data.source = 'mcp';
  }

  // QualityScorer 评分（程序化）
  try {
    const qualityScorer = container?.get?.('qualityScorer');
    if (qualityScorer) {
      const codeForScore = data.content?.pattern || data.content?.markdown || '';
      const scoreResult = qualityScorer.score({
        ...data,
        code: codeForScore,
      });
      data.quality = {
        completeness: 0,
        adaptation: 0,
        documentation: 0,
        overall: scoreResult.score ?? 0,
        grade: scoreResult.grade || '',
      };
    }
  } catch {
    /* best effort */
  }

  // RecipeExtractor 语义标签（程序化）
  try {
    const recipeExtractor = container?.get?.('recipeExtractor');
    if (recipeExtractor) {
      const codeForTags = data.content?.pattern || '';
      if (codeForTags) {
        const extracted = recipeExtractor.extractFromContent(
          codeForTags,
          `${data.title || 'unknown'}.${data.language || 'unknown'}`,
          ''
        );
        if (extracted.semanticTags?.length > 0) {
          data.tags = [...new Set([...(data.tags || []), ...extracted.semanticTags])];
        }
        if (
          (!data.category || data.category === 'Utility') &&
          extracted.category &&
          extracted.category !== 'general'
        ) {
          data.category = extracted.category;
        }
      }
    }
  } catch {
    /* best effort */
  }

  return data;
}

// ─── V3 wire format → KnowledgeService.create() ────────────

/**
 * 单条知识提交 (autosnippet_submit_knowledge)
 *
 * MCP wire format → V3 增强 → KnowledgeService.create()
 * 增强包括：source='mcp'、reasoning 默认值、Delivery 字段补齐、QualityScorer、语义标签。
 */
export async function submitKnowledge(ctx, args) {
  // 限流
  const blocked = await _checkRateLimit('autosnippet_submit_knowledge', args.client_id);
  if (blocked) {
    return blocked;
  }

  const service = ctx.container.get('knowledgeService');

  // V3 字段增强
  const enrichedData = _enrichToV3(args, ctx.container);

  const entry = await service.create(enrichedData, { userId: 'mcp' });

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
  if (blocked) {
    return blocked;
  }

  // 去重（可选）
  let items = args.items;
  if (args.deduplicate !== false) {
    try {
      const { aggregateCandidates } = await import(
        '../../../service/candidate/CandidateAggregator.js'
      );
      // 对 title 字段做去重
      const readinessItems = items.map((it) => ({
        ...it,
        code: it.content?.pattern || it.code || '',
      }));
      const result = aggregateCandidates(readinessItems);
      // 保留原始 items 顺序中去重后的
      if (result.items && result.items.length < items.length) {
        const titles = new Set(result.items.map((it) => it.title));
        items = items.filter((it) => titles.has(it.title));
      }
    } catch {
      // CandidateAggregator 加载失败时降级：不去重
    }
  }

  const service = ctx.container.get('knowledgeService');
  const source = args.source || 'cursor-scan';
  let count = 0;
  const itemErrors = [];
  const rejectedItems = [];

  for (let i = 0; i < items.length; i++) {
    // ── 严格前置校验：缺少必要字段的条目直接拒绝，不入库 ──
    const readinessInput = _toReadinessInput(items[i]);
    const readiness = checkRecipeReadiness(readinessInput);
    if (!readiness.ready) {
      rejectedItems.push({
        index: i,
        title: items[i].title || '(untitled)',
        missingFields: readiness.missing,
        suggestions: readiness.suggestions,
      });
      continue;
    }

    try {
      const itemData = _enrichToV3({ ...items[i], source }, ctx.container);
      await service.create(itemData, { userId: 'mcp' });
      count++;
    } catch (err) {
      itemErrors.push({ index: i, title: items[i].title || '(untitled)', error: err.message });
    }
  }

  const data = { count, total: items.length, targetName: args.target_name };
  if (itemErrors.length > 0) {
    data.errors = itemErrors;
  }

  // 被拒绝的条目：告知 Agent 需补齐哪些字段
  if (rejectedItems.length > 0) {
    const allMissing = [...new Set(rejectedItems.flatMap((it) => it.missingFields))];
    data.rejectedItems = rejectedItems;
    data.rejectedSummary = {
      rejectedCount: rejectedItems.length,
      totalCount: items.length,
      commonMissingFields: allMissing,
      message: `${rejectedItems.length}/${items.length} 条知识条目因缺少必要字段被拒绝（${allMissing.join(', ')}）。请一次性补齐所有字段后重新提交被拒绝的条目。`,
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
 * 保存开发文档 (autosnippet_save_document)
 *
 * 精简入口：仅需 title + markdown。
 * 自动设置 knowledgeType='dev-document', kind='fact', source='agent'。
 * 不走 RecipeReadiness 检查（文档无需 doClause/trigger）。
 * 支持 autoApprove — 文档直接进入 active 状态。
 */
export async function saveDocument(ctx, args) {
  if (!args.title || !args.title.trim()) {
    throw new Error('title 必填');
  }
  if (!args.markdown || !args.markdown.trim()) {
    throw new Error('markdown 必填');
  }

  // 限流
  const blocked = await _checkRateLimit('autosnippet_save_document', args.client_id);
  if (blocked) {
    return blocked;
  }

  const service = ctx.container.get('knowledgeService');

  const data = {
    title: args.title.trim(),
    description: args.description || '',
    knowledgeType: 'dev-document',
    kind: 'fact',
    source: args.source || 'agent',
    scope: args.scope || 'project-specific',
    tags: args.tags || [],
    content: {
      markdown: args.markdown,
      pattern: '',
    },
    // 文档不需要 Cursor Delivery 字段
    trigger: '',
    doClause: '',
    dontClause: '',
    whenClause: '',
    topicHint: '',
    coreCode: '',
    // 基础推理
    reasoning: {
      whyStandard: 'Agent development document — preserved for team knowledge',
      sources: ['agent'],
      confidence: 0.8,
    },
  };

  const entry = await service.create(data, { userId: 'mcp' });

  // 自动发布（dev-document 不需要人工审核）
  try {
    await service.publish(entry.id, { userId: 'mcp' });
  } catch {
    // 发布失败保持 pending — 非阻塞
  }

  return envelope({
    success: true,
    data: {
      id: entry.id,
      lifecycle: 'active',
      title: entry.title,
      kind: 'fact',
      knowledgeType: 'dev-document',
    },
    message: `文档「${entry.title}」已保存到知识库。`,
    meta: { tool: 'autosnippet_save_document' },
  });
}

// ─── 内部辅助 ──────────────────────────────────────────────

/**
 * V3 wire format → RecipeReadinessChecker 兼容格式
 */
function _toReadinessInput(args) {
  return {
    title: args.title,
    code: args.content?.pattern || args.code || '',
    language: args.language,
    category: args.category,
    trigger: args.trigger,
    description: args.description,
    headers: args.headers,
    reasoning: args.reasoning
      ? {
          whyStandard: args.reasoning.whyStandard,
          sources: args.reasoning.sources,
          confidence: args.reasoning.confidence,
        }
      : undefined,
    knowledgeType: args.knowledgeType,
    complexity: args.complexity,
    usageGuide: args.usageGuide,
    rationale: args.content?.rationale || args.rationale,
    // Cursor Delivery 字段
    kind: args.kind,
    doClause: args.doClause,
    dontClause: args.dontClause,
    whenClause: args.whenClause,
    topicHint: args.topicHint,
    coreCode: args.coreCode,
  };
}
