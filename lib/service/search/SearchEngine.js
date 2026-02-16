/**
 * SearchEngine - 统一搜索引擎
 * 
 * 三级搜索策略: keyword → BM25 ranking → semantic(可选)
 * 从 V1 SearchServiceV2 迁移，适配 V2 架构
 */

import Logger from '../../infrastructure/logging/Logger.js';

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
  if (!text) return [];
  // 先拆 camelCase/PascalCase（必须在 toLowerCase 之前，否则大小写边界丢失）
  let expanded = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  // 拆全大写前缀：URLSession → URL Session, UITableView → UI Table View
  expanded = expanded.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const normalized = expanded.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, ' ');
  const rawTokens = normalized.split(/[\s_-]+/).filter(t => t.length >= 1);

  const tokens = [];
  // CJK 正则（中日韩统一表意文字 + 扩展区）
  const cjkRe = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

  for (const raw of rawTokens) {
    if (cjkRe.test(raw)) {
      // 中文片段：提取所有 CJK 连续子串，生成单字 + bigram 覆盖
      const cjkChars = raw.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g) || [];
      for (const seg of cjkChars) {
        // 单字
        for (const ch of seg) tokens.push(ch);
        // bigram
        for (let i = 0; i < seg.length - 1; i++) tokens.push(seg[i] + seg[i + 1]);
        // 完整片段（≥3 字时额外保留，提升精确匹配权重）
        if (seg.length >= 3) tokens.push(seg);
      }
      // 非 CJK 部分（英文/数字）也保留
      const nonCjk = raw.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g, ' ').trim();
      if (nonCjk) {
        for (const t of nonCjk.split(/\s+/)) {
          if (t.length >= 2) tokens.push(t);
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
  constructor() {
    this.documents = [];   // [{id, tokens, tokenFreq, length, meta}]
    this.avgLength = 0;
    this.docFreq = {};     // token → 出现在多少文档中
    this.totalDocs = 0;
    this._totalLength = 0; // 累计文档长度，避免 O(N) 重算
  }

  /**
   * 添加文档到索引
   */
  addDocument(id, text, meta = {}) {
    const tokens = tokenize(text);
    // 预计算 token frequency map — 避免 search 时 O(T) filter 计算 TF
    const tokenFreq = {};
    for (const t of tokens) {
      tokenFreq[t] = (tokenFreq[t] || 0) + 1;
    }
    this.documents.push({ id, tokens, tokenFreq, length: tokens.length, meta });
    for (const token of new Set(tokens)) {
      this.docFreq[token] = (this.docFreq[token] || 0) + 1;
    }
    this.totalDocs = this.documents.length;
    this._totalLength += tokens.length;
    this.avgLength = this._totalLength / this.totalDocs;
  }

  /**
   * 查询文档，返回按 BM25 分数排序的结果
   */
  search(query, limit = 20) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scores = [];

    for (const doc of this.documents) {
      let score = 0;
      const dl = doc.length;

      for (const qt of queryTokens) {
        const tf = doc.tokenFreq[qt] || 0;   // O(1) 查找，替代 O(T) filter
        if (tf === 0) continue;

        const df = this.docFreq[qt] || 0;
        const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1);
        const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / this.avgLength)));
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
  }
}

/**
 * SearchEngine - 完整搜索服务
 * 整合 BM25 + 关键词 + 可选 AI 增强
 */
export class SearchEngine {
  constructor(db, options = {}) {
    this.db = typeof db?.getDb === 'function' ? db.getDb() : db;
    this.logger = Logger.getInstance();
    this.aiProvider = options.aiProvider || null;
    this.vectorStore = options.vectorStore || null;
    this.scorer = new BM25Scorer();
    this._indexed = false;
    this._cache = new Map();
    this._cacheMaxAge = options.cacheMaxAge || 300_000; // 5min
  }

