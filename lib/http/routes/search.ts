/**
 * Search API 路由
 * 统一搜索接口 - 搜 Recipe（含所有知识类型）
 */

import express from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { ValidationError } from '../../shared/errors/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { safeInt } from '../utils/routeHelpers.js';

const router = express.Router();
const logger = Logger.getInstance();

/**
 * GET /api/v1/search
 * 统一搜索
 * ?q=keyword&type=all|recipe|solution|rule&limit=20&mode=keyword|bm25|semantic&groupByKind=true
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { q, type = 'all', mode = 'keyword' } = req.query;
    const limit = safeInt(req.query.limit, 20, 1, 100);
    const page = safeInt(req.query.page, 1);
    const groupByKind = req.query.groupByKind === 'true';

    if (!q || !q.trim()) {
      throw new ValidationError('Search query (q) is required');
    }

    const container = getServiceContainer();

    // 所有模式优先通过 SearchEngine（含 auto/bm25/semantic/keyword/ranking）
    try {
      const searchEngine = container.get('searchEngine');
      const result = await searchEngine.search(q, { type, limit, mode, groupByKind });
      return res.json({ success: true, data: result });
    } catch (err: any) {
      logger.warn('SearchEngine 搜索失败，降级到传统搜索', { mode, error: err.message });
    }

    const results: any = {};
    const pagination = { page, pageSize: limit };

    // 搜索知识条目（V3 统一模型）
    if (type === 'all' || type === 'recipe' || type === 'solution') {
      try {
        const knowledgeService = container.get('knowledgeService');
        results.recipes = await knowledgeService.search(q, pagination);
      } catch (err: any) {
        logger.warn('Knowledge 搜索失败', { query: q, error: err.message });
        results.recipes = { items: [], total: 0 };
      }
    }

    // 搜索 Guard Rule（boundary-constraint 类型的 Recipe）
    if (type === 'all' || type === 'rule') {
      try {
        const guardService = container.get('guardService');
        results.rules = await guardService.searchRules(q, pagination);
      } catch (err: any) {
        logger.warn('Guard Rule 搜索失败', { query: q, error: err.message });
        results.rules = { items: [], total: 0 };
      }
    }

    // 搜索候选知识条目 (V3: lifecycle=draft/pending)
    if (type === 'all' || type === 'candidate') {
      try {
        const knowledgeService = container.get('knowledgeService');
        results.candidates = await knowledgeService.search(q, pagination);
      } catch (err: any) {
        logger.warn('Candidate 搜索失败', { query: q, error: err.message });
        results.candidates = { items: [], total: 0 };
      }
    }

    const totalResults = Object.values(results).reduce(
      (sum, r: any) => sum + (r.total || r.items?.length || 0),
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
  })
);

/**
 * GET /api/v1/search/graph
 * 知识图谱查询
 * ?nodeId=xxx&nodeType=recipe
 */
router.get(
  '/graph',
  asyncHandler(async (req, res) => {
    const { nodeId, nodeType, relation, direction = 'both' } = req.query;

    if (!nodeId || !nodeType) {
      throw new ValidationError('nodeId and nodeType are required');
    }

    const container = getServiceContainer();
    const graphService = container.get('knowledgeGraphService');

    if (!graphService) {
      return res.json({ success: true, data: { outgoing: [], incoming: [] } });
    }

    const edges = relation
      ? graphService.getRelated(nodeId, nodeType, relation)
      : graphService.getEdges(nodeId, nodeType, direction);

    res.json({ success: true, data: edges });
  })
);

/**
 * GET /api/v1/search/graph/impact
 * 影响分析
 */
router.get(
  '/graph/impact',
  asyncHandler(async (req, res) => {
    const { nodeId, nodeType } = req.query;
    const maxDepth = safeInt(req.query.maxDepth, 3, 1, 5);

    if (!nodeId || !nodeType) {
      throw new ValidationError('nodeId and nodeType are required');
    }

    const container = getServiceContainer();
    const graphService = container.get('knowledgeGraphService');

    if (!graphService) {
      return res.json({ success: true, data: [] });
    }

    const impact = graphService.getImpactAnalysis(nodeId, nodeType, maxDepth);
    res.json({ success: true, data: impact });
  })
);

/**
 * GET /api/v1/search/graph/all
 * 全量知识图谱边（Dashboard 可视化用）
 * ?limit=500
 */
