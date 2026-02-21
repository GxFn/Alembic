/**
 * MCP Handlers — 搜索类
 * search, contextSearch, keywordSearch, semanticSearch
 *
 * 设计原则：
 * 1. 通过 container.get('searchEngine') 获取 singleton 实例（含 vectorStore + aiProvider）
 * 2. 4 个工具各有差异化定位，不做简单 mode 包装
 * 3. 统一 responseTime、byKind 分组、kind 过滤
 */

import { envelope } from '../envelope.js';

// ─── 工具函数 ────────────────────────────────────────────────

/**
 * 获取 SearchEngine singleton（带 vectorStore + aiProvider）
 * 避免每次调用 new SearchEngine(db) —— 那样没有向量能力、每次重建索引
 */
function getSearchEngine(ctx) {
  try {
    return ctx.container.get('searchEngine');
  } catch {
    // 降级：直接创建基础实例（无向量能力）
    return null;
  }
}

/**
 * 降级创建 SearchEngine（仅在 container 无法提供时）
 */
async function getFallbackEngine(ctx) {
  const { SearchEngine } = await import('../../../service/search/SearchEngine.js');
  const db = ctx.container.get('database');
  return new SearchEngine(db);
}

/**
 * items → byKind 分组
 */
function groupByKind(items) {
  const byKind = { rule: [], pattern: [], fact: [] };
  for (const it of items) {
    const kind = it.kind || it.metadata?.kind || 'pattern';
    (byKind[kind] || byKind.pattern).push(it);
  }
  return byKind;
}

/**
 * 根据 kind 参数过滤 items
 */
function filterByKind(items, kind) {
  if (!kind || kind === 'all') {
    return items;
  }
  return items.filter((it) => (it.kind || it.metadata?.kind || 'pattern') === kind);
}

// ─── 1. autosnippet_search — 统合搜索入口 ─────────────────────

/**
 * 智能统合搜索 —— 支持 auto/keyword/bm25/semantic 四种模式
 *
 * mode=auto（默认）时，同时执行 BM25 + semantic，融合去重取分数最高者。
 * 支持 kind 过滤（rule/pattern/fact）和 byKind 自动分组。
 */
export async function search(ctx, args) {
  const t0 = Date.now();
  const engine = getSearchEngine(ctx) || (await getFallbackEngine(ctx));
  const query = args.query;
  const limit = args.limit || 10;
  const kind = args.kind || args.type || 'all';
  const mode = args.mode || 'auto';

  // 统一调用 SearchEngine（auto 模式内置 BM25+semantic 融合去重 + Ranking Pipeline）
  const result = await engine.search(query, {
    mode,
    limit: kind !== 'all' ? limit * 2 : limit,
    rank: true,
    groupByKind: true,
  });
  let items = result?.items || [];
  const actualMode = result?.mode || mode;

  // kind 过滤
  items = filterByKind(items, kind);
  items = items.slice(0, limit);

  const byKind = groupByKind(items);
  const elapsed = Date.now() - t0;

  return envelope({
    success: true,
    data: {
      query,
      mode: actualMode,
      kind: kind === 'all' ? undefined : kind,
      totalResults: items.length,
      items,
      byKind,
      kindCounts: {
        rule: byKind.rule.length,
        pattern: byKind.pattern.length,
        fact: byKind.fact.length,
      },
    },
    meta: { tool: 'autosnippet_search', responseTimeMs: elapsed },
  });
}

// ─── 2. autosnippet_context_search — 智能上下文搜索 ────────────

/**
 * 智能上下文搜索 —— SearchEngine 内置 Ranking Pipeline
 *
 * 设计原则：MCP 调用方是外部 AI Agent，意图识别由 Agent 自行完成。
 * 本工具聚焦数据检索：BM25 召回 + CoarseRanker + MultiSignalRanker + 上下文加成
 *
 * 特色：byKind 分组、个性化推荐、会话连续性
 */