  /**
   * 构建搜索索引 - 从数据库加载所有可搜索实体
   */
  buildIndex() {
    this.scorer.clear();
    this._cache.clear();

    try {
      let entries = [];

      // V3: 优先从 knowledge_entries 表索引
      try {
        entries = this.db.prepare(
          `SELECT id, title, description, language, category, knowledge_type, kind,
                  content AS content_json, lifecycle, tags AS tags_json, trigger_key
           FROM knowledge_entries WHERE lifecycle != 'deprecated'`
        ).all();
        // 标准化字段名以便后续处理
        entries = entries.map(e => ({
          ...e,
          trigger: e.trigger_key,
          status: e.lifecycle,
        }));
      } catch {
        // V3 表不存在，回退到 V2 recipes 表
        try {
          entries = this.db.prepare(
            `SELECT id, title, description, language, category, knowledge_type, kind,
                    content_json, status, tags_json, "trigger"
             FROM recipes WHERE status != 'deprecated'`
          ).all();
        } catch { /* neither table exists */ }
      }

      for (const r of entries) {
        let contentText = '';
        try {
          const content = JSON.parse(r.content_json || '{}');
          contentText = [content.pattern, content.rationale, content.markdown].filter(Boolean).join(' ');
        } catch { /* ignore parse error */ }
        // 包含 tags + trigger 提升召回率
        let tagText = '';
        try { tagText = JSON.parse(r.tags_json || '[]').join(' '); } catch { /* ignore */ }
        const text = [r.title, r.description, r.trigger, r.language, r.category, r.knowledge_type, tagText, contentText]
          .filter(Boolean).join(' ');
        this.scorer.addDocument(r.id, text, { type: 'knowledge', title: r.title, trigger: r.trigger || '', status: r.status, knowledgeType: r.knowledge_type, kind: r.kind || 'pattern', language: r.language || '', category: r.category || '' });
      }

      this._indexed = true;
      this.logger.info('Search index built', {
        entries: entries.length,
        total: this.scorer.totalDocs,
      });
    } catch (err) {
      this.logger.error('Failed to build search index', { error: err.message });
    }
  }

  /**
   * 统一搜索入口
   * @param {string} query - 搜索关键词
   * @param {object} options - {type, limit, mode, useAI}
   */
  async search(query, options = {}) {
    const { type = 'all', limit = 20, mode = 'keyword' } = options;

    if (!query || !query.trim()) {
      return { items: [], total: 0, query };
    }

    // 检查缓存
    const cacheKey = `${query}:${type}:${limit}:${mode}:${options.groupByKind ? 'g' : ''}`;
    const cached = this._getCache(cacheKey);
    if (cached) return cached;

    // 确保索引已构建
    if (!this._indexed) {
      this.buildIndex();
    }

    let results;
    let actualMode = mode;  // 跟踪实际使用的搜索模式（semantic 可能降级为 bm25）

    switch (mode) {
      case 'ranking':
      case 'bm25':
        results = this._bm25Search(query, type, limit);
        break;
      case 'semantic': {
        const semResult = await this._semanticSearch(query, type, limit);
        results = semResult.items || semResult;
        actualMode = semResult.actualMode || 'semantic';
        break;
      }
      case 'keyword':
      default:
        results = this._keywordSearch(query, type, limit);
        break;
    }

    const response = {
      items: results,
      total: results.length,
      query,
      mode: actualMode,
      type,
    };

    // 按 kind 分组输出
    if (options.groupByKind) {
      response.byKind = {
        rule: results.filter(r => r.kind === 'rule'),
        pattern: results.filter(r => r.kind === 'pattern'),
        fact: results.filter(r => r.kind === 'fact'),
      };
    }

    this._setCache(cacheKey, response);
    return response;
  }

  /**
   * 关键词搜索 - 直接 SQL LIKE
   * 返回包含 kind 字段的完整结果，使用 ESCAPE 防止通配符注入
   */
  _keywordSearch(query, type, limit) {
    const results = [];
    // 转义 LIKE 通配符 (% → \%, _ → \_)
    const escaped = query.replace(/[%_\\]/g, ch => `\\${ch}`);
    const pattern = `%${escaped}%`;

    if (type === 'all' || type === 'recipe' || type === 'knowledge' || type === 'rule' || type === 'solution') {
      try {
        let rows = [];
        // V3: 优先 knowledge_entries
        try {
          rows = this.db.prepare(
            `SELECT id, title, description, language, category, knowledge_type, kind, lifecycle as status, content AS content_json, trigger_key as "trigger", headers, module_name, 'knowledge' as type
             FROM knowledge_entries
             WHERE lifecycle != 'deprecated' AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR trigger_key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
             LIMIT ?`
          ).all(pattern, pattern, pattern, pattern, limit);
        } catch {
          // V3 表不存在，回退到 V2
          rows = this.db.prepare(
            `SELECT id, title, description, language, category, knowledge_type, kind, status, content_json, dimensions_json, "trigger", 'recipe' as type
             FROM recipes
             WHERE status != 'deprecated' AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR "trigger" LIKE ? ESCAPE '\\' OR content_json LIKE ? ESCAPE '\\')
             LIMIT ?`
          ).all(pattern, pattern, pattern, pattern, limit);
        }
        // 基础相关性排序：trigger 精确 > 标题匹配 > 描述匹配 > 内容匹配
        const lowerQ = query.toLowerCase();
        results.push(...rows.map(r => {
          let score = 0.5;
          if (r.trigger && r.trigger.toLowerCase().includes(lowerQ)) score = 1.2;
          else if (r.title && r.title.toLowerCase().includes(lowerQ)) score = 1.0;
          else if (r.description && r.description.toLowerCase().includes(lowerQ)) score = 0.8;
          return { ...r, trigger: r.trigger || '', kind: r.kind || 'pattern', score: Math.round(score * 1000) / 1000 };
        }));
        results.sort((a, b) => b.score - a.score);
      } catch { /* table may not exist */ }
    }

    return results.slice(0, limit);
  }

