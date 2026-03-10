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

import { cosineSimilarity } from '#shared/similarity.js';
import type { DeserializedMemory, MemoryRow } from './MemoryStore.js';
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

/** 带评分的记忆检索结果 */
export interface ScoredMemory extends DeserializedMemory {
  _score: number;
  _recency: number;
  _relevance: number;
}

/** 检索选项 */
export interface RetrieveOptions {
  limit?: number;
  source?: string;
  type?: string;
}

/** Prompt section 生成选项 */
export interface PromptSectionOptions {
  source?: string;
  query?: string;
  limit?: number;
  tokenBudget?: number;
}

/** Memory.load 兼容选项 */
export interface LoadOptions {
  source?: string;
}

/** Memory.append 兼容入口 */
export interface AppendEntry {
  type?: string;
  content: string;
  source?: string;
  ttl?: number | null;
}

/** 嵌入函数签名 — 异步向量嵌入 (返回 float[] 向量) */
export type EmbeddingFn = (text: string) => Promise<number[]>;

export class MemoryRetriever {
  #store: MemoryStore;

  /** 向量嵌入函数 */
  #embeddingFn: EmbeddingFn | null;

  /** @param [opts.embeddingFn] 向量嵌入函数 (异步) */
  constructor(store: MemoryStore, opts: { embeddingFn?: EmbeddingFn } = {}) {
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
   * @param query 查询文本
   * @returns 按 score 降序排列
   */
  async retrieve(
    query: string,
    { limit = 10, source, type }: RetrieveOptions = {}
  ): Promise<ScoredMemory[]> {
    const all = this.#store.getAllActive({ source, type });
    if (all.length === 0) {
      return [];
    }

    const now = Date.now();
    const lowerQuery = (query || '').toLowerCase();
    const queryTokens = MemoryRetriever.#tokenizeWords(lowerQuery);

    // 向量检索: 嵌入 query，然后与存储的 embedding 做余弦相似度
    let queryVec: number[] | null = null;
    if (this.#embeddingFn) {
      try {
        queryVec = await this.#embeddingFn(query);
      } catch {
        // embedding 不可用时 graceful degrade 到纯词汇
      }
    }

    const scored = all.map((m) => {
      // Recency: 指数衰减 (半衰期 7 天)
      const lastAccess = m.last_accessed_at
        ? new Date(m.last_accessed_at).getTime()
        : new Date(m.updated_at).getTime();
      const daysSinceAccess = (now - lastAccess) / 86400_000;
      const recency = Math.exp((-daysSinceAccess * Math.LN2) / RECENCY_HALF_LIFE_DAYS);

      // Importance: 归一化到 0-1
      const importance = (m.importance || 5) / 10;

      // Relevance: 词汇相关性 (lexical)
      const lexicalRelevance = MemoryRetriever.#computeRelevance(
        lowerQuery,
        queryTokens,
        m.content
      );

      // 向量相关性: 对有 embedding 的记忆计算余弦相似度
      const deserialized = MemoryStore.deserialize(m);
      let vectorRelevance = 0;
      if (queryVec && deserialized.embedding) {
        vectorRelevance = Math.max(0, cosineSimilarity(queryVec, deserialized.embedding));
      }

      // 混合相关性: 有向量时 0.6 * vector + 0.4 * lexical，否则纯 lexical
      const relevance =
        queryVec && deserialized.embedding
          ? 0.6 * vectorRelevance + 0.4 * lexicalRelevance
          : lexicalRelevance;

      const score =
        WEIGHT_RECENCY * recency + WEIGHT_IMPORTANCE * importance + WEIGHT_RELEVANCE * relevance;

      return {
        ...deserialized,
        _score: score,
        _recency: recency,
        _relevance: relevance,
      };
    });

    scored.sort((a, b) => b._score - a._score);

    // 更新访问计数 (只更新返回的)
    const topN = scored.slice(0, limit);
    for (const m of topN) {
      this.#store.touchAccess(m.id);
    }

    return topN;
  }

  /** 简单文本搜索 (不打分, 用于去重检查) */
  search(content: string, { limit = 5 } = {}): DeserializedMemory[] {
    const results = this.#store.findSimilar(content, null, limit);
    return results.map((r) => MemoryStore.deserialize(r));
  }

  // ═══════════════════════════════════════════════════════════
  // Prompt 生成 (预算感知)
  // ═══════════════════════════════════════════════════════════

