/**
 * MCP Handlers — 搜索类
 *
 * v2: 合并原 4 个搜索函数（search / contextSearch / keywordSearch / semanticSearch）
 * 为统一 search() 入口，通过 mode 参数路由。
 * consolidated.ts 的 mode 路由直接指向本函数。
 *
 * 设计原则：
 * 1. 通过 container.get('searchEngine') 获取 singleton 实例（含 vectorStore + aiProvider）
 * 2. 统一 responseTime、byKind 分组、kind 过滤
 * 3. 投影使用 SearchTypes.slimSearchResult()（消除 3 处重复投影）
 */

import {
  groupByKind,
  type SlimSearchResult,
  slimSearchResult,
} from '#service/search/SearchTypes.js';
import { envelope } from '../envelope.js';
import type { McpContext, SearchArgs, SearchResultItem } from './types.js';

// ─── 工具函数 ────────────────────────────────────────────────

/**
 * 获取 SearchEngine singleton（带 vectorStore + aiProvider）
 * 避免每次调用 new SearchEngine(db) —— 那样没有向量能力、每次重建索引
 */
function getSearchEngine(ctx: McpContext) {
  try {
    return ctx.container.get('searchEngine');
  } catch {
    // 降级：直接创建基础实例（无向量能力）
    return null;
  }
}

/** 降级创建 SearchEngine（仅在 container 无法提供时） */
async function getFallbackEngine(ctx: McpContext) {
  const { SearchEngine } = await import('#service/search/SearchEngine.js');
  const db = ctx.container.get('database');
  return new SearchEngine(db);
}

/** 根据 kind 参数过滤 items */
function filterByKind(items: SearchResultItem[], kind: string) {
  if (!kind || kind === 'all') {
    return items;
  }
  return items.filter(
    (it: SearchResultItem) => (it.kind || it.metadata?.kind || 'pattern') === kind
  );
}

// ─── 统一搜索入口 ────────────────────────────────────────────

/**
 * 统一搜索入口 — 支持 auto / keyword / bm25 / semantic / context 五种模式
 *
 * 合并了原 search / contextSearch / keywordSearch / semanticSearch 4 个函数。
 * mode 路由:
 *   - auto (默认): BM25 + semantic 融合 + Ranking Pipeline
 *   - keyword: SQL LIKE 精确匹配，适合已知函数名/类名
 *   - bm25: BM25 (TF-IDF) 排序搜索
 *   - semantic: 向量语义搜索（不可用时降级 BM25）
 *   - context: BM25 + Ranking Pipeline + 会话上下文加成
 *
 * 所有模式共享: kind 过滤 → slimSearchResult 投影 → byKind 分组
 */
export async function search(ctx: McpContext, args: SearchArgs) {
  const t0 = Date.now();
  const engine = getSearchEngine(ctx) || (await getFallbackEngine(ctx));
  const query = args.query;
  const mode = args.mode || 'auto';
  const kind = args.kind || args.type || 'all';

  // ── Mode-specific 参数适配 ──

  // context 模式: 默认 limit=5, 传递 sessionHistory
  const isContext = mode === 'context';
  const limit = args.limit ?? (isContext ? 5 : 10);

  // keyword 模式不排序（默认），其他模式排序
  const rank = mode !== 'keyword';

  // context 模式额外传递会话上下文
  const context = isContext
    ? {
        intent: 'search',
        language: args.language,
        sessionHistory: args.sessionHistory || [],
      }
    : undefined;

  // kind 过滤时过采样 2x 以保证过滤后仍有足够结果
  const recallLimit = kind !== 'all' ? limit * 2 : limit;

  // semantic 模式也过采样 2x（向量搜索可能有噪声）
  const engineLimit = mode === 'semantic' ? recallLimit * 2 : recallLimit;

  // ── 统一调用 SearchEngine ──
  const result = await engine.search(query, {
    mode: isContext ? 'bm25' : mode,
    limit: engineLimit,
    rank,
    groupByKind: true,
    context,
  });

  let items = result?.items || [];
  const actualMode = result?.mode || mode;

  // ── Kind 过滤 + 截断 ──
  items = filterByKind(items, kind);
  items = items.slice(0, limit);

  // ── 统一投影: slimSearchResult() ──
  const slimItems = items.map(slimSearchResult);
  const byKindGroups = groupByKind(slimItems);
  const elapsed = Date.now() - t0;

  // ── 构造工具名称 ──
  const toolName = _toolName(mode);

  // ── semantic 降级提示 ──
  const degraded = mode === 'semantic' && actualMode !== 'semantic';

  // ── 统一响应格式 ──
  const source = result?.ranked ? 'search-engine+ranking' : 'search-engine';

  return envelope({
    success: true,
    data: {
      query,
      mode: actualMode,
      kind: kind === 'all' ? undefined : kind,
      totalResults: slimItems.length,
      items: slimItems,
      byKind: byKindGroups,
      kindCounts: {
        rule: byKindGroups.rule.length,
        pattern: byKindGroups.pattern.length,
        fact: byKindGroups.fact.length,
      },
      // semantic 模式专属: 降级提示
      ...(mode === 'semantic'
        ? {
            degraded,
            degradedReason: degraded ? 'vectorStore/aiProvider 不可用，已降级到 BM25' : undefined,
          }
        : {}),
      // context 模式专属: metadata 包装（保持向后兼容）
      ...(isContext
        ? {
            metadata: {
              responseTimeMs: elapsed,
              totalResults: slimItems.length,
              kindCounts: {
                rule: byKindGroups.rule.length,
                pattern: byKindGroups.pattern.length,
                fact: byKindGroups.fact.length,
              },
            },
          }
        : {}),
    },
    meta: { tool: toolName, source, responseTimeMs: elapsed },
  });
}

// ─── Backward-compatible aliases ────────────────────────────
// consolidated.ts 按 mode 路由时直接调用这些别名

/** contextSearch — mode='context' 的别名 */
export function contextSearch(ctx: McpContext, args: SearchArgs) {
  return search(ctx, { ...args, mode: 'context' });
}

/** keywordSearch — mode='keyword' 的别名 */
export function keywordSearch(ctx: McpContext, args: SearchArgs) {
  return search(ctx, { ...args, mode: 'keyword' });
}

/** semanticSearch — mode='semantic' 的别名 */
export function semanticSearch(ctx: McpContext, args: SearchArgs) {
  return search(ctx, { ...args, mode: 'semantic' });
}

// ─── 内部辅助 ────────────────────────────────────────────────

/** 根据 mode 返回对应的 MCP 工具名称 */
function _toolName(mode: string): string {
  switch (mode) {
    case 'context':
      return 'autosnippet_context_search';
    case 'keyword':
      return 'autosnippet_keyword_search';
    case 'semantic':
      return 'autosnippet_semantic_search';
    default:
      return 'autosnippet_search';
  }
}

// ─── Re-export slim projection for backward compatibility ────
// (部分内部模块可能直接 import 了这些)

/** @deprecated Use `slimSearchResult` from `SearchTypes.ts` instead */
export function _slimSearchItem(item: SearchResultItem): SlimSearchResult {
  return slimSearchResult(item as Parameters<typeof slimSearchResult>[0]);
}