  /**
   * BM25 排序搜索
   */
  _bm25Search(query, type, limit) {
    let results = this.scorer.search(query, limit * 2);

    if (type !== 'all') {
      // All types now map to 'recipe' since everything is unified
      results = results.filter(r => {
        if (type === 'rule') return r.meta.knowledgeType === 'boundary-constraint';
        return r.meta.type === 'recipe';
      });
    }

    const items = results.slice(0, limit).map(r => ({
      id: r.id,
      title: r.meta.title,
      trigger: r.meta.trigger || '',
      type: r.meta.type,
      kind: r.meta.kind || 'pattern',
      status: r.meta.status,
      language: r.meta.language || '',
      category: r.meta.category || '',
      score: Math.round(r.score * 1000) / 1000,
    }));

    // 为每个结果补充 content_json（NativeUI 预览需要）— 批量 IN 查询替代 N+1
    this._supplementDetails(items);

    return items;
  }

  /**
   * 语义搜索 - 需要 AI Provider 的 embed 功能
   * 降级到 BM25 如果 AI 不可用
   * @returns {{ items: Array, actualMode: string }}
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

      // 尝试通过 vectorStore 做的向量相似度搜索
      if (this.vectorStore) {
        try {
          const vectorResults = await this.vectorStore.query(queryEmbedding, limit * 2);
          if (vectorResults && vectorResults.length > 0) {
            let results = vectorResults.map(vr => ({
              id: vr.id,
              title: vr.metadata?.title || vr.id,
              type: 'recipe',
              kind: vr.metadata?.kind || 'pattern',
              status: vr.metadata?.status || 'active',
              score: Math.round((vr.similarity || vr.score || 0) * 1000) / 1000,
            }));
            if (type !== 'all') {
              results = results.filter(r => {
                if (type === 'rule') return r.kind === 'rule';
                return r.type === 'recipe';
              });
            }
            results = results.slice(0, limit);
            // 补充 content_json — 与 BM25 路径一致
            this._supplementDetails(results);
            return { items: results, actualMode: 'semantic' };
          }
        } catch (vecErr) {
          this.logger.warn('Vector store query failed, falling back to BM25', { error: vecErr.message });
        }
      }

      // vectorStore 不可用或无结果，降级到 BM25
      this.logger.debug('Vector search fallback to BM25');
      return { items: this._bm25Search(query, type, limit), actualMode: 'bm25' };
    } catch (err) {
      this.logger.warn('Semantic search failed, falling back to BM25', { error: err.message });
      return { items: this._bm25Search(query, type, limit), actualMode: 'bm25' };
    }
  }

  /**
   * 补充详细字段（content_json / dimensions_json / description / trigger）— 批量 IN 查询
   * 用于向量搜索结果与 BM25 结果的一致性
   */
  _supplementDetails(items) {
    if (!items || items.length === 0) return;
    try {
      const ids = items.map(it => it.id);
      const placeholders = ids.map(() => '?').join(',');
      let rows = [];
      // V3: 优先 knowledge_entries
      try {
        rows = this.db.prepare(
          `SELECT id, content AS content_json, description, trigger_key as "trigger", headers, module_name FROM knowledge_entries WHERE id IN (${placeholders})`
        ).all(...ids);
      } catch {
        rows = this.db.prepare(
          `SELECT id, content_json, dimensions_json, description, "trigger" FROM recipes WHERE id IN (${placeholders})`
        ).all(...ids);
      }
      const rowMap = new Map(rows.map(r => [r.id, r]));
      for (const item of items) {
        const row = rowMap.get(item.id);
        if (row) {
          item.content_json = row.content_json || null;
          item.dimensions_json = row.dimensions_json || null;
          item.description = item.description || row.description || '';
          item.trigger = item.trigger || row.trigger || '';
          // V3: headers & module_name 是独立列
          if (row.headers) item.headers = row.headers;
          if (row.module_name) item.module_name = row.module_name;
        }
      }
    } catch { /* DB may not be available */ }
  }

  /**
   * 刷新索引
   */
  refreshIndex() {
    this._indexed = false;
    this.buildIndex();
  }

  /**
   * 获取索引统计
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
    if (!entry) return null;
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
        if (k !== undefined) this._cache.delete(k);
      }
    }
    this._cache.set(key, { data, time: Date.now() });
  }
}

export default SearchEngine;
