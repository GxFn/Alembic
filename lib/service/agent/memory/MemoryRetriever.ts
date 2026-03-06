/**
 * MemoryRetriever — 记忆检索与 Prompt 生成
 *
 * 从 PersistentMemory.js 提取的检索逻辑。
 * 负责:
 *   - 三维打分检索 (Generative Agents: recency × importance × relevance)
 *   - 简单文本搜索
 *   - Prompt section 生成 (预算感知)
 *   - Memory.js 兼容层: load(), append()
 *
 * @module MemoryRetriever
 */

import { MemoryStore } from './MemoryStore.js';

// ─── 常量 (Generative Agents 三维打分) ────────────────

/** 检索打分权重 */
const WEIGHT_RECENCY = 0.2;
const WEIGHT_IMPORTANCE = 0.3;
const WEIGHT_RELEVANCE = 0.5;

/** Recency 半衰期 (天) — 7 天未访问的记忆分数下降一半 */
const RECENCY_HALF_LIFE_DAYS = 7;

/** 相似度阈值 (用于 append 去重) */
const SIMILARITY_UPDATE = 0.85;

export class MemoryRetriever {
  /** @type {MemoryStore} */
  #store;

  /** @type {Function|null} 向量嵌入函数 (ADR-3 预留) */
  #embeddingFn;

  /**
   * @param {MemoryStore} store
   * @param {object} [opts]
   * @param {Function} [opts.embeddingFn] 向量嵌入函数
   */
  constructor(store: any, opts: any = {}) {
    this.#store = store;
    this.#embeddingFn = typeof opts.embeddingFn === 'function' ? opts.embeddingFn : null;
  }

  // ═══════════════════════════════════════════════════════════
  // 综合检索
  // ═══════════════════════════════════════════════════════════

  /**
   * 综合检索: recency × importance × relevance
   *
   * 借鉴 Generative Agents 的三维打分模型:
   *   score = α * recency + β * importance + γ * relevance
   *
   * @param {string} query 查询文本
   * @param {object} [opts]
   * @param {number} [opts.limit=10]
   * @param {string} [opts.source]
   * @param {string} [opts.type]
   * @returns {Array<object>} 按 score 降序排列
   */
  retrieve(query: any, { limit = 10, source, type }: any = {}) {
    const all = this.#store.getAllActive({ source, type });
    if (all.length === 0) {
      return [];
    }

    const now = Date.now();
    const lowerQuery = (query || '').toLowerCase();
    const queryTokens = MemoryRetriever.#tokenizeWords(lowerQuery);

    const scored = all.map((m: any) => {
      // Recency: 指数衰减 (半衰期 7 天)
      const lastAccess = m.last_accessed_at
        ? new Date(m.last_accessed_at).getTime()
        : new Date(m.updated_at).getTime();
      const daysSinceAccess = (now - lastAccess) / 86400_000;
      const recency = Math.exp((-daysSinceAccess * Math.LN2) / RECENCY_HALF_LIFE_DAYS);

      // Importance: 归一化到 0-1
      const importance = (m.importance || 5) / 10;

      // Relevance: token overlap + 子串匹配
      const relevance = MemoryRetriever.#computeRelevance(lowerQuery, queryTokens, m.content);

      const score =
        WEIGHT_RECENCY * recency + WEIGHT_IMPORTANCE * importance + WEIGHT_RELEVANCE * relevance;

      return {
        ...MemoryStore.deserialize(m),
        _score: score,
        _recency: recency,
        _relevance: relevance,
      };
    });

    scored.sort((a: any, b: any) => b._score - a._score);

    // 更新访问计数 (只更新返回的)
    const topN = scored.slice(0, limit);
    for (const m of topN) {
      this.#store.touchAccess(m.id);
    }

    return topN;
  }

  /**
   * 简单文本搜索 (不打分, 用于去重检查)
   * @param {string} content
   * @param {object} [opts]
   * @param {number} [opts.limit=5]
   * @returns {Array<object>}
   */
  search(content: any, { limit = 5 } = {}) {
    const results = this.#store.findSimilar(content, null, limit);
    return results.map((r: any) => MemoryStore.deserialize(r));
  }

  // ═══════════════════════════════════════════════════════════
  // Prompt 生成 (预算感知)
  // ═══════════════════════════════════════════════════════════

