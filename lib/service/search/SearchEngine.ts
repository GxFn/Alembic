/**
 * SearchEngine - 统一搜索引擎
 *
 * 三级搜索策略: keyword → BM25 ranking → semantic(可选)
 * 从 V1 SearchServiceV2 迁移，适配 V2 架构
 */

import Logger from '../../infrastructure/logging/Logger.js';
import { CoarseRanker } from './CoarseRanker.js';
import { contextBoost } from './contextBoost.js';
import { CrossEncoderReranker } from './CrossEncoderReranker.js';
import { MultiSignalRanker } from './MultiSignalRanker.js';

/**
 * BM25 参数
 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * 分词: 中英文混合分词
 * 英文: camelCase / PascalCase 拆分 + 小写化
 * 中文: 单字 + 二元组（bigram）— 无需分词词典即可支持子串匹配
 */
export function tokenize(text) {
  if (!text) {
    return [];
  }
  // 先拆 camelCase/PascalCase（必须在 toLowerCase 之前，否则大小写边界丢失）
  let expanded = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  // 拆全大写前缀：URLSession → URL Session, UITableView → UI Table View
  expanded = expanded.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const normalized = expanded.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, ' ');
  const rawTokens = normalized.split(/[\s_-]+/).filter((t) => t.length >= 1);

  const tokens = [];
  // CJK 正则（中日韩统一表意文字 + 扩展区）
  const cjkRe = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

  for (const raw of rawTokens) {
    if (cjkRe.test(raw)) {
      // 中文片段：提取所有 CJK 连续子串，生成单字 + bigram 覆盖
      const cjkChars = raw.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g) || [];
      for (const seg of cjkChars) {
        // 单字
        for (const ch of seg) {
          tokens.push(ch);
        }
        // bigram
        for (let i = 0; i < seg.length - 1; i++) {
          tokens.push(seg[i] + seg[i + 1]);
        }
        // 完整片段（≥3 字时额外保留，提升精确匹配权重）
        if (seg.length >= 3) {
          tokens.push(seg);
        }
      }
      // 非 CJK 部分（英文/数字）也保留
      const nonCjk = raw.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g, ' ').trim();
      if (nonCjk) {
        for (const t of nonCjk.split(/\s+/)) {
          if (t.length >= 2) {
            tokens.push(t);
          }
        }
      }
    } else if (raw.length >= 2) {
      tokens.push(raw);
    }
  }
  return [...new Set(tokens)];
}

/**
 * BM25 评分器
 */
export class BM25Scorer {
  _idIndex: any;
  _totalLength: any;
  avgLength: any;
  docFreq: any;
  documents: any;
  totalDocs: any;
  constructor() {
    this.documents = []; // [{id, tokens, tokenFreq, length, meta}]
    this.avgLength = 0;
    this.docFreq = {}; // token → 出现在多少文档中
    this.totalDocs = 0;
    this._totalLength = 0; // 累计文档长度，避免 O(N) 重算
    this._idIndex = new Map(); // id → array index (O(1) 查找)
  }

  /**
   * 添加文档到索引
   */
  addDocument(id, text, meta: any = {}) {
    // 如果 id 已存在，先移除旧版本（确保幂等）
    if (this._idIndex.has(id)) {
      this.removeDocument(id);
    }
    const tokens = tokenize(text);
    // 预计算 token frequency map — 避免 search 时 O(T) filter 计算 TF
    const tokenFreq: any = {};
    for (const t of tokens) {
      tokenFreq[t] = (tokenFreq[t] || 0) + 1;
    }
    const idx = this.documents.length;
    this.documents.push({ id, tokens, tokenFreq, length: tokens.length, meta });
    this._idIndex.set(id, idx);
    for (const token of new Set(tokens)) {
      this.docFreq[token] = (this.docFreq[token] || 0) + 1;
    }
    this.totalDocs = this._idIndex.size;
    this._totalLength += tokens.length;
    this.avgLength = this.totalDocs > 0 ? this._totalLength / this.totalDocs : 0;
  }

