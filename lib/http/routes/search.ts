/**
 * Search API 路由
 * 统一搜索接口 - 搜 Recipe（含所有知识类型）
 */

import Logger from '@alembic/core/logging';
import type { SearchResponse, SearchResponseMeta } from '@alembic/core/search';
import { resolveProjectRoot, type WorkspaceResolver } from '@alembic/core/workspace';
import express, { type Request, type Response } from 'express';
import type { z } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { resolveAlembicWorkspace } from '../../project-scope/ProjectScopeRegistry.js';
import {
  GraphImpactQuery,
  GraphQuery,
  ResidentSearchBody,
  SearchQuery,
  SimilarityBody,
} from '../../shared/schemas/http-requests.js';
import {
  hasSearchFilters,
  type NormalizedSearchFilters,
  normalizeSearchFilters,
  toSearchFilterRecord,
} from '../../shared/search-filters.js';
import type { SearchModeLabel } from '../../shared/semantic-taxonomy.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { safeInt } from '../utils/routeHelpers.js';

interface SearchRouteItem {
  id?: string;
  score?: number;
  vectorScore?: number;
  semanticScore?: number;
  [key: string]: unknown;
}

interface SearchRouteResult {
  items?: SearchRouteItem[];
  total?: number;
  query?: string;
  mode?: string;
  type?: string;
  ranked?: boolean;
  searchMeta?: SearchResponseMeta;
  [key: string]: unknown;
}

type SearchFallbackResults = Record<
  string,
  { data?: unknown[]; pagination?: Record<string, unknown> }
>;

interface ResidentSearchInput {
  category?: string;
  dimensionId?: string;
  filters?: Record<string, unknown>;
  groupByKind: boolean;
  kind?: string;
  knowledgeType?: string;
  language?: string;
  limit: number;
  mode: string;
  page: number;
  q: string;
  rank?: boolean;
  scope?: string;
  tags?: string[];
  type: string;
}

interface ResidentSearchVectorStats {
  count: number;
  dimension: number;
  embedProviderAvailable: boolean;
  hasIndex: boolean;
  indexSize?: number;
  quantized?: boolean;
}

interface ResidentSearchMeta {
  route: 'resident-search';
  service: 'alembic-daemon';
  coreRoute: string | null;
  requestedMode: SearchModeLabel;
  actualMode: SearchModeLabel;
  semanticRequested: boolean;
  semanticUsed: boolean;
  vectorUsed: boolean;
  degraded: boolean;
  degradedReason: string | null;
  fallbackReason?: string;
  appliedFilters: NormalizedSearchFilters;
  filterOnly: boolean;
  durationMs: number;
  resultCount: number;
  topScore: number | null;
  residentVector: {
    available: boolean;
    endpoint: '/api/v1/search';
    reason: string | null;
    stats: ResidentSearchVectorStats | null;
  };
  vector: {
    available: boolean;
    reason: string | null;
    stats: ResidentSearchVectorStats | null;
  };
  workspace: {
    dataRoot: string | null;
    dataRootSource: string | null;
    databasePath: string | null;
    projectId: string | null;
    projectRoot: string;
    runtimeDir: string | null;
    workspaceMode: string | null;
  };
}

const router = express.Router();
const logger = Logger.getInstance();
const RESIDENT_SEARCH_ENDPOINT = '/api/v1/search';

/**
 * GET /api/v1/search
 * 统一搜索
 * ?q=keyword&type=all|recipe|solution|rule&limit=20&mode=auto|keyword|semantic&groupByKind=true
 */
router.get('/', validateQuery(SearchQuery), async (req: Request, res: Response): Promise<void> => {
  const query = req.query as Record<string, string | string[] | boolean | undefined>;
  const { q, type = 'all', mode = 'keyword' } = query as Record<string, string>;
  return handleResidentSearch(req, res, {
    category: stringParam(query.category),
    dimensionId: stringParam(query.dimensionId),
    groupByKind:
      req.query.groupByKind === 'true' ||
      (req.query as Record<string, unknown>).groupByKind === true,
    kind: stringParam(query.kind),
    knowledgeType: stringParam(query.knowledgeType),
    language: stringParam(query.language),
    limit: safeInt(req.query.limit, 20, 1, 100),
    mode,
    page: safeInt(req.query.page, 1),
    q,
    scope: stringParam(query.scope),
    tags: stringArrayParam(query.tags ?? query.tag),
    type,
  });
});