export async function contextSearch(ctx, args) {
  const t0 = Date.now();
  const engine = getSearchEngine(ctx) || (await getFallbackEngine(ctx));
  const limit = args.limit ?? 5;

  const result = await engine.search(args.query, {
    mode: 'bm25',
    limit,
    rank: true,
    groupByKind: true,
    context: {
      intent: 'search',
      language: args.language,
      sessionHistory: args.sessionHistory || [],
    },
  });

  const items = (result?.items || []).slice(0, limit);
  const byKind = groupByKind(items);
  const elapsed = Date.now() - t0;
  const source = result?.ranked ? 'search-engine+ranking' : 'search-engine';

  return envelope({
    success: true,
    data: {
      items,
      byKind,
      metadata: {
        responseTimeMs: elapsed,
        totalResults: items.length,
        kindCounts: {
          rule: byKind.rule.length,
          pattern: byKind.pattern.length,
          fact: byKind.fact.length,
        },
      },
    },
    meta: { tool: 'autosnippet_context_search', source, responseTimeMs: elapsed },
  });
}

// ─── 3. autosnippet_keyword_search — SQL LIKE 精确匹配 ─────────

/**
 * 纯关键词精确匹配 —— SQL LIKE 查询，适合已知函数名/类名/变量名。
 * 与 search/semantic_search 的 BM25/向量搜索互补：
 * - keyword_search 对精确字符串（ObjC 方法名、类名前缀）最快最准
 * - search 对模糊查询更好（BM25 词频权重）
 * - semantic_search 对自然语言意图最好（向量相似度）
 */
export async function keywordSearch(ctx, args) {
  const t0 = Date.now();
  const engine = getSearchEngine(ctx) || (await getFallbackEngine(ctx));
  const query = args.query;
  const limit = args.limit || 10;
  const kind = args.kind || 'all';

  const result = await engine.search(query, {
    mode: 'keyword',
    limit,
    groupByKind: true,
  });

  let items = result?.items || [];
  items = filterByKind(items, kind).slice(0, limit);
  const byKind = groupByKind(items);
  const elapsed = Date.now() - t0;

  return envelope({
    success: true,
    data: {
      query,
      mode: 'keyword',
      kind: kind === 'all' ? undefined : kind,
      totalResults: items.length,
      items,
      byKind,
      kindCounts: {
        rule: byKind.rule.length,
        pattern: byKind.pattern.length,
        fact: byKind.fact.length,
      },
    },
    meta: { tool: 'autosnippet_keyword_search', responseTimeMs: elapsed },
  });
}

// ─── 4. autosnippet_semantic_search — 向量语义搜索 ──────────────

/**
 * 向量语义搜索 —— 基于 embedding 的相似度检索。
 * 通过 container singleton 的 SearchEngine（含 vectorStore + aiProvider）执行真正的向量搜索。
 * 如果向量引擎不可用会自动降级到 BM25，并在 actualMode 标注。
 *
 * kind 过滤 + byKind 分组一致性。
 */
export async function semanticSearch(ctx, args) {
  const t0 = Date.now();
  const engine = getSearchEngine(ctx) || (await getFallbackEngine(ctx));
  const query = args.query;
  const limit = args.limit || 10;
  const kind = args.kind || 'all';

  const result = await engine.search(query, {
    mode: 'semantic',
    limit: limit * 2,
    rank: true,
    groupByKind: true,
  });

  let items = result?.items || [];
  const actualMode = result?.mode || 'semantic';
  items = filterByKind(items, kind).slice(0, limit);
  const byKind = groupByKind(items);
  const elapsed = Date.now() - t0;

  // 提示 AI Agent 当前实际模式
  const degraded = actualMode !== 'semantic';

  return envelope({
    success: true,
    data: {
      query,
      mode: actualMode,
      kind: kind === 'all' ? undefined : kind,
      degraded,
      degradedReason: degraded ? 'vectorStore/aiProvider 不可用，已降级到 BM25' : undefined,
      totalResults: items.length,
      items,
      byKind,
      kindCounts: {
        rule: byKind.rule.length,
        pattern: byKind.pattern.length,
        fact: byKind.fact.length,
      },
    },
    meta: { tool: 'autosnippet_semantic_search', responseTimeMs: elapsed },
  });
}
