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

  const results: Record<string, { items?: unknown[]; total?: number }> = {};
  const pagination = { page, pageSize: limit };

  // 搜索知识条目（V3 统一模型）
  if (type === 'all' || type === 'recipe' || type === 'solution') {
    try {
      const knowledgeService = container.get('knowledgeService');
      results.recipes = await knowledgeService.search(q, pagination);
    } catch (err: unknown) {
      logger.warn('Knowledge 搜索失败', { query: q, error: (err as Error).message });
      results.recipes = { items: [], total: 0 };
    }
  }

  // 搜索 Guard Rule（boundary-constraint 类型的 Recipe）
  if (type === 'all' || type === 'rule') {
    try {
      const guardService = container.get('guardService');
      results.rules = await guardService.searchRules(q, pagination);
    } catch (err: unknown) {
      logger.warn('Guard Rule 搜索失败', { query: q, error: (err as Error).message });
      results.rules = { items: [], total: 0 };
    }
  }

  // 搜索候选知识条目 (V3: lifecycle=draft/pending)
  if (type === 'all' || type === 'candidate') {
    try {
      const knowledgeService = container.get('knowledgeService');
      results.candidates = await knowledgeService.search(q, pagination);
    } catch (err: unknown) {
      logger.warn('Candidate 搜索失败', { query: q, error: (err as Error).message });
      results.candidates = { items: [], total: 0 };
    }
  }

  const totalResults = Object.values(results).reduce(
    (sum, r) => sum + (r.total || r.items?.length || 0),
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
      ? graphService.getRelated(nodeId, nodeType, relation)
      : graphService.getEdges(nodeId, nodeType, direction);

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

    const impact = graphService.getImpactAnalysis(nodeId, nodeType, maxDepth);
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

  // 只返回 recipe 类型的关系边；module 依赖已由 /spm/dep-graph 提供
  const nodeType = req.query.nodeType || 'recipe';
  const edges = graphService.getAllEdges(limit, nodeType === 'all' ? undefined : nodeType);

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
          const r = await knowledgeRepo.findById(id);
          if (r) {
            nodeLabels[id] = r.title || r.name || id;
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

  const nodeType = req.query.nodeType || 'recipe';
  const stats = graphService.getStats(nodeType === 'all' ? undefined : nodeType);
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

    // 降级: KnowledgeService SQL LIKE
    if (results.length === 0) {
      try {
        const knowledgeService = container.get('knowledgeService');
        const list = await knowledgeService.search(keyword, { page: 1, pageSize });
        const items = list.data || list.items || [];
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
