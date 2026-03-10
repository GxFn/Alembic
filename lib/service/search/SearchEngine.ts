/**
 * SearchEngine - 统一搜索引擎
 *
 * 三级搜索策略: keyword → BM25 ranking → semantic(可选)
 * 从 V1 SearchServiceV2 迁移，适配 V2 架构
 */

import Logger from '../../infrastructure/logging/Logger.js';
import { BM25Scorer } from './BM25Scorer.js';
import { CoarseRanker } from './CoarseRanker.js';
import type { SearchItem } from './contextBoost.js';
import { contextBoost } from './contextBoost.js';
import { MultiSignalRanker } from './MultiSignalRanker.js';
import type {
  BM25DocMeta,
  BM25SearchResult,
  DbRow,
  RankingContext,
  SearchAiProvider,
  SearchCrossEncoder,
  SearchDb,
  SearchEngineOptions,
  SearchHybridRetriever,
  SearchOptions,
  SearchResponse,
  SearchResultItem,
  SearchVectorService,
  SearchVectorStore,
  VectorHit,
} from './SearchTypes.js';

// ── Re-exports for backward compatibility ──
export { BM25Scorer } from './BM25Scorer.js';
export type {
  BM25DocMeta,
  BM25SearchResult,
  DbRow,
  RankingContext,
  RrfHit,
  SearchAiProvider,
  SearchCrossEncoder,
  SearchDb,
  SearchEngineOptions,
  SearchHybridRetriever,
  SearchOptions,
  SearchResponse,
  SearchResultItem,
  SearchVectorService,
  SearchVectorStore,
  SlimSearchResult,
  VectorHit,
} from './SearchTypes.js';
export { groupByKind, slimSearchResult } from './SearchTypes.js';
export { tokenize } from './tokenizer.js';

/**
 * SearchEngine - 完整搜索服务
 * 整合 BM25 + 关键词 + 可选 AI 增强
 */
export class SearchEngine {
  _cache: Map<string, { data: SearchResponse; time: number }>;
  _cacheMaxAge: number;
  _coarseRanker: CoarseRanker;
  _crossEncoder: SearchCrossEncoder | null;
  _fusionBm25Weight: number;
  _fusionSemanticWeight: number;
  _indexed: boolean;
  _lastIndexTime: string | null = null;
  _multiSignalRanker: MultiSignalRanker;
  aiProvider: SearchAiProvider | null;
  db: SearchDb;
  hybridRetriever: SearchHybridRetriever | null;
  logger: ReturnType<typeof Logger.getInstance>;
  scorer: BM25Scorer;
  vectorService: SearchVectorService | null;
  vectorStore: SearchVectorStore | null;
  constructor(db: SearchDb & { getDb?: () => SearchDb }, options: SearchEngineOptions = {}) {
    this.db = (typeof db?.getDb === 'function' ? db.getDb() : db) as SearchDb;
    this.logger = Logger.getInstance();
    this.aiProvider = options.aiProvider || null;
    this.vectorStore = options.vectorStore || null;
    this.vectorService = options.vectorService || null;
    this.hybridRetriever = options.hybridRetriever || null;
    this.scorer = new BM25Scorer();
    this._coarseRanker = new CoarseRanker(
      options as {
        bm25Weight?: number;
        semanticWeight?: number;
        qualityWeight?: number;
        freshnessWeight?: number;
        popularityWeight?: number;
      }
    );
    this._multiSignalRanker = new MultiSignalRanker(
      options as { scenarioWeights?: Record<string, Record<string, number>> }
    );
    this._crossEncoder = options.crossEncoderReranker || null;
    this._indexed = false;
    this._cache = new Map();
    this._cacheMaxAge = options.cacheMaxAge || 300_000; // 5min
    // auto 模式 BM25+semantic 融合权重（可配置）
    this._fusionBm25Weight = options.fusionBm25Weight ?? 0.6;
    this._fusionSemanticWeight = options.fusionSemanticWeight ?? 0.4;
  }

