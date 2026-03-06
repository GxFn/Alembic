/**
 * query.js — 查询类工具 (6)
 *
 * 3. search_recipes       搜索知识库 Recipe
 * 2. search_candidates    搜索候选项
 * 3. get_recipe_detail    获取 Recipe 详情
 * 4. get_project_stats    获取项目统计
 * 5. search_knowledge     RAG 语义搜索
 * 6. get_related_recipes  知识图谱关联查询
 */

// ────────────────────────────────────────────────────────────
// 3. search_recipes
// ────────────────────────────────────────────────────────────
export const searchRecipes = {
  name: 'search_recipes',
  description:
    '搜索知识库中的 Recipe（代码片段/最佳实践/架构模式）。支持关键词搜索和按分类/语言/类型筛选。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜索关键词' },
      category: {
        type: 'string',
        description: '分类过滤 (View/Service/Tool/Model/Network/Storage/UI/Utility)',
      },
      language: { type: 'string', description: '编程语言过滤 (swift/objectivec/typescript 等)' },
      knowledgeType: {
        type: 'string',
        description: '知识类型过滤 (code-standard/code-pattern/architecture/best-practice 等)',
      },
      limit: { type: 'number', description: '返回数量上限，默认 10' },
    },
  },
  handler: async (params, ctx) => {
    const knowledgeService = ctx.container.get('knowledgeService');
    const { keyword, category, language, knowledgeType, limit = 10 } = params;

    if (keyword) {
      return knowledgeService.search(keyword, { page: 1, pageSize: limit });
    }

    const filters: any = { lifecycle: 'active' };
    if (category) {
      filters.category = category;
    }
    if (language) {
      filters.language = language;
    }
    if (knowledgeType) {
      filters.knowledgeType = knowledgeType;
    }

    return knowledgeService.list(filters, { page: 1, pageSize: limit });
  },
};

// ────────────────────────────────────────────────────────────
// 2. search_candidates
// ────────────────────────────────────────────────────────────
export const searchCandidates = {
  name: 'search_candidates',
  description: '搜索或列出候选项（待审核的代码片段）。支持关键词搜索和按状态/语言/分类筛选。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜索关键词' },
      status: { type: 'string', description: '状态过滤 (pending/approved/rejected/applied)' },
      language: { type: 'string', description: '编程语言过滤' },
      category: { type: 'string', description: '分类过滤' },
      limit: { type: 'number', description: '返回数量上限，默认 10' },
    },
  },
  handler: async (params, ctx) => {
    const knowledgeService = ctx.container.get('knowledgeService');
    const { keyword, status, language, category, limit = 10 } = params;

    if (keyword) {
      return knowledgeService.search(keyword, { page: 1, pageSize: limit });
    }

    // V3: status 映射为 lifecycle
    const filters: any = {};
    if (status) {
      filters.lifecycle = status;
    }
    if (language) {
      filters.language = language;
    }
    if (category) {
      filters.category = category;
    }

    return knowledgeService.list(filters, { page: 1, pageSize: limit });
  },
};

// ────────────────────────────────────────────────────────────
// 3. get_recipe_detail
// ────────────────────────────────────────────────────────────
export const getRecipeDetail = {
  name: 'get_recipe_detail',
  description: '获取单个 Recipe 的完整详情（代码、摘要、使用指南、关系等）。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
    },
    required: ['recipeId'],
  },
  handler: async (params, ctx) => {
    const knowledgeService = ctx.container.get('knowledgeService');
    try {
      const entry = await knowledgeService.get(params.recipeId);
      return typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
    } catch {
      return { error: `Knowledge entry '${params.recipeId}' not found` };
    }
  },
};