  /**
   * 生成供系统提示词的记忆摘要 (预算感知)
   *
   * @returns Markdown 格式
   */
  async toPromptSection({
    source,
    query,
    limit = 15,
    tokenBudget,
  }: PromptSectionOptions = {}): Promise<string> {
    if (tokenBudget && tokenBudget > 0) {
      const EST_TOKENS_PER_MEMORY = 30;
      const HEADER_TOKENS = 15;
      const maxByBudget = Math.max(
        3,
        Math.floor((tokenBudget - HEADER_TOKENS) / EST_TOKENS_PER_MEMORY)
      );
      limit = Math.min(limit, maxByBudget);
    }

    let memories: DeserializedMemory[];

    if (query) {
      memories = await this.retrieve(query, { limit, source });
    } else {
      memories = this.#store
        .getAllActive({ source })
        .sort((a, b) => {
          const scoreA = (a.importance || 5) * 0.6 + (a.access_count || 0) * 0.4;
          const scoreB = (b.importance || 5) * 0.6 + (b.access_count || 0) * 0.4;
          return scoreB - scoreA;
        })
        .slice(0, limit)
        .map((m) => MemoryStore.deserialize(m));
    }

    if (memories.length === 0) {
      return '';
    }

    const lines = memories.map((m) => {
      const badge = m.importance >= 8 ? '⚠️' : m.importance >= 5 ? '📌' : '💡';
      return `- ${badge} [${m.type}] ${m.content}`;
    });

    return `\n## 项目记忆 (${memories.length} 条最相关)\n${lines.join('\n')}\n`;
  }

  // ═══════════════════════════════════════════════════════════
  // Memory.js 兼容层
  // ═══════════════════════════════════════════════════════════

  /** 兼容 Memory.load() — 返回最近 N 条记忆 */
  load(limit = 20, { source }: LoadOptions = {}) {
    const rows = this.#store
      .getAllActive({ source })
      .sort((a, b) => {
        const tA = new Date(a.updated_at).getTime();
        const tB = new Date(b.updated_at).getTime();
        return tB - tA;
      })
      .slice(0, limit);
    return rows.map((r) => ({
      ts: r.updated_at,
      type: r.type,
      content: r.content,
      source: r.source,
      importance: r.importance,
    }));
  }

  /** 兼容 Memory.append() — 添加一条记忆 (自动去重) */
  append(entry: AppendEntry) {
    const content = (entry.content || '').trim().substring(0, 500);
    if (!content) {
      return;
    }

    // 去重: 检查是否已有高相似度记忆
    const similar = this.#store.findSimilar(content, entry.type ?? null, 1);
    if (similar.length > 0 && (similar[0].similarity ?? 0) >= SIMILARITY_UPDATE) {
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
  // 向量嵌入接口
  // ═══════════════════════════════════════════════════════════

  /** 设置向量嵌入函数 */
  setEmbeddingFunction(fn: EmbeddingFn | null) {
    this.#embeddingFn = typeof fn === 'function' ? fn : null;
  }

  /** 获取当前嵌入函数 */
  getEmbeddingFunction(): EmbeddingFn | null {
    return this.#embeddingFn;
  }

  /**
   * 为所有缺少 embedding 的记忆批量生成向量嵌入
   * @param batchSize 每批数量 (默认 20)
   * @returns 成功嵌入的记忆数
   */
  async embedAllMemories(batchSize = 20): Promise<number> {
    if (!this.#embeddingFn) {
      return 0;
    }

    const missing = this.#store.getWithoutEmbedding(batchSize);
    if (missing.length === 0) {
      return 0;
    }

    const entries: Array<{ id: string; embedding: number[] }> = [];
    for (const item of missing) {
      try {
        const vec = await this.#embeddingFn(item.content);
        entries.push({ id: item.id, embedding: vec });
      } catch {
        // 单条失败不阻塞
      }
    }

    if (entries.length === 0) {
      return 0;
    }

    return this.#store.batchUpdateEmbeddings(entries);
  }

  /**
   * 使用嵌入函数计算语义相关性 (余弦相似度)
   * @param query 查询文本
   * @param content 记忆内容
   * @returns 相似度分数 或 null
   */
  async computeEmbeddingRelevance(query: string, content: string): Promise<number | null> {
    if (!this.#embeddingFn) {
      return null;
    }
    try {
      const [queryVec, contentVec] = await Promise.all([
        this.#embeddingFn(query),
        this.#embeddingFn(content),
      ]);
      return cosineSimilarity(queryVec, contentVec);
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Private: 相关性计算
  // ═══════════════════════════════════════════════════════════

  static #computeRelevance(lowerQuery: string, queryTokens: Set<string>, content: string): number {
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

  static #tokenizeWords(text: string): Set<string> {
    if (!text) {
      return new Set();
    }
    return new Set(
      text
        .split(/[\s,;:!?。，；：！？\-_/\\|()[\]{}'"<>]+/)
        .filter((t) => t.length >= 2)
        .map((t) => t.toLowerCase())
    );
  }
}
