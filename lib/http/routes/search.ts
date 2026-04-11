/**
 * Search API 路由
 * 统一搜索接口 - 搜 Recipe（含所有知识类型）
 */

import express, { type Request, type Response } from 'express';
import {
  ContextAwareSearchBody,
  GraphImpactQuery,
  GraphQuery,
  SearchQuery,
  SimilarityBody,
} from '#shared/schemas/http-requests.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { safeInt } from '../utils/routeHelpers.js';

/** Search result from SearchEngine */
interface SearchEngineItem {
  title?: string;
  id?: string;
  content?: string | Record<string, string>;
  score?: number;
  authorityScore?: number;
  qualityScore?: number;
  usageCount?: number;
  code?: string;
  trigger?: string;
}

/** Knowledge entry from KnowledgeService */
interface KnowledgeItem {
  title?: string;
  id?: string;
  content?: { pattern?: string; markdown?: string };
  quality?: { overall?: number };
}

const router = express.Router();
const logger = Logger.getInstance();

/**
 * GET /api/v1/search
 * 统一搜索
 * ?q=keyword&type=all|recipe|solution|rule&limit=20&mode=keyword|bm25|semantic&groupByKind=true
 */
router.get('/', validateQuery(SearchQuery), async (req: Request, res: Response): Promise<void> => {
  const { q, type = 'all', mode = 'keyword' } = req.query as Record<string, string>;
  const limit = safeInt(req.query.limit, 20, 1, 100);
  const page = safeInt(req.query.page, 1);
  const groupByKind =
    req.query.groupByKind === 'true' || (req.query as Record<string, unknown>).groupByKind === true;

  const container = getServiceContainer();

  // 所有模式优先通过 SearchEngine（含 auto/bm25/semantic/keyword/ranking）
  try {
    const searchEngine = container.get('searchEngine');
    const result = await searchEngine.search(q, { type, limit, mode, groupByKind });
    return void res.json({ success: true, data: result });
  } catch (err: unknown) {
    logger.warn('SearchEngine 搜索失败，降级到传统搜索', { mode, error: (err as Error).message });
  }

  const results: Record<string, { data?: unknown[]; pagination?: Record<string, unknown> }> = {};
  const pagination = { page, pageSize: limit };

  // SearchEngine 不可用时的降级路径（Dashboard 冷启动场景）
  // recipes + candidates 共用 knowledgeService.search()，避免重复查询
  if (type === 'all' || type === 'recipe' || type === 'solution' || type === 'candidate') {
    try {
      const knowledgeService = container.get('knowledgeService');
      const searchResult = await knowledgeService.search(q, pagination);
      if (type === 'all') {
        results.recipes = searchResult;
        results.candidates = searchResult; // 同源数据，避免二次查询
      } else if (type === 'candidate') {
        results.candidates = searchResult;
      } else {
        results.recipes = searchResult;
      }
    } catch (err: unknown) {
      logger.warn('Knowledge 搜索失败', { query: q, error: (err as Error).message });
      if (type === 'all' || type === 'recipe' || type === 'solution') {
        results.recipes = { data: [], pagination: { page, pageSize: limit, total: 0, pages: 0 } };
      }
      if (type === 'all' || type === 'candidate') {
        results.candidates = {
          data: [],
          pagination: { page, pageSize: limit, total: 0, pages: 0 },
        };
      }
    }
  }

  // 搜索 Guard Rule（boundary-constraint 类型的 Recipe）
  if (type === 'all' || type === 'rule') {
    try {
      const guardService = container.get('guardService');
      results.rules = await guardService.searchRules(q, pagination);
    } catch (err: unknown) {
      logger.warn('Guard Rule 搜索失败', { query: q, error: (err as Error).message });
      results.rules = { data: [], pagination: { page, pageSize: limit, total: 0, pages: 0 } };
    }
  }

  const totalResults = Object.values(results).reduce(
    (sum, r) =>
      sum + ((r.pagination as Record<string, number> | undefined)?.total || r.data?.length || 0),
    0
  );

  res.json({
    success: true,
    data: {
      query: q,
      type,
      mode,
      totalResults,
      ...results,
    },
  });
});

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
  const edges = await graphService.getAllEdges(limit, nodeType);

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

/**
 * POST /api/v1/search/context-aware
 * 上下文感知搜索 — SearchEngine 内置 Ranking Pipeline（CoarseRanker + MultiSignalRanker + ContextBoost）
 */
router.post(
  '/context-aware',
  validate(ContextAwareSearchBody),
  async (req: Request, res: Response): Promise<void> => {
    const { keyword, limit, language, sessionHistory } = req.body;
    const t0 = Date.now();
    const container = getServiceContainer();
    const pageSize = Math.min(limit || 10, 100);
    let results: Record<string, unknown>[] = [];
    let source = 'knowledgeService';

    // SearchEngine BM25 + 内置 Ranking Pipeline
    try {
      const searchEngine = container.get('searchEngine');
      const result = await searchEngine.search(keyword, {
        mode: 'bm25',
        limit: pageSize,
        rank: true,
        context: { intent: 'search', language, sessionHistory: sessionHistory || [] },
      });
      const items = result?.items || [];
      if (items.length > 0) {
        source = result.ranked ? 'search-engine+ranking' : 'search-engine';
        results = items.map((r: SearchEngineItem) => {
          let contentStr = '';
          try {
            const c =
              typeof r.content === 'string' && r.content.startsWith('{')
                ? JSON.parse(r.content)
                : r.content || {};
            contentStr = c.pattern || c.markdown || c.code || '';
          } catch {
            contentStr = (r.content || r.code || '') as string;
          }
          return {
            name: `${r.title || r.id}.md`,
            content: contentStr,
            similarity: r.score || 0,
            authority: r.authorityScore || 0,
            matchType: result.ranked ? 'ranked' : 'bm25',
            qualityScore: r.qualityScore || 0,
            usageCount: r.usageCount || 0,
          };
        });
      }
    } catch (err: unknown) {
      logger.warn('SearchEngine context-aware 失败，降级到 KnowledgeService', {
        error: (err as Error).message,
      });
    }

    // 降级: SearchEngine 完全不可用时，KnowledgeService SQL LIKE (Dashboard 冷启动)
    if (results.length === 0) {
      try {
        const knowledgeService = container.get('knowledgeService');
        const list = await knowledgeService.search(keyword, { page: 1, pageSize });
        const items = list.data || [];
        results = items.map((r: KnowledgeItem) => ({
          name: `${r.title || r.id}.md`,
          content: r.content?.pattern || r.content?.markdown || '',
          similarity: 1,
          authority: r.quality?.overall || 0,
          matchType: 'keyword',
          qualityScore: r.quality?.overall || 0,
        }));
        source = 'knowledgeService';
      } catch {
        /* 全部失败 */
      }
    }

    const elapsed = Date.now() - t0;
    res.json({
      success: true,
      data: {
        results,
        context: {},
        total: results.length,
        hasAiEvaluation: false,
        searchTime: elapsed,
        source,
      },
    });
  }
);

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
    const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();

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
      const { findSimilarRecipes } = await import('../../service/candidate/SimilarityService.js');
      const similar = findSimilarRecipes(projectRoot, candidateObj, { threshold: 0.3, topK: 10 });

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