  /** 构建搜索索引 - 从数据库加载所有可搜索实体 */
  buildIndex() {
    this.scorer.clear();
    this._cache.clear();

    try {
      let entries: DbRow[] = [];

      try {
        entries = this.db
          .prepare(
            `SELECT id, title, description, language, category, knowledgeType, kind,
                  content, lifecycle, tags, trigger, difficulty, quality, stats,
                  updatedAt, createdAt
           FROM knowledge_entries WHERE lifecycle != 'deprecated'`
          )
          .all();
        entries = entries.map((e) => ({
          ...e,
          status: e.lifecycle,
        }));
      } catch {
        /* table may not exist */
      }

      for (const r of entries) {
        const text = this._buildDocText(r);
        const meta = this._buildDocMeta(r);
        meta.status = r.status; // buildIndex uses mapped status from lifecycle
        this.scorer.addDocument(r.id, text, meta);
      }

      this._indexed = true;
      this._lastIndexTime = new Date().toISOString();
      this.logger.info('Search index built', {
        entries: entries.length,
        total: this.scorer.totalDocs,
      });
    } catch (err: unknown) {
      this.logger.error('Failed to build search index', { error: (err as Error).message });
    }
  }

  /** 确保索引已构建（幂等），supply 给需要准确 stats 的调用方 */
  ensureIndex() {
    if (!this._indexed) {
      this.buildIndex();
    }
  }