router.post(
  '/',
  validate(ResidentSearchBody),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof ResidentSearchBody>;
    return handleResidentSearch(req, res, {
      category: body.category,
      dimensionId: body.dimensionId,
      filters: body.filters,
      groupByKind: body.groupByKind,
      kind: body.kind,
      knowledgeType: body.knowledgeType,
      language: body.language,
      limit: body.limit,
      mode: body.mode,
      page: body.page,
      q: body.query ?? body.q ?? '',
      rank: body.rank,
      scope: body.scope,
      tags: body.tags,
      type: body.type,
    });
  }
);

async function handleResidentSearch(
  _req: Request,
  res: Response,
  input: ResidentSearchInput
): Promise<void> {
  const container = getServiceContainer();
  const query = input.q;
  const searchFilters = normalizeSearchFilters({
    category: input.category,
    dimensionId: input.dimensionId,
    filters: input.filters,
    kind: input.kind,
    knowledgeType: input.knowledgeType,
    language: input.language,
    scope: input.scope,
    tags: input.tags,
  });
  const filterRecord = toSearchFilterRecord(searchFilters);

  // Public resident search is direct-search only. Prime/intent context belongs
  // to prime-owned routes, so this route passes only explicit query + filters.
  try {
    const searchEngine = container.get('searchEngine');
    const startedAt = performance.now();
    const result = (await searchEngine.search(query, {
      type: input.type,
      limit: input.limit,
      mode: input.mode,
      groupByKind: input.groupByKind,
      ...(typeof input.rank === 'boolean' ? { rank: input.rank } : {}),
      ...filterRecord,
    })) as SearchResponse & SearchRouteResult;
    const durationMs = Math.round(performance.now() - startedAt);
    const searchMeta = await buildResidentSearchMeta({
      container,
      durationMs,
      filters: searchFilters,
      requestedMode: input.mode,
      result,
    });
    return void res.json({ success: true, data: { ...result, query, searchMeta } });
  } catch (err: unknown) {
    logger.warn('SearchEngine 搜索失败，降级到传统搜索', {
      mode: input.mode,
      error: (err as Error).message,
    });
  }

  const fallback = await buildSearchCompatibilityFallback({
    container,
    input,
    query,
  });

  res.json({
    success: true,
    data: {
      query,
      type: input.type,
      mode: input.mode,
      totalResults: fallback.totalResults,
      searchMeta: await buildLegacySearchMeta({
        container,
        filters: searchFilters,
        mode: input.mode,
        resultCount: fallback.totalResults,
      }),
      ...fallback.results,
    },
  });
}

async function buildSearchCompatibilityFallback({
  container,
  input,
  query,
}: {
  container: ReturnType<typeof getServiceContainer>;
  input: ResidentSearchInput;
  query: string;
}): Promise<{
  results: SearchFallbackResults;
  totalResults: number;
}> {
  const results: SearchFallbackResults = {};
  const pagination = { page: input.page, pageSize: input.limit };
  await appendKnowledgeFallbackResults({ container, input, pagination, query, results });
  await appendGuardFallbackResults({ container, input, pagination, query, results });
  return {
    results,
    totalResults: countSearchFallbackResults(results),
  };
}

async function appendKnowledgeFallbackResults({
  container,
  input,
  pagination,
  query,
  results,
}: {
  container: ReturnType<typeof getServiceContainer>;
  input: ResidentSearchInput;
  pagination: { page: number; pageSize: number };
  query: string;
  results: SearchFallbackResults;
}): Promise<void> {
  if (!shouldReadKnowledgeFallback(input.type)) {
    return;
  }
  try {
    const knowledgeService = container.get('knowledgeService');
    const searchResult = await knowledgeService.search(query, pagination);
    if (input.type === 'all') {
      results.recipes = searchResult;
      results.candidates = searchResult;
    } else if (input.type === 'candidate') {
      results.candidates = searchResult;
    } else {
      results.recipes = searchResult;
    }
  } catch (err: unknown) {
    logger.warn('Knowledge 搜索失败', { query, error: (err as Error).message });
    if (input.type === 'all' || input.type === 'recipe' || input.type === 'solution') {
      results.recipes = emptyFallbackPage(input);
    }
    if (input.type === 'all' || input.type === 'candidate') {
      results.candidates = emptyFallbackPage(input);
    }
  }
}