  /**
   * 移除文档（增量删除）
   * 采用标记删除 + 懒清理策略：将文档标记为 null，当空洞率 > 30% 时自动压缩
   * @returns {boolean} 是否成功移除
   */
  removeDocument(id) {
    const idx = this._idIndex.get(id);
    if (idx === undefined) return false;

    const doc = this.documents[idx];
    if (!doc) return false; // 已被标记删除

    // 递减 docFreq
    for (const token of new Set(doc.tokens) as Set<string>) {
      if (this.docFreq[token]) {
        this.docFreq[token]--;
        if (this.docFreq[token] <= 0) {
          delete this.docFreq[token];
        }
      }
    }

    this._totalLength -= doc.length;
    this.documents[idx] = null; // 标记删除（tombstone）
    this._idIndex.delete(id);
    this.totalDocs = this._idIndex.size;
    this.avgLength = this.totalDocs > 0 ? this._totalLength / this.totalDocs : 0;

    // 空洞率 > 30% 时压缩数组
    const nullCount = this.documents.length - this.totalDocs;
    if (this.documents.length > 100 && nullCount / this.documents.length > 0.3) {
      this._compact();
    }

    return true;
  }

  /**
   * 更新文档（增量: remove + add）
   */
  updateDocument(id, text, meta: any = {}) {
    this.removeDocument(id);
    this.addDocument(id, text, meta);
  }

  /**
   * 检查文档是否存在
   */
  hasDocument(id) {
    return this._idIndex.has(id);
  }

  /**
   * 压缩 documents 数组，清除 tombstone 空洞
   */
  _compact() {
    const alive = this.documents.filter((d) => d !== null);
    this.documents = alive;
    this._idIndex.clear();
    for (let i = 0; i < alive.length; i++) {
      this._idIndex.set(alive[i].id, i);
    }
  }

  /**
   * 查询文档，返回按 BM25 分数排序的结果
   */
  search(query, limit = 20) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }

    const scores = [];

    for (const doc of this.documents) {
      if (!doc) continue; // skip tombstone
      let score = 0;
      const dl = doc.length;

      for (const qt of queryTokens) {
        const tf = doc.tokenFreq[qt] || 0; // O(1) 查找，替代 O(T) filter
        if (tf === 0) {
          continue;
        }

        const df = this.docFreq[qt] || 0;
        const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1);
        const tfNorm =
          (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / this.avgLength)));
        score += idf * tfNorm;
      }

      if (score > 0) {
        scores.push({ id: doc.id, score, meta: doc.meta });
      }
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit);
  }

  /**
   * 清空索引
   */
  clear() {
    this.documents = [];
    this.docFreq = {};
    this.totalDocs = 0;
    this.avgLength = 0;
    this._totalLength = 0;
    this._idIndex.clear();
  }
}

/**
 * SearchEngine - 完整搜索服务
 * 整合 BM25 + 关键词 + 可选 AI 增强
 */
export class SearchEngine {
  _cache: any;
  _cacheMaxAge: any;
  _coarseRanker: any;
  _crossEncoder: any;
  _fusionBm25Weight: any;
  _fusionSemanticWeight: any;
  _indexed: any;
  _lastIndexTime: any;
  _multiSignalRanker: any;
  aiProvider: any;
  db: any;
  hybridRetriever: any;
  logger: any;
  scorer: any;
  vectorStore: any;
  constructor(db, options: any = {}) {
    this.db = typeof db?.getDb === 'function' ? db.getDb() : db;
    this.logger = Logger.getInstance();
    this.aiProvider = options.aiProvider || null;
    this.vectorStore = options.vectorStore || null;
    this.hybridRetriever = options.hybridRetriever || null;
    this.scorer = new BM25Scorer();
    this._coarseRanker = new CoarseRanker(options);
    this._multiSignalRanker = new MultiSignalRanker(options);
    this._crossEncoder = options.crossEncoderReranker || null;
    this._indexed = false;
    this._cache = new Map();
    this._cacheMaxAge = options.cacheMaxAge || 300_000; // 5min
    // auto 模式 BM25+semantic 融合权重（可配置）
    this._fusionBm25Weight = options.fusionBm25Weight ?? 0.6;
    this._fusionSemanticWeight = options.fusionSemanticWeight ?? 0.4;
  }

