/**
 * RetrievalFunnel — 5 层检索漏斗
 * Layer 0: Vector Pre-Filter (向量相似度信号附加)
 * Layer 1: Keyword Filter (倒排索引 fast recall)
 * Layer 2: Cross-Encoder Rerank (AI 驱动语义重排，降级 Jaccard)
 * Layer 3: Multi-Signal Ranking (6+1 信号加权，含 vectorScore)
 * Layer 4: Context-Aware Reranking (对话历史提升)
 */

import { CoarseRanker } from './CoarseRanker.js';
import { CrossEncoderReranker } from './CrossEncoderReranker.js';
import { contextBoost, type SearchContext, type SearchItem } from './contextBoost.js';
import { buildInvertedIndex, lookup } from './InvertedIndex.js';
import { MultiSignalRanker } from './MultiSignalRanker.js';

/** VectorService-like interface for search delegation */
interface VectorSearchable {
  search(
    query: string,
    opts?: { topK?: number }
  ): Promise<Array<{ item: Record<string, unknown>; score: number }>>;
}

export class RetrievalFunnel {
  #multiSignalRanker;
  #coarseRanker;
  #crossEncoder;
  #vectorService: VectorSearchable | null;
  #aiProvider;

  constructor(
    options: {
      vectorService?: VectorSearchable | null;
      aiProvider?: unknown;
      logger?: unknown;
      [key: string]: unknown;
    } = {}
  ) {
    this.#multiSignalRanker = new MultiSignalRanker(
      options as { scenarioWeights?: Record<string, Record<string, number>> }
    );
    this.#coarseRanker = new CoarseRanker(
      options as {
        bm25Weight?: number;
        semanticWeight?: number;
        qualityWeight?: number;
        freshnessWeight?: number;
        popularityWeight?: number;
      }
    );
    this.#vectorService = options.vectorService || null;
    this.#aiProvider = options.aiProvider || null;
    this.#crossEncoder = new CrossEncoderReranker({
      aiProvider: this.#aiProvider as {
        chatWithStructuredOutput: (
          prompt: string,
          opts: Record<string, unknown>
        ) => Promise<unknown>;
      } | null,
      logger: options.logger as { warn?: (...args: unknown[]) => void } | undefined,
    });
  }

  /**
   * 执行 5 层漏斗
   * @param {string} query
   * @param {Array} candidates 全量候选（应已通过 normalizeFunnelInput 规范化）
   * @param {object} context - { intent, language, userLevel, sessionHistory, ... }
   * @returns {Promise<Array>} - ranked results
   */
  async execute(query: string, candidates: SearchItem[], context: SearchContext = {}) {
    if (!candidates || candidates.length === 0) {
      return [];
    }
    if (!query) {
      return candidates;
    }

    // Layer 0: Vector Pre-Filter — 为候选附加向量相似度信号
    let results = await this.#vectorPreFilter(query, candidates);

    // Layer 1: Keyword Filter — 倒排索引快速召回
    results = this.#keywordFilter(query, results);

    // 如果关键词无结果，退回全量
    if (results.length === 0) {
      results = await this.#vectorPreFilter(query, candidates);
    }

    // Layer 2: Semantic Rerank — 向量/Jaccard 相似度重排
    results = await this.#semanticRerank(query, results);

    // Layer 2.5: Coarse Ranking — E-E-A-T 五维粗排
    results = this.#coarseRanker.rank(results);

    // Layer 3: Multi-Signal Ranking — 6+1 信号加权
    results = this.#multiSignalRanker.rank(results, { ...context, query });

    // Layer 4: Context-Aware Reranking — 对话上下文加成
    results = contextBoost(results, context);

    return results;
  }

  /**
   * Layer 0: 向量相似度预过滤
   * 为每个候选附加 vectorScore 信号，供 MultiSignalRanker 使用
   */
  async #vectorPreFilter(query: string, candidates: SearchItem[]): Promise<SearchItem[]> {
    if (!this.#vectorService || candidates.length === 0) {
      return candidates;
    }

    try {
      const vectorResults = await this.#vectorService.search(query, { topK: 50 });
      if (vectorResults.length === 0) {
        return candidates;
      }

      // 构建 id → score 映射
      const vectorScoreMap = new Map<string, number>();
      for (const vr of vectorResults) {
        const id =
          (vr.item as { id?: string; entryId?: string }).id ||
          (vr.item as { id?: string; entryId?: string }).entryId ||
          (vr.item as { metadata?: { entryId?: string } }).metadata?.entryId;
        if (id) {
          vectorScoreMap.set(id, vr.score);
        }
      }

      // 为候选附加 vectorScore
      return candidates.map((item) => ({
        ...item,
        vectorScore: vectorScoreMap.get((item.id as string) ?? '') ?? 0,
      }));
    } catch {
      // 向量服务不可用时 graceful degrade
      return candidates;
    }
  }

  /**
   * Layer 1: 倒排索引关键词过滤
   */
  #keywordFilter(query: string, candidates: SearchItem[]) {
    const index = buildInvertedIndex(candidates);
    const matchedIndices = lookup(index, query);

    if (matchedIndices.length === 0) {
      return [];
    }
    return matchedIndices.map((idx) => candidates[idx as number]);
  }

  /**
   * Layer 2: 语义重排 — Cross-Encoder AI 评分（降级 Jaccard）
   */
  async #semanticRerank(query: string, candidates: SearchItem[]) {
    return this.#crossEncoder.rerank(query, candidates);
  }
}
