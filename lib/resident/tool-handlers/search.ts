/**
 * MCP Handlers — 搜索类
 *
 * v2: 合并搜索函数，为统一 search() 入口，通过 mode 参数路由。
 * consolidated.ts 的 mode 路由直接指向本函数。
 *
 * 设计原则：
 * 1. 通过 container.get('searchEngine') 获取 singleton 实例（含 vectorStore + aiProvider）
 * 2. 统一 responseTime、byKind 分组、kind 过滤
 * 3. 投影使用 SearchTypes.slimSearchResult()（消除 3 处重复投影）
 */

import { groupByKind, type SearchResponseMeta, slimSearchResult } from '@alembic/core/search';
import {
  hasSearchFilters,
  type NormalizedSearchFilters,
  normalizeSearchFilters,
  toSearchFilterRecord,
} from '../../shared/search-filters.js';
import { envelope } from '../tool-schema/envelope.js';
import { buildToolUsageProblem } from '../tool-schema/problem.js';
import type { McpContext, SearchArgs, SearchResultItem } from '../tool-schema/types.js';

const PUBLIC_SEARCH_MODES = new Set(['auto', 'keyword', 'semantic']);

interface ResidentToolSearchMeta {
  actualMode: string;
  appliedFilters: NormalizedSearchFilters;
  degraded: boolean;
  degradedReason?: string;
  durationMs: number;
  fallbackReason?: string;
  filterOnly: boolean;
  requestedMode: string;
  resultCount: number;
  semanticUsed: boolean;
  topScore: number | null;
  vectorUsed: boolean;
}

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
  const { SearchEngine } = await import('@alembic/core/search');
  const db = ctx.container.get('database');
  const knowledgeRepo = ctx.container.get('knowledgeRepository');
  const sourceRefRepo = ctx.container.get('recipeSourceRefRepository');
  return new SearchEngine(db, { knowledgeRepo, sourceRefRepo } as Record<string, unknown>);
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
 * 统一搜索入口 — 支持 auto / keyword / semantic 三种 public 模式。
 *
 * mode 路由:
 *   - auto (默认): FieldWeighted + semantic 融合 + Ranking Pipeline
 *   - keyword: SQL LIKE 精确匹配，适合已知函数名/类名
 *   - semantic: 向量语义搜索（不可用时降级 weighted）
 *
 * 所有模式共享: kind 过滤 → slimSearchResult 投影 → byKind 分组
 */
export async function search(ctx: McpContext, args: SearchArgs) {
  const t0 = Date.now();
  const mode = typeof args.mode === 'string' && args.mode.length > 0 ? args.mode : 'auto';
  if (!PUBLIC_SEARCH_MODES.has(mode)) {
    return unsupportedSearchMode(mode, t0, _toolName(mode));
  }

  const engine = getSearchEngine(ctx) || (await getFallbackEngine(ctx));
  const kind = args.kind || args.type || 'all';
  const query = args.query;
  const limit = readLimit(args.limit, 10);
  const searchFilters = normalizeSearchFilters({
    category: args.category,
    dimensionId: args.dimensionId,
    filters: args.filters,
    kind: kind === 'all' ? undefined : kind,
    knowledgeType: args.knowledgeType,
    language: args.language,
    scope: args.scope,
    tags: args.tags,
  });
  const filterRecord = toSearchFilterRecord(searchFilters);

  const recallLimit = kind !== 'all' ? limit * 2 : limit;
  const engineLimit = mode === 'semantic' ? recallLimit * 2 : recallLimit;
  const rank = typeof args.rank === 'boolean' ? args.rank : mode !== 'keyword';

  const result = await engine.search(query, {
    mode,
    limit: engineLimit,
    rank,
    groupByKind: true,
    type: kind,
    ...filterRecord,
  });

  let items = (result?.items || []) as SearchResultItem[];
  const actualMode = result?.mode || mode;

  items = filterByKind(items, kind);
  items = items.slice(0, limit);

  const slimItems = items.map(slimSearchResult);
  const byKindGroups = groupByKind(slimItems);
  const elapsed = Date.now() - t0;
  const searchMeta = buildSearchMeta({
    actualMode,
    coreMeta: result?.searchMeta as SearchResponseMeta | undefined,
    durationMs: elapsed,
    filters: searchFilters,
    items,
    requestedMode: mode,
    total: result?.total,
  });
  const degraded = Boolean(searchMeta.degraded);
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
      searchMeta,
      kindCounts: {
        rule: byKindGroups.rule.length,
        pattern: byKindGroups.pattern.length,
        fact: byKindGroups.fact.length,
      },
      ...(mode === 'semantic'
        ? {
            degraded,
            degradedReason: degraded
              ? searchMeta.fallbackReason || searchMeta.degradedReason
              : undefined,
          }
        : {}),
    },
    meta: { tool: _toolName(mode), source, responseTimeMs: elapsed },
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