async function appendGuardFallbackResults({
  container,
  input,
  pagination,
  query,
  results,
}: {
  container: ReturnType<typeof getServiceContainer>;
  input: ResidentSearchInput;
  pagination: { page: number; pageSize: number };
  query: string;
  results: SearchFallbackResults;
}): Promise<void> {
  if (input.type !== 'all' && input.type !== 'rule') {
    return;
  }
  try {
    const guardService = container.get('guardService');
    results.rules = await guardService.searchRules(query, pagination);
  } catch (err: unknown) {
    logger.warn('Guard Rule 搜索失败', { query, error: (err as Error).message });
    results.rules = emptyFallbackPage(input);
  }
}

function shouldReadKnowledgeFallback(type: string): boolean {
  return type === 'all' || type === 'recipe' || type === 'solution' || type === 'candidate';
}

function emptyFallbackPage(input: ResidentSearchInput): {
  data: never[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
} {
  return {
    data: [],
    pagination: { page: input.page, pageSize: input.limit, total: 0, pages: 0 },
  };
}

function countSearchFallbackResults(results: SearchFallbackResults): number {
  return Object.values(results).reduce(
    (sum, result) =>
      sum +
      ((result.pagination as Record<string, number> | undefined)?.total ||
        result.data?.length ||
        0),
    0
  );
}

async function buildResidentSearchMeta({
  container,
  durationMs,
  filters,
  requestedMode,
  result,
}: {
  container: ReturnType<typeof getServiceContainer>;
  durationMs: number;
  filters: NormalizedSearchFilters;
  requestedMode: string;
  result: SearchRouteResult;
}): Promise<ResidentSearchMeta> {
  const coreMeta = result.searchMeta;
  const actualMode = String(coreMeta?.actualMode || result.mode || requestedMode);
  const vectorStats = await readVectorStats(container);
  const residentVector = buildResidentVectorMeta(vectorStats);
  const semanticRequested = requestedMode === 'semantic';
  // Core SearchResponse.searchMeta 是 semantic/vector 是否真实命中的唯一事实源。
  // Alembic resident service 只补 HTTP/workspace/vector-index 观测信息；不能用 rrf/hybrid 字符串二次推断，
  // 否则 embed 失败后的 sparse-only RRF 会被误报成真实向量命中。
  const semanticUsed =
    typeof coreMeta?.semanticUsed === 'boolean'
      ? coreMeta.semanticUsed
      : inferLegacySemanticUsageWithoutRrf(actualMode);
  const vectorUsed =
    typeof coreMeta?.vectorUsed === 'boolean'
      ? coreMeta.vectorUsed
      : hasVectorLikeScore(result.items ?? []);
  const fallbackReason = coreMeta?.fallbackReason ?? null;
  const degraded = Boolean(fallbackReason) || (semanticRequested && !semanticUsed);
  const resultCount =
    typeof coreMeta?.resultCount === 'number'
      ? coreMeta.resultCount
      : typeof result.total === 'number'
        ? result.total
        : (result.items ?? []).length;
  const metaDurationMs =
    typeof coreMeta?.durationMs === 'number' ? coreMeta.durationMs : durationMs;
  const appliedFilters =
    readCoreAppliedFilters(coreMeta) ?? (hasSearchFilters(filters) ? filters : {});

  return {
    route: 'resident-search',
    service: 'alembic-daemon',
    coreRoute: typeof coreMeta?.route === 'string' ? coreMeta.route : null,
    requestedMode: coreMeta?.requestedMode ?? requestedMode,
    actualMode,
    semanticRequested,
    semanticUsed,
    vectorUsed,
    degraded,
    degradedReason:
      fallbackReason ??
      (degraded ? `semantic search requested but resident service returned ${actualMode}` : null),
    ...(fallbackReason ? { fallbackReason } : {}),
    appliedFilters,
    filterOnly: hasSearchFilters(appliedFilters),
    durationMs: metaDurationMs,
    resultCount,
    topScore: extractTopScore(result.items ?? []),
    residentVector,
    vector: {
      available: residentVector.available,
      reason: residentVector.reason,
      stats: residentVector.stats,
    },
    workspace: buildSearchWorkspaceIdentity(container),
  };
}

async function buildLegacySearchMeta({
  container,
  filters,
  mode,
  resultCount,
}: {
  container: ReturnType<typeof getServiceContainer>;
  filters: NormalizedSearchFilters;
  mode: string;
  resultCount: number;
}): Promise<ResidentSearchMeta> {
  const degraded = mode === 'semantic';
  return {
    route: 'resident-search',
    service: 'alembic-daemon',
    coreRoute: null,
    requestedMode: mode,
    actualMode: 'legacy-fallback',
    semanticRequested: mode === 'semantic',
    semanticUsed: false,
    vectorUsed: false,
    degraded,
    degradedReason:
      mode === 'semantic'
        ? 'SearchEngine unavailable; resident service used legacy non-vector fallback'
        : null,
    appliedFilters: filters,
    filterOnly: hasSearchFilters(filters),
    durationMs: 0,
    resultCount,
    topScore: null,
    residentVector: {
      available: false,
      endpoint: RESIDENT_SEARCH_ENDPOINT,
      reason: 'SearchEngine unavailable; vector route was not attempted',
      stats: null,
    },
    vector: {
      available: false,
      reason: 'SearchEngine unavailable; vector route was not attempted',
      stats: null,
    },
    workspace: buildSearchWorkspaceIdentity(container),
  };
}

function buildResidentVectorMeta({
  available,
  reason,
  stats,
}: {
  available: boolean;
  reason: string | null;
  stats: ResidentSearchVectorStats | null;
}): ResidentSearchMeta['residentVector'] {
  return {
    available,
    endpoint: RESIDENT_SEARCH_ENDPOINT,
    reason: available ? null : reason || 'vector service unavailable',
    stats,
  };
}

async function readVectorStats(container: ReturnType<typeof getServiceContainer>): Promise<{
  available: boolean;
  reason: string | null;
  stats: ResidentSearchVectorStats | null;
}> {
  try {
    const vectorService = container.get('vectorService') as unknown as {
      getStats?: () => Promise<{
        count?: number;
        dimension?: number;
        embedProviderAvailable?: boolean;
        indexSize?: number;
        quantized?: boolean;
      }>;
    } | null;
    if (!vectorService || typeof vectorService.getStats !== 'function') {
      return { available: false, reason: 'vectorService is not registered', stats: null };
    }

    const rawStats = await vectorService.getStats();
    const count = numberFrom(rawStats.count);
    const dimension = numberFrom(rawStats.dimension);
    const embedProviderAvailable = rawStats.embedProviderAvailable === true;
    return {
      available: count > 0 && dimension > 0 && embedProviderAvailable,
      reason:
        count > 0 && dimension > 0 && embedProviderAvailable
          ? null
          : 'vector index or embedding provider is unavailable',
      stats: {
        count,
        dimension,
        embedProviderAvailable,
        hasIndex: count > 0,
        indexSize: numberFrom(rawStats.indexSize),
        quantized: rawStats.quantized === true,
      },
    };
  } catch (err: unknown) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      stats: null,
    };
  }
}