  /**
   * 构建搜索索引 - 从数据库加载所有可搜索实体
   */
  buildIndex() {
    this.scorer.clear();
    this._cache.clear();

    try {
      let entries = [];

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
    } catch (err: any) {
      this.logger.error('Failed to build search index', { error: err.message });
    }
  }

  /**
   * 确保索引已构建（幂等），supply 给需要准确 stats 的调用方
   */
  ensureIndex() {
    if (!this._indexed) {
      this.buildIndex();
    }
  }

  /**
   * 统一搜索入口
   * @param {string} query 搜索关键词
   * @param {object} options - {type, limit, mode, useAI}
   */
  async search(query, options: any = {}) {
    const { type = 'all', limit = 20, mode = 'keyword', context } = options;
    const shouldRank = options.rank ?? mode !== 'keyword';

    if (!query || !query.trim()) {
      return { items: [], total: 0, query };
    }

    // 带 sessionHistory 的上下文搜索不缓存（个性化结果）
    const hasSessionContext = context?.sessionHistory?.length > 0;
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
    let results;
    let actualMode = mode;

    switch (mode) {
      case 'auto': {
        // 缓存 BM25 结果, 避免 RRF 降级时重复计算
        let cachedBm25Items = null;
        const getBm25 = () => {
          if (!cachedBm25Items) cachedBm25Items = this._bm25Search(query, type, recallLimit);
          return cachedBm25Items;
        };

        // 如果有 HybridRetriever, 使用 RRF 融合
        if (this.hybridRetriever && this.aiProvider && this.vectorStore) {
          try {
            const queryEmbedding = await this.aiProvider.embed(query);
            if (queryEmbedding && queryEmbedding.length > 0) {
              const bm25Items = getBm25();
              const rrfResults = await this.hybridRetriever.search(query, queryEmbedding, {
                topK: recallLimit,
                alpha: this._fusionSemanticWeight,
                sparseSearchFn: () => bm25Items,
              });
              // 将 RRF 结果映射为标准格式
              results = rrfResults.map((r) => {
                const base = r.data?.item || r.data || {};
                return {
                  id: r.id,
                  title: base.title || base.metadata?.title || r.id,
                  type: base.type || 'recipe',
                  kind: base.kind || base.metadata?.kind || 'pattern',
                  status: base.status || base.metadata?.status || 'active',
                  score: Math.round(r.score * 1000) / 1000,
                  content: base.content,
                  description: base.description,
                };
              });
              this._supplementDetails(results);
              actualMode = 'auto(rrf)';
              break;
            }
          } catch {
            // RRF 失败, 降级到 min-max 融合
          }
        }

        // 降级: 同时做 BM25 + semantic，min-max 归一化后加权融合
        const [bm25Items, semResult] = await Promise.all([
          Promise.resolve(getBm25()),
          this._semanticSearch(query, type, recallLimit).catch(() => ({
            items: [],
            actualMode: 'bm25',
          })),
        ]);
        const semItems = semResult.items || [];
        const semActuallyUsed = semResult.actualMode === 'semantic';
        const merged = new Map();
        for (const it of bm25Items) {
          merged.set(it.id, { ...it, _bm25: it.score || 0, _sem: 0 });
        }
        for (const it of semItems) {
          const existing = merged.get(it.id);
          if (existing) {
            existing._sem = it.score || 0;
          } else {
            merged.set(it.id, { ...it, _bm25: 0, _sem: it.score || 0 });
          }
        }
        // Min-max 归一化 + 加权融合（分数归一到 [0,1]，避免 BM25/semantic 尺度差异）
        const allMerged = [...merged.values()];
        const maxBm25 = allMerged.reduce((m, it) => Math.max(m, it._bm25), 0) || 1;
        const maxSem = allMerged.reduce((m, it) => Math.max(m, it._sem), 0) || 1;
        for (const it of allMerged) {
          const bNorm = it._bm25 / maxBm25;
          const sNorm = it._sem / maxSem;
          it.score = semActuallyUsed
            ? this._fusionBm25Weight * bNorm + this._fusionSemanticWeight * sNorm
            : bNorm;
        }
        results = allMerged.sort((a, b) => b.score - a.score);
        for (const it of results) {
          delete it._bm25;
          delete it._sem;
        }
        actualMode = semActuallyUsed ? 'auto(bm25+semantic)' : 'auto(bm25-only)';
        break;
      }
      case 'ranking':
      case 'bm25':
        results = this._bm25Search(query, type, recallLimit);
        break;
      case 'semantic': {
        const semResult = await this._semanticSearch(query, type, recallLimit);
        results = semResult.items || semResult;
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

    const response: any = {
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
        (response.byKind[kind] || response.byKind.pattern).push(r);
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
  async _applyRanking(items, query, context: any = {}) {
    let normalized = this._normalizeForRanking(items);

    // Optional: Cross-Encoder semantic rerank (AI → Jaccard fallback)
    if (this._crossEncoder) {
      normalized = await this._crossEncoder.rerank(query, normalized);
    }

    let ranked = this._coarseRanker.rank(normalized);
    ranked = this._multiSignalRanker.rank(ranked, {
      ...context,
      query,
      scenario: context?.intent || 'search',
    });
    if (context?.sessionHistory?.length > 0) {
      ranked = contextBoost(ranked, context);
    }
    return ranked.map((r) => ({
      ...r,
      recallScore: r.bm25Score || 0,
      score: r.contextScore || r.rankerScore || r.coarseScore || r.bm25Score || 0,
    }));
  }

  /**
   * 将召回结果转换为 Ranker 所需格式（解析 content JSON、映射信号字段）
   * 保留原始 content 供下游消费者使用
   */
  _normalizeForRanking(items) {
    return items.map((item) => {
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
   */
  _keywordSearch(query, type, limit) {
    const results = [];
    // 转义 LIKE 通配符 (% → \%, _ → \_)
    const escaped = query.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;

    if (
      type === 'all' ||
      type === 'recipe' ||
      type === 'knowledge' ||
      type === 'rule' ||
      type === 'solution'
    ) {
      try {
        let rows = [];
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
        results.sort((a, b) => b.score - a.score);
      } catch {
        /* table may not exist */
      }
    }

    // 补充排序信号字段（whenClause/doClause/tags 等），与 BM25/semantic 路径一致
    this._supplementDetails(results);

    return results.slice(0, limit);
  }

  /**
   * BM25 排序搜索
   */
  _bm25Search(query, type, limit) {
    let results = this.scorer.search(query, limit * 2);

    if (type !== 'all') {
      // All types now map to 'recipe' since everything is unified
      results = results.filter((r) => {
        if (type === 'rule') {
          return r.meta.knowledgeType === 'boundary-constraint';
        }
        return r.meta.type === 'recipe';
      });
    }

    const items = results.slice(0, limit).map((r) => ({
      id: r.id,
      title: r.meta.title,
      trigger: r.meta.trigger || '',
      type: r.meta.type,
      kind: r.meta.kind || 'pattern',
      status: r.meta.status,
      language: r.meta.language || '',
      category: r.meta.category || '',
      score: Math.round(r.score * 1000) / 1000,
      // 排序信号字段（供 RetrievalFunnel / CoarseRanker / MultiSignalRanker 使用）
      updatedAt: r.meta.updatedAt || null,
      createdAt: r.meta.createdAt || null,
      difficulty: r.meta.difficulty || 'intermediate',
      tags: r.meta.tags || [],
      usageCount: r.meta.usageCount || 0,
      authorityScore: r.meta.authorityScore || 0,
      qualityScore: r.meta.qualityScore || 0,
    }));

    // 为每个结果补充 content（NativeUI 预览需要）— 批量 IN 查询替代 N+1
    this._supplementDetails(items);

    return items;
  }

  /**
   * 语义搜索 - 需要 AI Provider 的 embed 功能
   * 降级到 BM25 如果 AI 不可用
   * @returns {Promise<{ items: Array, actualMode: string }>}
   */
  async _semanticSearch(query, type, limit) {
    if (!this.aiProvider) {
      this.logger.debug('AI provider not available, falling back to BM25');
      return { items: this._bm25Search(query, type, limit), actualMode: 'bm25' };
    }

    try {
      const queryEmbedding = await this.aiProvider.embed(query);
      if (!queryEmbedding || queryEmbedding.length === 0) {
        return { items: this._bm25Search(query, type, limit), actualMode: 'bm25' };
      }

      // 尝试通过 vectorStore 做向量搜索（优先混合搜索: 向量70% + 关键词30%）
      if (this.vectorStore) {
        try {
          let vectorResults;
          if (typeof this.vectorStore.hybridSearch === 'function') {
            const hybrid = await this.vectorStore.hybridSearch(queryEmbedding, query, {
              topK: limit * 2,
            });
            vectorResults = hybrid.map((r) => ({
              id: r.item.id,
              similarity: r.score,
              score: r.score,
              content: r.item.content,
              metadata: r.item.metadata || {},
            }));
          } else {
            vectorResults = await this.vectorStore.query(queryEmbedding, limit * 2);
          }
          if (vectorResults && vectorResults.length > 0) {
            let results = vectorResults.map((vr) => ({
              id: vr.id,
              title: vr.metadata?.title || vr.id,
              type: 'recipe',
              kind: vr.metadata?.kind || 'pattern',
              status: vr.metadata?.status || 'active',
              score: Math.round((vr.similarity || vr.score || 0) * 1000) / 1000,
            }));
            if (type !== 'all') {
              results = results.filter((r) => {
                if (type === 'rule') {
                  return r.kind === 'rule';
                }
                return r.type === 'recipe';
              });
            }
            results = results.slice(0, limit);
            // 补充 content — 与 BM25 路径一致
            this._supplementDetails(results);
            return { items: results, actualMode: 'semantic' };
          }
        } catch (vecErr: any) {
          this.logger.warn('Vector store query failed, falling back to BM25', {
            error: vecErr.message,
          });
        }
      }

      // vectorStore 不可用或无结果，降级到 BM25
      this.logger.debug('Vector search fallback to BM25');
      return { items: this._bm25Search(query, type, limit), actualMode: 'bm25' };
    } catch (err: any) {
      this.logger.warn('Semantic search failed, falling back to BM25', { error: err.message });
      return { items: this._bm25Search(query, type, limit), actualMode: 'bm25' };
    }
  }

  /**
   * 补充详细字段（content / description / trigger / delivery 字段）— 批量 IN 查询
   * 用于向量搜索结果与 BM25 结果的一致性
   */
  _supplementDetails(items) {
    if (!items || items.length === 0) {
      return;
    }
    try {
      const ids = items.map((it) => it.id);
      const placeholders = ids.map(() => '?').join(',');
      let rows = [];
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
          item.content = item.content || row.content || null;
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
   * @param {{ force?: boolean }} [opts] - force=true 强制全量重建
   */
  refreshIndex(opts: any = {}) {
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
    } catch (err: any) {
      // 增量失败 → 降级全量重建
      this.logger.warn('Incremental refresh failed, falling back to full rebuild', {
        error: err.message,
      });
      this._indexed = false;
      this.buildIndex();
    }
  }

  /**
   * 从 DB 行构建索引文本
   * @private
   */
  _buildDocText(r) {
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
    return [
      r.title,
      r.description,
      r.trigger,
      r.language,
      r.category,
      r.knowledgeType,
      tagText,
      contentText,
    ]
      .filter(Boolean)
      .join(' ');
  }

  /**
   * 从 DB 行构建文档 meta
   * @private
   */
  _buildDocMeta(r) {
    let parsedTags = [];
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

  /**
   * 获取索引统计（如果尚未构建索引，自动触发构建）
   */
  getStats() {
    return {
      indexed: this._indexed,
      totalDocuments: this.scorer.totalDocs,
      avgDocLength: Math.round(this.scorer.avgLength * 10) / 10,
      cacheSize: this._cache.size,
      uniqueTokens: Object.keys(this.scorer.docFreq).length,
      hasVectorStore: !!this.vectorStore,
      hasAiProvider: !!this.aiProvider,
    };
  }

  _getCache(key) {
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

  _setCache(key, data) {
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