  /**
   * 生成供系统提示词的记忆摘要 (预算感知)
   *
   * @param {object} [opts]
   * @param {string} [opts.source]
   * @param {string} [opts.query]
   * @param {number} [opts.limit=15]
   * @param {number} [opts.tokenBudget]
   * @returns {string} Markdown 格式
   */
  toPromptSection({ source, query, limit = 15, tokenBudget }: any = {}) {
    if (tokenBudget && tokenBudget > 0) {
      const EST_TOKENS_PER_MEMORY = 30;
      const HEADER_TOKENS = 15;
      const maxByBudget = Math.max(
        3,
        Math.floor((tokenBudget - HEADER_TOKENS) / EST_TOKENS_PER_MEMORY)
      );
      limit = Math.min(limit, maxByBudget);
    }

    let memories;

    if (query) {
      memories = this.retrieve(query, { limit, source });
    } else {
      memories = this.#store
        .getAllActive({ source })
        .sort((a: any, b: any) => {
          const scoreA = (a.importance || 5) * 0.6 + (a.access_count || 0) * 0.4;
          const scoreB = (b.importance || 5) * 0.6 + (b.access_count || 0) * 0.4;
          return scoreB - scoreA;
        })
        .slice(0, limit)
        .map((m: any) => MemoryStore.deserialize(m));
    }

    if (memories.length === 0) {
      return '';
    }

    const lines = memories.map((m: any) => {
      const badge = m.importance >= 8 ? '⚠️' : m.importance >= 5 ? '📌' : '💡';
      return `- ${badge} [${m.type}] ${m.content}`;
    });

    return `\n## 项目记忆 (${memories.length} 条最相关)\n${lines.join('\n')}\n`;
  }

  // ═══════════════════════════════════════════════════════════
  // Memory.js 兼容层
  // ═══════════════════════════════════════════════════════════

  /**
   * 兼容 Memory.load() — 返回最近 N 条记忆
   * @param {number} [limit=20]
   * @param {object} [opts]
   * @param {string} [opts.source]
   * @returns {Array<object>}
   */
  load(limit = 20, { source }: any = {}) {
    const rows = this.#store
      .getAllActive({ source })
      .sort((a: any, b: any) => {
        const tA = new Date(a.updated_at).getTime();
        const tB = new Date(b.updated_at).getTime();
        return tB - tA;
      })
      .slice(0, limit);
    return rows.map((r: any) => ({
      ts: r.updated_at,
      type: r.type,
      content: r.content,
      source: r.source,
      importance: r.importance,
    }));
  }

  /**
   * 兼容 Memory.append() — 添加一条记忆 (自动去重)
   * @param {object} entry
   */
  append(entry: any) {
    const content = (entry.content || '').trim().substring(0, 500);
    if (!content) {
      return;
    }

    // 去重: 检查是否已有高相似度记忆
    const similar = this.#store.findSimilar(content, entry.type, 1);
    if (similar.length > 0 && similar[0].similarity >= SIMILARITY_UPDATE) {
      this.#store.touchAccess(similar[0].id);
      return;
    }

    this.#store.add({
      type: entry.type || 'context',
      content,
      source: entry.source || 'user',
      importance: 5,
      ttlDays: entry.ttl || null,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 向量嵌入接口 (ADR-3 预留)
  // ═══════════════════════════════════════════════════════════

  /** 设置向量嵌入函数 */
  setEmbeddingFunction(fn: any) {
    this.#embeddingFn = typeof fn === 'function' ? fn : null;
  }

  /** 获取当前嵌入函数 */
  getEmbeddingFunction() {
    return this.#embeddingFn;
  }

  /**
   * 使用嵌入函数计算语义相关性
   * @param {string} query
   * @param {string} content
   * @returns {number|null}
   */
  computeEmbeddingRelevance(query: any, content: any) {
    if (!this.#embeddingFn) {
      return null;
    }
    try {
      return this.#embeddingFn(query, content);
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Private: 相关性计算
  // ═══════════════════════════════════════════════════════════

  static #computeRelevance(lowerQuery: any, queryTokens: any, content: any) {
    if (!lowerQuery || !content) {
      return 0;
    }

    const lowerContent = content.toLowerCase();
    const contentTokens = MemoryRetriever.#tokenizeWords(lowerContent);
    if (queryTokens.size === 0) {
      return 0;
    }

    let matchCount = 0;
    for (const t of queryTokens) {
      if (contentTokens.has(t)) {
        matchCount++;
      }
    }
    const tokenOverlap = matchCount / queryTokens.size;
    const substringMatch = lowerContent.includes(lowerQuery) ? 0.4 : 0;

    let partialMatch = 0;
    for (const qt of queryTokens) {
      if (qt.length >= 3 && lowerContent.includes(qt)) {
        partialMatch += 0.1;
      }
    }
    partialMatch = Math.min(0.3, partialMatch);

    return Math.min(1.0, tokenOverlap * 0.5 + substringMatch + partialMatch);
  }

  static #tokenizeWords(text: any) {
    if (!text) {
      return new Set();
    }
    return new Set(
      text
        .split(/[\s,;:!?。，；：！？\-_/\\|()[\]{}'"<>]+/)
        .filter((t: any) => t.length >= 2)
        .map((t: any) => t.toLowerCase())
    );
  }
}