function buildSearchWorkspaceIdentity(container: ReturnType<typeof getServiceContainer>) {
  const projectRoot = resolveProjectRoot(container);
  try {
    const resolver =
      (container.singletons?._workspaceResolver as WorkspaceResolver | undefined) ??
      resolveAlembicWorkspace(projectRoot);
    const facts = resolver.toFacts();
    return {
      dataRoot: resolver.dataRoot,
      dataRootSource: facts.dataRootSource,
      databasePath: resolver.databasePath,
      projectId: resolver.projectId,
      projectScope: facts.projectScope,
      projectScopeId: facts.projectScopeId,
      projectRoot: resolver.projectRoot,
      runtimeDir: resolver.runtimeDir,
      workspaceMode: facts.mode,
    };
  } catch {
    return {
      dataRoot: null,
      dataRootSource: null,
      databasePath: null,
      projectId: null,
      projectRoot,
      runtimeDir: null,
      workspaceMode: null,
    };
  }
}

function inferLegacySemanticUsageWithoutRrf(actualMode: string): boolean {
  const normalized = actualMode.toLowerCase();
  return normalized === 'semantic' || normalized.includes('semantic') || normalized === 'hybrid';
}

function hasVectorLikeScore(items: SearchRouteItem[]): boolean {
  return items.some((item) => item.vectorScore !== undefined || item.semanticScore !== undefined);
}

