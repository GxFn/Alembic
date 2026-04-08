/**
 * MCP Handlers — V3 知识条目提交 & 生命周期
 * submitKnowledge, submitKnowledgeBatch, knowledgeLifecycle
 */

import { UnifiedValidator } from '#domain/knowledge/UnifiedValidator.js';
import { resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { envelope } from '../envelope.js';
import type { McpContext, McpServiceContainer } from './types.js';

// ─── 限流 ──────────────────────────────────────────────────

async function _checkRateLimit(
  toolName: string,
  clientId: string | undefined,
  container?: Parameters<typeof resolveProjectRoot>[0]
) {
  const { checkRecipeSave } = await import('#http/middleware/RateLimiter.js');
  const projectRoot = resolveProjectRoot(container);
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
 *   - RecipeExtractor 语义标签（程序化）
 *   - 其余 V3 字段由 Cursor 生成，缺失即留空（KnowledgeEntry 构造函数填默认值）
 *
 * 注意: QualityScorer 评分已统一为 KnowledgeService.create() 后置执行 (R9)。
 * _enrichToV3 不再内联 QualityScorer，避免外部路径双重评分。
 */
interface EnrichInput {
  source?: string;
  title?: string;
  language?: string;
  tags?: string[];
  category?: string;
  content?: { pattern?: string; [key: string]: unknown };
  [key: string]: unknown;
}

function _enrichToV3(args: EnrichInput, container: McpServiceContainer | null): EnrichInput {
  const data: EnrichInput = { ...args };

  // 来源标记（非 Cursor 职责）
  if (!data.source) {
    data.source = 'mcp';
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
export async function submitKnowledge(
  ctx: McpContext,
  args: Record<string, unknown> & { client_id?: string }
) {
  // 限流
  const blocked = await _checkRateLimit(
    'autosnippet_submit_knowledge',
    args.client_id,
    ctx.container
  );
  if (blocked) {
    return blocked;
  }

  // Recipe-Ready 前置校验 — 使用 UnifiedValidator (统一门控)
  // 注意: 必须在 service.create() 之前校验，防止不合格数据入库
  const validator = new UnifiedValidator();
  const validation = validator.validate(args, { skipUniqueness: true });

  const service = ctx.container.get('knowledgeService');

  // V3 字段增强
  const enrichedData = _enrichToV3(args, ctx.container);

  const entry = await service.create(enrichedData, { userId: 'mcp' });

  // ── QualityScorer 自动评分（R9: create 后置执行）──
  try {
    await service.updateQuality(entry.id, { userId: 'mcp' });
  } catch {
    /* best effort — 不阻塞创建流程 */
  }

  const data: Record<string, unknown> = {
    id: entry.id,
    lifecycle: entry.lifecycle,
    title: entry.title,
    kind: entry.kind,
  };

  if (!validation.pass) {
    data.recipeReadyHints = {
      ready: false,
      missingFields: validation.errors,
      suggestions: validation.warnings,
    };
  } else if (validation.warnings.length > 0) {
    data.recipeReadyHints = {
      ready: true,
      missingFields: [],
      suggestions: validation.warnings,
    };
  }

  return envelope({
    success: true,
    data,
    meta: { tool: 'autosnippet_submit_knowledge' },
  });
}

/** 批量知识提交 (autosnippet_submit_knowledge_batch) */
interface KnowledgeItemInput {
  title?: string;
  content?: { pattern?: string; [key: string]: unknown };
  code?: string;
  [key: string]: unknown;
}

interface SubmitBatchArgs {
  target_name?: string;
  items: KnowledgeItemInput[];
  client_id?: string;
  deduplicate?: boolean;
  source?: string;
  dimensionId?: string;
  [key: string]: unknown;
}

export async function submitKnowledgeBatch(ctx: McpContext, args: SubmitBatchArgs) {
  if (!args.target_name || !Array.isArray(args.items) || args.items.length === 0) {
    throw new Error('需要 target_name 与 items（非空数组）');
  }

  // 限流
  const blocked = await _checkRateLimit(
    'autosnippet_submit_knowledge_batch',
    args.client_id,
    ctx.container
  );
  if (blocked) {
    return blocked;
  }

  // 去重（可选）
  let items = args.items;
  if (args.deduplicate !== false) {
    try {
      const { aggregateCandidates } = await import('#service/candidate/CandidateAggregator.js');
      // 对 title 字段做去重
      const readinessItems = items.map((it) => ({
        ...it,
        code: it.content?.pattern || it.code || '',
      }));
      const result = aggregateCandidates(
        readinessItems as unknown as Parameters<typeof aggregateCandidates>[0]
      );
      // 保留原始 items 顺序中去重后的
      if (result.items && result.items.length < items.length) {
        const titles = new Set(result.items.map((it) => it.title));
        items = items.filter((it) => titles.has(it.title!));
      }
    } catch (err: unknown) {
      // CandidateAggregator 加载失败时降级：不去重，但记录日志
      const { default: Logger } = await import('#infra/logging/Logger.js');
      Logger.getInstance().warn(
        `[submitKnowledgeBatch] CandidateAggregator 加载失败，跳过去重: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const service = ctx.container.get('knowledgeService');
  const source = args.source || 'cursor-scan';
  let count = 0;
  const itemErrors: { index: number; title: string; error: string }[] = [];
  const rejectedItems: {
    index: number;
    title: string;
    missingFields: string[];
    suggestions: string[];
  }[] = [];
  const successIds: string[] = []; // 成功入库的 recipe ID 列表，供 dimension_complete 使用

  // v2: 获取 BootstrapSession tracker（静默降级）
  interface BatchSessionLike {
    submissionTracker?: {
      recordRejection(dimId: string, title: string, reason: string): void;
      recordSubmission(dimId: string, item: unknown, recipeId: string): void;
      getAllSubmittedTitles?: (excludeDimId?: string) => Set<string>;
    };
    getProgress(): { remainingDimIds: string[] };
  }
  let session: BatchSessionLike | null = null;
  let currentDimId: string | null = null;
  try {
    const sessionManager = ctx.container.get('bootstrapSessionManager');
    session = sessionManager?.getSession?.();
    if (session?.submissionTracker) {
      const progress = session.getProgress();
      // 优先使用 Agent 显式传递的 dimensionId，其次推断 remainingDimIds[0]
      currentDimId =
        args.dimensionId || progress.remainingDimIds[0] || args.target_name || 'unknown';
    }
  } catch {
    /* best effort */
  }

  // UnifiedValidator — 统一前置校验
  // v3: 注入前序维度已提交的标题，实现跨维度硬去重
  let existingTitles: Set<string> | undefined;
  try {
    if (session?.submissionTracker?.getAllSubmittedTitles) {
      existingTitles = session.submissionTracker.getAllSubmittedTitles();
    }
  } catch {
    /* best effort */
  }
  const validator = new UnifiedValidator(existingTitles ? { existingTitles } : {});

  for (let i = 0; i < items.length; i++) {
    // ── 严格前置校验：缺少必要字段的条目直接拒绝，不入库 ──
    const validation = validator.validate(items[i], { skipUniqueness: false });
    if (!validation.pass) {
      rejectedItems.push({
        index: i,
        title: items[i].title || '(untitled)',
        missingFields: validation.errors,
        suggestions: validation.warnings,
      });
      // v2: 记录拒绝到 tracker
      if (session?.submissionTracker && currentDimId) {
        try {
          session.submissionTracker.recordRejection(
            currentDimId,
            items[i].title || '(untitled)',
            validation.errors.join(', ')
          );
        } catch {
          /* best effort */
        }
      }
      // 记录标题/指纹供后续去重检测
      validator.recordSubmission(items[i].title as string, items[i].content?.pattern as string);
      continue;
    }

    try {
      const itemData = _enrichToV3({ ...items[i], source }, ctx.container);
      const entry = await service.create(itemData, { userId: 'mcp' });
      // ── QualityScorer 自动评分（R9: create 后置执行）──
      try {
        await service.updateQuality(entry.id, { userId: 'mcp' });
      } catch {
        /* best effort — 不阻塞批量提交 */
      }
      count++;
      successIds.push(entry.id);
      // 记录标题/指纹供后续去重检测
      validator.recordSubmission(items[i].title as string, items[i].content?.pattern as string);
      // v2: 记录成功提交到 tracker
      if (session?.submissionTracker && currentDimId && entry?.id) {
        try {
          session.submissionTracker.recordSubmission(currentDimId, items[i], entry.id);
        } catch {
          /* best effort */
        }
      }
    } catch (err: unknown) {
      itemErrors.push({
        index: i,
        title: items[i].title || '(untitled)',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const data: Record<string, unknown> = {
    count,
    total: items.length,
    targetName: args.target_name,
  };
  if (successIds.length > 0) {
    data.ids = successIds; // recipe ID 列表，供 dimension_complete 的 submittedRecipeIds 使用
  }
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

export async function knowledgeLifecycle(
  ctx: McpContext,
  args: { id?: string; action?: string; [key: string]: unknown }
) {
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

// ─── (已删除: saveDocument — 已合并到 submit_knowledge 统一管线) ──
// ─── (已删除: _toReadinessInput — 统一使用 UnifiedValidator) ──