// ────────────────────────────────────────────────────────────
// 4. get_project_stats
// ────────────────────────────────────────────────────────────
export const getProjectStats = {
  name: 'get_project_stats',
  description:
    '获取项目知识库的整体统计：Recipe 数量/分类分布、候选项数量/状态分布、知识图谱节点/边数。',
  parameters: { type: 'object', properties: {} },
  handler: async (_params, ctx) => {
    const knowledgeService = ctx.container.get('knowledgeService');
    const stats = await knowledgeService.getStats();

    // 尝试获取知识图谱统计
    let graphStats: any = null;
    try {
      const kgService = ctx.container.get('knowledgeGraphService');
      graphStats = kgService.getStats();
    } catch {
      /* KG not available */
    }

    return {
      knowledge: stats,
      knowledgeGraph: graphStats,
    };
  },
};

// ────────────────────────────────────────────────────────────
// 5. search_knowledge
// ────────────────────────────────────────────────────────────
export const searchKnowledge = {
  name: 'search_knowledge',
  description: 'RAG 知识库语义搜索 — 结合向量检索和关键词检索，返回与查询最相关的知识片段。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索查询' },
      topK: { type: 'number', description: '返回结果数，默认 5' },
    },
    required: ['query'],
  },
  handler: async (params, ctx) => {
    const { query, topK = 5 } = params;

    // 优先使用 SearchEngine（有 BM25 + 向量搜索）
    try {
      const searchEngine = ctx.container.get('searchEngine');
      const results = await searchEngine.search(query, { limit: topK });
      if (results && results.length > 0) {
        const enriched = results.slice(0, topK).map((r, i) => ({
          ...r,
          reasoning: {
            whyRelevant:
              r.score != null
                ? `匹配分 ${(r.score * 100).toFixed(0)}%${r.matchType ? ` (${r.matchType})` : ''}`
                : '语义相关',
            rank: i + 1,
          },
        }));
        const topScore = enriched[0]?.score ?? 0;
        return {
          source: 'searchEngine',
          results: enriched,
          _meta: {
            confidence: topScore > 0.7 ? 'high' : topScore > 0.3 ? 'medium' : 'low',
            hint: topScore < 0.3 ? '匹配度较低，结果可能不够相关。建议尝试更具体的查询词。' : null,
          },
        };
      }
    } catch {
      /* SearchEngine not available */
    }

    // 降级: RetrievalFunnel + 全量候选
    try {
      const funnel = ctx.container.get('retrievalFunnel');
      const knowledgeRepo = ctx.container.get('knowledgeRepository');
      const allResult = await knowledgeRepo.findWithPagination({}, { page: 1, pageSize: 500 });
      const allRecipes = allResult?.items || [];

      // 规范化为 funnel 输入格式
      const candidates = allRecipes.map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content || r.code || '',
        description: r.description || '',
        language: r.language,
        category: r.category,
        trigger: r.trigger || '',
      }));

      if (candidates.length > 0) {
        const results = await funnel.execute(query, candidates, {});
        return { source: 'retrievalFunnel', results: results.slice(0, topK) };
      }
    } catch {
      /* RetrievalFunnel not available */
    }

    return {
      source: 'none',
      results: [],
      message: 'No search engine available',
      _meta: {
        confidence: 'none',
        hint: '搜索引擎不可用。请确认向量索引已构建（rebuild_index）。',
      },
    };
  },
};

// ────────────────────────────────────────────────────────────
// 6. get_related_recipes
// ────────────────────────────────────────────────────────────
export const getRelatedRecipes = {
  name: 'get_related_recipes',
  description: '通过知识图谱查询某个 Recipe 的关联 Recipe（requires/extends/enforces 等关系）。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
      relation: {
        type: 'string',
        description:
          '关系类型过滤 (requires/extends/enforces/depends_on/inherits/implements/calls/prerequisite)，不传则返回全部关系',
      },
    },
    required: ['recipeId'],
  },
  handler: async (params, ctx) => {
    const kgService = ctx.container.get('knowledgeGraphService');
    const { recipeId, relation } = params;

    if (relation) {
      const edges = kgService.getRelated(recipeId, 'recipe', relation);
      return { recipeId, relation, edges };
    }

    const edges = kgService.getEdges(recipeId, 'recipe', 'both');
    return { recipeId, ...edges };
  },
};