function unsupportedSearchMode(mode: string, startedAt: number, tool: string) {
  return envelope({
    success: false,
    errorCode: 'UNSUPPORTED_SEARCH_MODE',
    message: `Search mode "${mode}" is retired. Use auto, keyword, or semantic.`,
    problem: buildToolUsageProblem({
      code: 'UNSUPPORTED_SEARCH_MODE',
      reasonCode: 'invalid-input',
      failingStep: 'search-mode-validation',
      nextAction:
        'Use mode auto, keyword, or semantic with explicit metadata filters. Public bm25/context modes are retired.',
      fieldProblems: [{ field: 'mode', error: 'unsupported retired public search mode' }],
    }),
    meta: { tool, responseTimeMs: Date.now() - startedAt },
  });
}

function buildSearchMeta({
  actualMode,
  coreMeta,
  durationMs,
  filters,
  items,
  requestedMode,
  total,
}: {
  actualMode: string;
  coreMeta?: SearchResponseMeta;
  durationMs: number;
  filters: NormalizedSearchFilters;
  items: SearchResultItem[];
  requestedMode: string;
  total?: number;
}): ResidentToolSearchMeta {
  const semanticUsed =
    typeof coreMeta?.semanticUsed === 'boolean' ? coreMeta.semanticUsed : actualMode === 'semantic';
  const vectorUsed =
    typeof coreMeta?.vectorUsed === 'boolean'
      ? coreMeta.vectorUsed
      : items.some(
          (item) => typeof item.vectorScore === 'number' || typeof item.semanticScore === 'number'
        );
  const fallbackReason =
    typeof coreMeta?.fallbackReason === 'string' && coreMeta.fallbackReason.length > 0
      ? coreMeta.fallbackReason
      : undefined;
  const degraded = Boolean(fallbackReason) || (requestedMode === 'semantic' && !semanticUsed);
  const appliedFilters =
    readCoreAppliedFilters(coreMeta) ?? (hasSearchFilters(filters) ? filters : {});

  return {
    actualMode: String(coreMeta?.actualMode || actualMode),
    appliedFilters,
    degraded,
    ...(degraded
      ? {
          degradedReason:
            fallbackReason ||
            `semantic search requested but resident service returned ${actualMode}`,
        }
      : {}),
    durationMs: typeof coreMeta?.durationMs === 'number' ? coreMeta.durationMs : durationMs,
    ...(fallbackReason ? { fallbackReason } : {}),
    filterOnly: hasSearchFilters(appliedFilters),
    requestedMode: String(coreMeta?.requestedMode || requestedMode),
    resultCount:
      typeof coreMeta?.resultCount === 'number'
        ? coreMeta.resultCount
        : typeof total === 'number'
          ? total
          : items.length,
    semanticUsed,
    topScore: extractTopScore(items),
    vectorUsed,
  };
}

function readCoreAppliedFilters(
  coreMeta: SearchResponseMeta | undefined
): NormalizedSearchFilters | null {
  const raw = (coreMeta as { appliedFilters?: unknown } | undefined)?.appliedFilters;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const normalized = normalizeSearchFilters(raw as Record<string, unknown>);
  return hasSearchFilters(normalized) ? normalized : null;
}

function extractTopScore(items: SearchResultItem[]): number | null {
  const firstScore = items[0]?.score ?? items[0]?.vectorScore ?? items[0]?.semanticScore;
  return typeof firstScore === 'number' && Number.isFinite(firstScore) ? firstScore : null;
}

function readLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 根据 mode 返回对应的 MCP 工具名称 */
function _toolName(mode: string): string {
  switch (mode) {
    case 'context':
      return 'alembic_context_search';
    case 'keyword':
      return 'alembic_keyword_search';
    case 'semantic':
      return 'alembic_semantic_search';
    default:
      return 'alembic_search';
  }
}