  /**
   * 统一搜索入口
   * @param query 搜索关键词
   * @param options {type, limit, mode, useAI}
   */
  async search(query: string, options: SearchOptions = {}) {
    const { type = 'all', limit = 20, mode = 'keyword', context } = options;
    const shouldRank = options.rank ?? mode !== 'keyword';

    if (!query || !query.trim()) {
      return { items: [], total: 0, query };
    }

    // 带 sessionHistory 的上下文搜索不缓存（个性化结果）
    const hasSessionContext = (context?.sessionHistory?.length ?? 0) > 0;
    const cacheKey = hasSessionContext
      ? null
      : `${query}:${type}:${limit}:${mode}:${shouldRank ? 'r' : ''}:${options.groupByKind ? 'g' : ''}`;
    if (cacheKey) {
      const cached = this._getCache(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // 确保索引已构建
    this.ensureIndex();

    // 排序阶段需要更多候选，过采样 3x
    const recallLimit = shouldRank ? limit * 3 : limit;
    let results: SearchResultItem[];
    let actualMode = mode;

    switch (mode) {
      case 'auto': {
        // 缓存 BM25 结果, 避免 RRF 降级时重复计算
        let cachedBm25Items: SearchResultItem[] | null = null;
        const getBm25 = () => {
          if (!cachedBm25Items) {
            cachedBm25Items = this._bm25Search(query, type, recallLimit);
          }
          return cachedBm25Items;
        };

        // 优先使用 VectorService 的 hybridSearch (统一 RRF 融合)
        if (this.vectorService) {
          try {
            const bm25Items = getBm25();
            const rrfResults = await this.vectorService.hybridSearch(query, {
              topK: recallLimit,
              alpha: this._fusionSemanticWeight,
              sparseSearchFn: () => bm25Items!,
            });
            if (rrfResults.length > 0) {
              results = rrfResults.map((r) => {
                const base =
                  ((r as Record<string, unknown>).data as Record<string, unknown>)?.item ||
                  (r as Record<string, unknown>).data ||
                  {};
                const baseMeta = ((base as Record<string, unknown>).metadata || {}) as Record<
                  string,
                  unknown
                >;
                return {
                  id: r.id,
                  title: ((base as Record<string, unknown>).title ||
                    baseMeta.title ||
                    r.id) as string,
                  type: ((base as Record<string, unknown>).type || 'recipe') as string,
                  kind: ((base as Record<string, unknown>).kind ||
                    baseMeta.kind ||
                    'pattern') as string,
                  status: ((base as Record<string, unknown>).status ||
                    baseMeta.status ||
                    'active') as string,
                  score: Math.round(r.score * 1000) / 1000,
                  content: (base as Record<string, unknown>).content as string | undefined,
                  description: (base as Record<string, unknown>).description as string | undefined,
                } as SearchResultItem;
              });
              this._supplementDetails(results as SearchResultItem[]);
              actualMode = 'auto(rrf)';
              break;
            }
          } catch {
            // VectorService RRF 失败, 降级到 min-max 融合
          }
        }

        // 降级: VectorService 不可用或 RRF 零结果 → 纯 BM25
        // 旧版在此做 BM25+semantic min-max 融合，但当 VectorService 不可用时
        // semantic 通常也会失败，最终退化为纯 BM25。简化为直接走 BM25。
        results = getBm25();
        actualMode = 'auto(bm25-only)';
        break;
      }
      case 'bm25':
        results = this._bm25Search(query, type, recallLimit);
        break;
      case 'semantic': {
        const semResult = await this._semanticSearch(query, type, recallLimit);
        results = semResult.items;
        actualMode = semResult.actualMode || 'semantic';
        break;
      }
      default:
        results = this._keywordSearch(query, type, limit);
        break;
    }

    // ── Ranking Pipeline ([CrossEncoder] → CoarseRanker → MultiSignalRanker → ContextBoost) ──
    if (shouldRank && results.length > 0) {
      results = await this._applyRanking(results, query, context);
    }
    results = results.slice(0, limit);

    const response: SearchResponse = {
      items: results,
      total: results.length,
      query,
      mode: actualMode,
      type,
      ranked: shouldRank && results.length > 0,
    };

    if (options.groupByKind) {
      response.byKind = { rule: [], pattern: [], fact: [] };
      for (const r of results) {
        const kind = r.kind || 'pattern';
        (response.byKind![kind] || response.byKind!.pattern).push(r);
      }
    }

    if (cacheKey) {
      this._setCache(cacheKey, response);
    }
    return response;
  }

  // ── Ranking Pipeline ────────────────────────────────────────────

  /**
   * 统一排序管线:
   *   规范化 → [CrossEncoder 语义重排] → CoarseRanker (E-E-A-T 5维)
   *   → MultiSignalRanker (6信号) → 上下文加成
   *
   * CrossEncoder 仅在构造时传入 crossEncoderReranker 且 AI 可用时生效，
   * 否则自动跳过（零额外开销）。
   */
  async _applyRanking(items: SearchResultItem[], query: string, context: RankingContext = {}) {
    let normalized = this._normalizeForRanking(items);

    // Optional: Cross-Encoder semantic rerank (AI → Jaccard fallback)
    if (this._crossEncoder) {
      normalized = (await this._crossEncoder.rerank(query, normalized)) as SearchResultItem[];
    }

    let ranked: SearchResultItem[] = this._coarseRanker.rank(
      normalized as unknown as Parameters<CoarseRanker['rank']>[0]
    ) as unknown as SearchResultItem[];
    ranked = this._multiSignalRanker.rank(
      ranked as unknown as Parameters<MultiSignalRanker['rank']>[0],
      {
        ...context,
        query,
        scenario: context?.intent || 'search',
      }
    ) as unknown as SearchResultItem[];
    if ((context?.sessionHistory?.length ?? 0) > 0) {
      ranked = contextBoost(ranked as SearchItem[], context) as SearchResultItem[];
    }
    return ranked.map((r: SearchResultItem) => ({
      ...r,
      recallScore: r.bm25Score || 0,
      score: r.contextScore || r.rankerScore || r.coarseScore || r.bm25Score || 0,
    }));
  }

  /**
   * 将召回结果转换为 Ranker 所需格式（解析 content JSON、映射信号字段）
   * 保留原始 content 供下游消费者使用
   */
  _normalizeForRanking(items: SearchResultItem[]): SearchResultItem[] {
    return items.map((item: SearchResultItem) => {
      let codeText = '';
      if (item.content) {
        try {
          const parsed = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
          codeText = parsed.pattern || parsed.code || '';
        } catch {
          /* ignore */
        }
      }
      let tags = item.tags || [];
      if (typeof tags === 'string') {
        try {
          tags = JSON.parse(tags);
        } catch {
          tags = [];
        }
      }
      return {
        ...item,
        code: codeText || item.code || '',
        bm25Score: item.score || 0,
        qualityScore: item.qualityScore || (item.status === 'active' ? 70 : 40),
        usageCount: item.usageCount || 0,
        authorityScore: item.authorityScore || 0,
        tags,
        difficulty: item.difficulty || 'intermediate',
      };
    });
  }

  /**
   * 关键词搜索 - 直接 SQL LIKE
   * 返回包含 kind 字段的完整结果，使用 ESCAPE 防止通配符注入
   * 当 SQL LIKE 无结果时，降级到 BM25 搜索以提升自然语言查询的召回率
   */
  _keywordSearch(query: string, type: string, limit: number) {
    const results: SearchResultItem[] = [];
    // 转义 LIKE 通配符 (% → \%, _ → \_)
    const escaped = query.replace(/[%_\\]/g, (ch: string) => `\\${ch}`);
    const pattern = `%${escaped}%`;

    if (
      type === 'all' ||
      type === 'recipe' ||
      type === 'knowledge' ||
      type === 'rule' ||
      type === 'solution'
    ) {
      try {
        let rows: DbRow[] = [];
        try {
          rows = this.db
            .prepare(
              `SELECT id, title, description, language, category, knowledgeType, kind, lifecycle as status, content, trigger, headers, moduleName, 'knowledge' as type
             FROM knowledge_entries
             WHERE lifecycle != 'deprecated' AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR trigger LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
             LIMIT ?`
            )
            .all(pattern, pattern, pattern, pattern, limit);
        } catch {
          /* table may not exist */
        }
        // 基础相关性排序：trigger 精确 > 标题匹配 > 描述匹配 > 内容匹配
        const lowerQ = query.toLowerCase();
        results.push(
          ...rows.map((r) => {
            let score = 0.5;
            if (r.trigger?.toLowerCase().includes(lowerQ)) {
              score = 1.2;
            } else if (r.title?.toLowerCase().includes(lowerQ)) {
              score = 1.0;
            } else if (r.description?.toLowerCase().includes(lowerQ)) {
              score = 0.8;
            }
            return {
              ...r,
              trigger: r.trigger || '',
              kind: r.kind || 'pattern',
              score: Math.round(score * 1000) / 1000,
            };
          })
        );
        results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      } catch {
        /* table may not exist */
      }
    }

    // 补充排序信号字段（whenClause/doClause/tags 等），与 BM25/semantic 路径一致
    this._supplementDetails(results);

    // 当 SQL LIKE 无结果时，降级到 BM25 搜索
    // 这让自然语言查询（如 "如何处理网络错误"）在 keyword 模式下也能返回结果
    if (results.length === 0) {
      this.ensureIndex();
      const bm25Results = this._bm25Search(query, type, limit);
      return bm25Results;
    }

    return results.slice(0, limit);
  }

  /**
   * BM25 排序搜索
   * 增加 Title/Trigger 精确匹配 bonus — 当 query 出现在标题/触发词中时
   * 给予额外 BM25 分数加成，确保精确匹配的条目排名靠前
   */
  _bm25Search(query: string, type: string, limit: number) {
    let results = this.scorer.search(query, limit * 2);

    if (type !== 'all') {
      // All types now map to 'recipe' since everything is unified
      results = results.filter((r: BM25SearchResult) => {
        if (type === 'rule') {
          return (r.meta as Record<string, unknown>).knowledgeType === 'boundary-constraint';
        }
        return (r.meta as Record<string, unknown>).type === 'recipe';
      });
    }

    // ── Title/Trigger exact-match bonus ──
    // 当 query 精确出现在标题或触发词中时，增加 BM25 分数
    // 这解决了 "BaseRequest" 被 "BD前缀类名命名规范" 排在 "BDBaseRequest 继承请求模式" 前面的问题
    const lowerQuery = query.toLowerCase();
    const maxScore = results.length > 0 ? results[0].score : 1;
    for (const r of results) {
      const meta = r.meta as BM25DocMeta;
      const title = (meta.title || '').toLowerCase();
      const trigger = (meta.trigger || '').toLowerCase();
      let bonus = 0;

      if (title === lowerQuery || trigger === lowerQuery) {
        // 完全匹配: +50% of max score
        bonus = maxScore * 0.5;
      } else if (title.includes(lowerQuery) || trigger.includes(lowerQuery)) {
        // 子串匹配: +30% of max score
        bonus = maxScore * 0.3;
      } else if (lowerQuery.includes(title) && title.length > 3) {
        // 反向包含 (query 包含 title): +15% of max score
        bonus = maxScore * 0.15;
      }
      r.score += bonus;
    }
    // 重新排序
    results.sort((a, b) => b.score - a.score);

    const items: SearchResultItem[] = results.slice(0, limit).map((r: BM25SearchResult) => {
      const meta = r.meta as BM25DocMeta;
      return {
        id: r.id,
        title: meta.title,
        trigger: meta.trigger || '',
        type: meta.type,
        kind: meta.kind || 'pattern',
        status: meta.status,
        language: meta.language || '',
        category: meta.category || '',
        score: Math.round(r.score * 1000) / 1000,
        // 排序信号字段（供 CoarseRanker / MultiSignalRanker 使用）
        updatedAt: meta.updatedAt || null,
        createdAt: meta.createdAt || null,
        difficulty: meta.difficulty || 'intermediate',
        tags: meta.tags || [],
        usageCount: meta.usageCount || 0,
        authorityScore: meta.authorityScore || 0,
        qualityScore: meta.qualityScore || 0,
      };
    });

    // 为每个结果补充 content（NativeUI 预览需要）— 批量 IN 查询替代 N+1
    this._supplementDetails(items);

    return items;
  }

  /**
   * 语义搜索 - 需要 AI Provider 的 embed 功能
   * 降级到 BM25 如果 AI 不可用
   * @returns >}
   */
  async _semanticSearch(query: string, type: string, limit: number) {
    // 优先使用 VectorService (统一向量服务层)
    if (this.vectorService) {
      try {
        const vectorResults = await this.vectorService.search(query, { topK: limit * 2 });
        if (vectorResults.length > 0) {
          let results: SearchResultItem[] = vectorResults.map((vr) => {
            const item = vr.item as Record<string, unknown>;
            const metadata = (item.metadata || {}) as Record<string, unknown>;
            return {
              id: (item.id as string) || (metadata.entryId as string) || '',
              title: (metadata.title as string) || (item.id as string) || '',
              type: 'recipe',
              kind: (metadata.kind as string) || 'pattern',
              status: (metadata.status as string) || 'active',
              score: Math.round(vr.score * 1000) / 1000,
            } as SearchResultItem;
          });
          if (type !== 'all') {
            results = results.filter((r: SearchResultItem) => {
              if (type === 'rule') {
                return r.kind === 'rule';
              }
              return r.type === 'recipe';
            });
          }
          results = results.slice(0, limit);
          this._supplementDetails(results);
          return { items: results, actualMode: 'semantic' };
        }
      } catch (err: unknown) {
        this.logger.warn('VectorService search failed, falling back to legacy path', {
          error: (err as Error).message,
        });
      }
    }

    // Legacy fallback: 直接使用 aiProvider embed + vectorStore
    if (!this.aiProvider) {
      this.logger.debug('AI provider not available, falling back to BM25');
      return { items: this._bm25Search(query, type, limit), actualMode: 'bm25' };
    }

    try {
      const queryEmbedding = await this.aiProvider.embed(query);
      if (!queryEmbedding || queryEmbedding.length === 0) {
        return { items: this._bm25Search(query, type, limit), actualMode: 'bm25' };
      }

      if (this.vectorStore) {
        try {
          let vectorResults: VectorHit[];
          if (typeof this.vectorStore.hybridSearch === 'function') {
            const hybrid = await this.vectorStore.hybridSearch(queryEmbedding, query, {
              topK: limit * 2,
            });
            vectorResults = hybrid.map((r: VectorHit) => ({
              id: r.item?.id ?? r.id,
              similarity: r.score,
              score: r.score,
              content: r.item?.content,
              metadata: r.item?.metadata || {},
            }));
          } else {
            vectorResults = await this.vectorStore.query(queryEmbedding, limit * 2);
          }
          if (vectorResults && vectorResults.length > 0) {
            let results: SearchResultItem[] = vectorResults.map(
              (vr: VectorHit) =>
                ({
                  id: vr.id,
                  title: (vr.metadata?.title as string) || vr.id,
                  type: 'recipe',
                  kind: (vr.metadata?.kind as string) || 'pattern',
                  status: (vr.metadata?.status as string) || 'active',
                  score: Math.round((vr.similarity || vr.score || 0) * 1000) / 1000,
                }) as SearchResultItem
            );
            if (type !== 'all') {
              results = results.filter((r: SearchResultItem) => {
                if (type === 'rule') {
                  return r.kind === 'rule';
                }
                return r.type === 'recipe';
              });
            }
            results = results.slice(0, limit);
            this._supplementDetails(results);
            return { items: results, actualMode: 'semantic' };
          }
        } catch (vecErr: unknown) {
          this.logger.warn('Vector store query failed, falling back to BM25', {
            error: (vecErr as Error).message,
          });
        }
      }

      this.logger.debug('Vector search fallback to BM25');
      return { items: this._bm25Search(query, type, limit), actualMode: 'bm25' };
    } catch (err: unknown) {
      this.logger.warn('Semantic search failed, falling back to BM25', {
        error: (err as Error).message,
      });
      return { items: this._bm25Search(query, type, limit), actualMode: 'bm25' };
    }
  }

  /**
   * 补充详细字段（content / description / trigger / delivery 字段）— 批量 IN 查询
   * 用于向量搜索结果与 BM25 结果的一致性
   */
  _supplementDetails(items: SearchResultItem[]) {
    if (!items || items.length === 0) {
      return;
    }
    try {
      const ids = items.map((it: SearchResultItem) => it.id);
      const placeholders = ids.map(() => '?').join(',');
      let rows: DbRow[] = [];
      try {
        rows = this.db
          .prepare(
            `SELECT id, content, description, trigger, headers, moduleName,
                  tags, language, category, updatedAt, createdAt, quality, stats, difficulty,
                  whenClause, doClause
           FROM knowledge_entries WHERE id IN (${placeholders})`
          )
          .all(...ids);
      } catch {
        /* table may not exist */
      }
      const rowMap = new Map(rows.map((r) => [r.id, r]));
      for (const item of items) {
        const row = rowMap.get(item.id);
        if (row) {
          item.content = item.content || row.content || undefined;
          item.description = item.description || row.description || '';
          item.trigger = item.trigger || row.trigger || '';
          if (row.headers) {
            item.headers = row.headers;
          }
          if (row.moduleName) {
            item.moduleName = row.moduleName;
          }
          // Cursor 交付字段 — 供 Agent 投影生成 actionHint
          if (!item.whenClause && row.whenClause) {
            item.whenClause = row.whenClause;
          }
          if (!item.doClause && row.doClause) {
            item.doClause = row.doClause;
          }
          // 排序信号补充 — 确保 Funnel/Ranker 有真实数据
          if (!item.language && row.language) {
            item.language = row.language;
          }
          if (!item.category && row.category) {
            item.category = row.category;
          }
          if (!item.updatedAt && row.updatedAt) {
            item.updatedAt = row.updatedAt;
          }
          if (!item.createdAt && row.createdAt) {
            item.createdAt = row.createdAt;
          }
          if (!item.difficulty && row.difficulty) {
            item.difficulty = row.difficulty;
          }
          // 解析 tags
          if (!item.tags || (Array.isArray(item.tags) && item.tags.length === 0)) {
            try {
              item.tags = JSON.parse(row.tags || '[]');
            } catch {
              /* ignore */
            }
          }
          // 解析 quality JSON → qualityScore
          if (!item.qualityScore) {
            try {
              item.qualityScore = JSON.parse(row.quality || '{}').overall || 0;
            } catch {
              /* ignore */
            }
          }
          // 解析 stats JSON → usageCount + authorityScore
          if (!item.usageCount) {
            try {
              const stats = JSON.parse(row.stats || '{}');
              item.usageCount =
                (stats.adoptions || 0) + (stats.applications || 0) + (stats.searchHits || 0);
              if (!item.authorityScore) {
                item.authorityScore = stats.authority || 0;
              }
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch {
      /* DB may not be available */
    }
  }

  /**
   * 刷新索引（增量模式）
   *
   * 策略:
   *  1. 如果尚未构建索引 → 全量 buildIndex()
   *  2. 否则只加载 updatedAt > lastIndexTime 的条目 + 已删除(deprecated)条目
   *     - 新增/更新 → scorer.updateDocument()
   *     - 已删除    → scorer.removeDocument()
   *  3. 清空缓存以确保搜索结果刷新
   *
   * @param [opts] - force=true 强制全量重建
   */
  refreshIndex(opts: { force?: boolean } = {}) {
    if (opts.force || !this._indexed || !this._lastIndexTime) {
      this._indexed = false;
      this.buildIndex();
      return;
    }

    this._cache.clear();

    try {
      // 查找自上次索引后更新的条目
      const changed = this.db
        .prepare(
          `SELECT id, title, description, language, category, knowledgeType, kind,
                  content, lifecycle, tags, trigger, difficulty, quality, stats,
                  updatedAt, createdAt
           FROM knowledge_entries WHERE updatedAt > ?`
        )
        .all(this._lastIndexTime);

      let added = 0;
      let removed = 0;

      for (const r of changed) {
        if (r.lifecycle === 'deprecated') {
          // 已废弃 → 从索引中移除
          if (this.scorer.removeDocument(r.id)) {
            removed++;
          }
          continue;
        }

        // 解析文档文本（复用 buildIndex 逻辑）
        const text = this._buildDocText(r);
        const meta = this._buildDocMeta(r);
        this.scorer.updateDocument(r.id, text, meta);
        added++;
      }

      this._lastIndexTime = new Date().toISOString();
      if (added > 0 || removed > 0) {
        this.logger.info('Search index refreshed (incremental)', { added, removed });
      }
    } catch (err: unknown) {
      // 增量失败 → 降级全量重建
      this.logger.warn('Incremental refresh failed, falling back to full rebuild', {
        error: (err as Error).message,
      });
      this._indexed = false;
      this.buildIndex();
    }
  }

  /**
   * 从 DB 行构建索引文本
   *
   * 使用 BM25F 思想：高价值字段（title, trigger）重复出现以提升 TF 权重
   * — title ×3, trigger ×2, description ×1.5（通过重复 token 实现）
   * 这确保标题匹配的文档获得显著更高的 BM25 分数
   */
  _buildDocText(r: DbRow) {
    let contentText = '';
    try {
      const content = JSON.parse(r.content || '{}');
      contentText = [content.pattern, content.rationale, content.markdown]
        .filter(Boolean)
        .join(' ');
    } catch {
      /* ignore */
    }
    let tagText = '';
    try {
      tagText = JSON.parse(r.tags || '[]').join(' ');
    } catch {
      /* ignore */
    }
    // BM25F field boosting via token repetition:
    // title ×2, trigger ×2, description ×1, others ×1
    // 使用较温和的 boost 避免长文档 avgLength 膨胀导致 content 匹配被过度稀释
    const title = r.title || '';
    const trigger = r.trigger || '';
    const desc = r.description || '';
    const fields = [
      title,
      title, // ×2 boost
      trigger,
      trigger, // ×2 boost
      desc, // ×1 (no boost — description already contributes naturally)
      r.language,
      r.category,
      r.knowledgeType,
      tagText,
      contentText,
    ];
    return fields.filter(Boolean).join(' ');
  }

  /**
   * 从 DB 行构建文档 meta
   */
  _buildDocMeta(r: DbRow) {
    let parsedTags: string[] = [];
    try {
      parsedTags = JSON.parse(r.tags || '[]');
    } catch {
      /* ignore */
    }
    let usageCount = 0;
    let authorityScore = 0;
    try {
      const stats = JSON.parse(r.stats || '{}');
      usageCount = (stats.adoptions || 0) + (stats.applications || 0) + (stats.searchHits || 0);
      authorityScore = stats.authority || 0;
    } catch {
      /* ignore */
    }
    let qualityOverall = 0;
    try {
      qualityOverall = JSON.parse(r.quality || '{}').overall || 0;
    } catch {
      /* ignore */
    }
    return {
      type: 'knowledge',
      title: r.title,
      trigger: r.trigger || '',
      status: r.lifecycle,
      knowledgeType: r.knowledgeType,
      kind: r.kind || 'pattern',
      language: r.language || '',
      category: r.category || '',
      updatedAt: r.updatedAt || null,
      createdAt: r.createdAt || null,
      difficulty: r.difficulty || 'intermediate',
      tags: parsedTags,
      usageCount,
      authorityScore,
      qualityScore: qualityOverall,
    };
  }

  /** 获取索引统计（如果尚未构建索引，自动触发构建） */
  getStats() {
    return {
      indexed: this._indexed,
      totalDocuments: this.scorer.totalDocs,
      avgDocLength: Math.round(this.scorer.avgLength * 10) / 10,
      cacheSize: this._cache.size,
      uniqueTokens: Object.keys(this.scorer.docFreq).length,
      hasVectorStore: !!this.vectorStore,
      hasVectorService: !!this.vectorService,
      hasAiProvider: !!this.aiProvider,
    };
  }

  _getCache(key: string) {
    const entry = this._cache.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.time > this._cacheMaxAge) {
      this._cache.delete(key);
      return null;
    }
    // LRU: 重新插入以更新 Map 迭代顺序，使热点 key 不被淘汰
    this._cache.delete(key);
    this._cache.set(key, entry);
    return entry.data;
  }

  _setCache(key: string, data: SearchResponse) {
    // LRU：超限时批量淘汰最旧的 20%
    if (this._cache.size > 500) {
      const toDelete = Math.floor(this._cache.size * 0.2);
      const keys = this._cache.keys();
      for (let i = 0; i < toDelete; i++) {
        const k = keys.next().value;
        if (k !== undefined) {
          this._cache.delete(k);
        }
      }
    }
    this._cache.set(key, { data, time: Date.now() });
  }
}

export default SearchEngine;
