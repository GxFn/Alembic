/**
 * RetrievalFunnel — 4 层检索漏斗
 * Layer 1: Keyword Filter (倒排索引 fast recall)
 * Layer 2: Cross-Encoder Rerank (AI 驱动语义重排，降级 Jaccard)
 * Layer 3: Multi-Signal Ranking (6 信号加权)
 * Layer 4: Context-Aware Reranking (对话历史提升)
 */

import { CoarseRanker } from './CoarseRanker.js';
import { contextBoost } from './contextBoost.js';
import { CrossEncoderReranker } from './CrossEncoderReranker.js';
import { buildInvertedIndex, lookup } from './InvertedIndex.js';
import { MultiSignalRanker } from './MultiSignalRanker.js';

export class RetrievalFunnel {
  #multiSignalRanker;
  #coarseRanker;
  #crossEncoder;
  #vectorStore;
  #aiProvider;

  constructor(options: any = {}) {
    this.#multiSignalRanker = new MultiSignalRanker(options);
    this.#coarseRanker = new CoarseRanker(options);
    this.#vectorStore = options.vectorStore || null;
    this.#aiProvider = options.aiProvider || null;
    this.#crossEncoder = new CrossEncoderReranker({
      aiProvider: this.#aiProvider,
      logger: options.logger || console,
    });
  }

  /**
   * 执行 4 层漏斗
   * @param {string} query
   * @param {Array} candidates 全量候选（应已通过 normalizeFunnelInput 规范化）
   * @param {object} context - { intent, language, userLevel, sessionHistory, ... }
   * @returns {Promise<Array>} - ranked results
   */
  async execute(query, candidates, context: any = {}) {
    if (!candidates || candidates.length === 0) {
      return [];
    }
    if (!query) {
      return candidates;
    }

    // Layer 1: Keyword Filter — 倒排索引快速召回
    let results = this.#keywordFilter(query, candidates);

    // 如果关键词无结果，退回全量
    if (results.length === 0) {
      results = [...candidates];
    }

    // Layer 2: Semantic Rerank — 向量/Jaccard 相似度重排
    results = await this.#semanticRerank(query, results);

    // Layer 2.5: Coarse Ranking — E-E-A-T 五维粗排
    results = this.#coarseRanker.rank(results);

    // Layer 3: Multi-Signal Ranking — 6 信号加权
    results = this.#multiSignalRanker.rank(results, { ...context, query });

    // Layer 4: Context-Aware Reranking — 对话上下文加成
    results = contextBoost(results, context);

    return results;
  }

  /**
   * Layer 1: 倒排索引关键词过滤
   */
  #keywordFilter(query, candidates) {
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
  async #semanticRerank(query, candidates) {
    return this.#crossEncoder.rerank(query, candidates);
  }
}