router.get(
  '/graph/all',
  asyncHandler(async (req, res) => {
    const limit = safeInt(req.query.limit, 500, 1, 2000);

    const container = getServiceContainer();
    const graphService = container.get('knowledgeGraphService');

    if (!graphService) {
      return res.json({ success: true, data: { edges: [], nodeLabels: {} } });
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

    const nodeLabels = {};
    const nodeTypes = {}; // id → 主要类型（供前端区分渲染）
    const nodeCategories = {}; // id → category/target 名（供前端分组布局）
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
  })
);

/**
 * GET /api/v1/search/graph/stats
 * 图谱统计
 */
router.get(
  '/graph/stats',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const graphService = container.get('knowledgeGraphService');

    if (!graphService) {
      return res.json({ success: true, data: { totalEdges: 0, byRelation: {}, nodeTypes: [] } });
    }

    const nodeType = req.query.nodeType || 'recipe';
    const stats = graphService.getStats(nodeType === 'all' ? undefined : nodeType);
    res.json({ success: true, data: stats });
  })
);

/**
 * POST /api/v1/search/context-aware
 * 上下文感知搜索 — SearchEngine 内置 Ranking Pipeline（CoarseRanker + MultiSignalRanker + ContextBoost）
 */
router.post(
  '/context-aware',
  asyncHandler(async (req, res) => {
    const { keyword, limit, language, sessionHistory } = req.body;
    if (!keyword || !keyword.trim()) {
      throw new ValidationError('keyword is required');
    }
    const t0 = Date.now();
    const container = getServiceContainer();
    const pageSize = Math.min(limit || 10, 100);
    let results = [];
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
        results = items.map((r) => {
          let contentStr = '';
          try {
            const c =
              typeof r.content === 'string' && r.content.startsWith('{')
                ? JSON.parse(r.content)
                : r.content || {};
            contentStr = c.pattern || c.markdown || c.code || '';
          } catch {
            contentStr = r.content || r.code || '';
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
    } catch (err: any) {
      logger.warn('SearchEngine context-aware 失败，降级到 KnowledgeService', {
        error: err.message,
      });
    }

    // 降级: KnowledgeService SQL LIKE
    if (results.length === 0) {
      try {
        const knowledgeService = container.get('knowledgeService');
        const list = await knowledgeService.search(keyword, { page: 1, pageSize });
        const items = list.data || list.items || [];
        results = items.map((r) => ({
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
  })
);

/* ═══ 相似度检测 ════════════════════════════════════════ */

/**
 * POST /api/v1/search/similarity
 * 候选与已有 Recipe 的相似度检测
 * Body: { code, language } 或 { targetName, candidateId } 或 { candidate: {title, summary, code} }
 */
router.post(
  '/similarity',
  asyncHandler(async (req, res) => {
    const { code, targetName, candidateId, candidate } = req.body;
    const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();

    let candidateObj;

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
      } catch (err: any) {
        logger.warn('similarity: failed to load candidate', { candidateId, error: err.message });
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
      return res.json({ success: true, data: { similar: [] } });
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
    } catch (err: any) {
      logger.warn('similarity search failed', { error: err.message });
      res.json({ success: true, data: { similar: [] } });
    }
  })
);

/**
 * POST /api/v1/search/xcode-simulate
 * Xcode 编辑器上下文模拟搜索
 * Body: { keyword, currentFile?, language?, limit? }
 */
router.post(
  '/xcode-simulate',
  asyncHandler(async (req, res) => {
    const { keyword, currentFile, language, limit = 10 } = req.body;
    if (!keyword) {
      throw new ValidationError('keyword is required');
    }

    const container = getServiceContainer();
    const pageSize = Math.min(limit || 10, 50);
    let results = [];

    // 复用 context-aware 搜索，注入 Xcode 上下文
    try {
      const searchEngine = container.get('searchEngine');
      const result = await searchEngine.search(keyword, {
        mode: 'bm25',
        limit: pageSize,
        rank: true,
        context: {
          intent: 'xcode-suggest',
          language: language || 'swift',
          currentFile,
        },
      });
      results = (result?.items || []).map((r) => {
        let contentStr = '';
        try {
          const c =
            typeof r.content === 'string' && r.content.startsWith('{')
              ? JSON.parse(r.content)
              : r.content || {};
          contentStr = c.pattern || c.markdown || c.code || '';
        } catch {
          contentStr = r.content || '';
        }
        return {
          name: `${r.title || r.id}.md`,
          content: contentStr,
          similarity: r.score || 0,
          trigger: r.trigger || '',
          matchType: result.ranked ? 'ranked' : 'bm25',
        };
      });
    } catch (err: any) {
      logger.warn('xcode-simulate search failed', { error: err.message });
    }

    res.json({ success: true, data: { results, total: results.length } });
  })
);

export default router;