function extractTopScore(items: SearchRouteItem[]): number | null {
  const firstScore = items[0]?.score ?? items[0]?.vectorScore ?? items[0]?.semanticScore;
  return typeof firstScore === 'number' && Number.isFinite(firstScore) ? firstScore : null;
}

function numberFrom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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

function stringParam(value: string | string[] | boolean | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.find((entry) => entry.trim().length > 0);
  }
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringArrayParam(value: string | string[] | boolean | undefined): string[] | undefined {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => splitStringParam(entry));
  }
  if (typeof value === 'string') {
    return splitStringParam(value);
  }
  return undefined;
}

function splitStringParam(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * GET /api/v1/search/graph
 * 知识图谱查询
 * ?nodeId=xxx&nodeType=recipe
 */
router.get(
  '/graph',
  validateQuery(GraphQuery),
  async (req: Request, res: Response): Promise<void> => {
    const { nodeId, nodeType, relation, direction = 'both' } = req.query as Record<string, string>;

    const container = getServiceContainer();
    const graphService = container.get('knowledgeGraphService');

    if (!graphService) {
      return void res.json({ success: true, data: { outgoing: [], incoming: [] } });
    }

    const edges = relation
      ? await graphService.getRelated(nodeId, nodeType, relation)
      : await graphService.getEdges(nodeId, nodeType, direction);

    res.json({ success: true, data: edges });
  }
);

/**
 * GET /api/v1/search/graph/impact
 * 影响分析
 */
router.get(
  '/graph/impact',
  validateQuery(GraphImpactQuery),
  async (req: Request, res: Response): Promise<void> => {
    const { nodeId, nodeType } = req.query as Record<string, string>;
    const maxDepth = safeInt(req.query.maxDepth, 3, 1, 5);

    const container = getServiceContainer();
    const graphService = container.get('knowledgeGraphService');

    if (!graphService) {
      return void res.json({ success: true, data: [] });
    }

    const impact = await graphService.getImpactAnalysis(nodeId, nodeType, maxDepth);
    res.json({ success: true, data: impact });
  }
);

/**
 * GET /api/v1/search/graph/all
 * 全量知识图谱边（Dashboard 可视化用）
 * ?limit=500
 */
router.get('/graph/all', async (req: Request, res: Response): Promise<void> => {
  const limit = safeInt(req.query.limit, 500, 1, 2000);

  const container = getServiceContainer();
  const graphService = container.get('knowledgeGraphService');

  if (!graphService) {
    return void res.json({ success: true, data: { edges: [], nodeLabels: {} } });
  }

  // 默认不过滤 nodeType，返回所有知识相关边（recipe + knowledge）
  // 仅当显式指定 nodeType 时才过滤（module 类由 /spm/dep-graph 提供）
  const rawNodeType = req.query.nodeType as string | undefined;
  const nodeType = rawNodeType === 'all' ? undefined : rawNodeType || undefined;
  // 取更多原始边，因为 UUID 过滤会淘汰大量非 UUID 的代码分析边（method/class 等）
  // LIMIT 在 UUID 过滤之后应用，确保不会因为非 UUID 边占满配额导致返回 0
  const allEdges = await graphService.getAllEdges(limit * 10, nodeType);

  // 过滤掉非 UUID 节点（AI 生成的类名引用等幽灵节点）
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const edges = allEdges
    .filter((e) => UUID_RE.test(e.fromId) && UUID_RE.test(e.toId))
    .slice(0, limit);

  // 收集节点 ID + 类型 → 按类型查标签
  const nodeMap = new Map(); // id → Set<type>
  for (const e of edges) {
    if (!nodeMap.has(e.fromId)) {
      nodeMap.set(e.fromId, new Set());
    }
    nodeMap.get(e.fromId).add(e.fromType);
    if (!nodeMap.has(e.toId)) {
      nodeMap.set(e.toId, new Set());
    }
    nodeMap.get(e.toId).add(e.toType);
  }

  const nodeLabels: Record<string, string> = {};
  const nodeTypes: Record<string, string> = {}; // id → 主要类型（供前端区分渲染）
  const nodeCategories: Record<string, string> = {}; // id → category/target 名（供前端分组布局）
  if (nodeMap.size > 0) {
    const knowledgeRepo = container.get('knowledgeRepository');
    for (const [id, types] of nodeMap) {
      const primaryType = types.has('recipe') ? 'recipe' : [...types][0];
      nodeTypes[id] = primaryType;

      if ((primaryType === 'recipe' || primaryType === 'knowledge') && knowledgeRepo) {
        try {
          const r = (await knowledgeRepo.findById(id)) as {
            title?: string;
            category?: string;
          } | null;
          if (r) {
            nodeLabels[id] = r.title || id;
            nodeCategories[id] = r.category || '';
            continue;
          }
        } catch {
          /* not found – fall through */
        }
      }
      nodeLabels[id] = id;
    }
  }

  res.json({ success: true, data: { edges, nodeLabels, nodeTypes, nodeCategories } });
});

/**
 * GET /api/v1/search/graph/stats
 * 图谱统计
 */
router.get('/graph/stats', async (req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();
  const graphService = container.get('knowledgeGraphService');

  if (!graphService) {
    return void res.json({
      success: true,
      data: { totalEdges: 0, byRelation: {}, nodeTypes: [] },
    });
  }

  const rawStatsType = req.query.nodeType as string | undefined;
  const statsNodeType = rawStatsType === 'all' ? undefined : rawStatsType || undefined;
  const stats = await graphService.getStats(statsNodeType);
  res.json({ success: true, data: stats });
});

/* ═══ 相似度检测 ════════════════════════════════════════ */

/**
 * POST /api/v1/search/similarity
 * 候选与已有 Recipe 的相似度检测
 * Body: { code, language } 或 { targetName, candidateId } 或 { candidate: {title, summary, code} }
 */
router.post(
  '/similarity',
  validate(SimilarityBody),
  async (req: Request, res: Response): Promise<void> => {
    const { code, targetName, candidateId, candidate } = req.body;
    let dataRoot: string;
    try {
      const { resolveDataRoot } = await import('@alembic/core/workspace');
      const container = getServiceContainer();
      dataRoot = resolveDataRoot(container) || process.env.ALEMBIC_PROJECT_DIR || process.cwd();
    } catch {
      dataRoot = process.env.ALEMBIC_PROJECT_DIR || process.cwd();
    }

    let candidateObj:
      | { title: string; summary: string; code: string; usageGuide: string }
      | undefined;

    if (candidateId && targetName) {
      // 从知识库加载候选
      try {
        const container = getServiceContainer();
        const knowledgeService = container.get('knowledgeService');
        const entry = await knowledgeService.get(candidateId);
        if (entry) {
          const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
          candidateObj = {
            title: json.title || '',
            summary: json.description || '',
            code: json.content?.pattern || '',
            usageGuide: json.content?.markdown || '',
          };
        }
      } catch (err: unknown) {
        logger.warn('similarity: failed to load candidate', {
          candidateId,
          error: (err as Error).message,
        });
      }
    } else if (candidate) {
      candidateObj = {
        title: candidate.title || '',
        summary: candidate.summary || candidate.description || '',
        code: candidate.code || candidate.pattern || '',
        usageGuide: candidate.usageGuide || candidate.markdown || '',
      };
    } else if (code) {
      candidateObj = { title: '', summary: '', code: code || '', usageGuide: '' };
    }

    if (!candidateObj) {
      return void res.json({ success: true, data: { similar: [] } });
    }

    try {
      const { findSimilarRecipes } = await import('@alembic/core/service/candidate');
      const similar = findSimilarRecipes(dataRoot, candidateObj, { threshold: 0.3, topK: 10 });

      // 映射为前端期望格式
      const mapped = similar.map((s) => ({
        recipeName: s.title || s.file?.replace(/\.md$/, '') || '',
        similarity: s.similarity,
        file: s.file,
      }));

      res.json({ success: true, data: { similar: mapped } });
    } catch (err: unknown) {
      logger.warn('similarity search failed', { error: (err as Error).message });
      res.json({ success: true, data: { similar: [] } });
    }
  }
);

export default router;
