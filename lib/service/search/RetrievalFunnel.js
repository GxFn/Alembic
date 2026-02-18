/**
 * RetrievalFunnel — 4 层检索漏斗
 * Layer 1: Keyword Filter (倒排索引 fast recall)
 * Layer 2: Cross-Encoder Rerank (AI 驱动语义重排，降级 Jaccard)
 * Layer 3: Multi-Signal Ranking (6 信号加权)
 * Layer 4: Context-Aware Reranking (对话历史提升)
 */

import { buildInvertedIndex, lookup, tokenize } from './InvertedIndex.js';
import { MultiSignalRanker } from './MultiSignalRanker.js';
import { CoarseRanker } from './CoarseRanker.js';
import { CrossEncoderReranker } from './CrossEncoderReranker.js';

export class RetrievalFunnel {
  #multiSignalRanker;
  #coarseRanker;
  #crossEncoder;
  #vectorStore;
  #aiProvider;

  constructor(options = {}) {
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
   * @param {Array} candidates — 全量候选（应已通过 normalizeFunnelInput 规范化）
   * @param {object} context — { intent, language, userLevel, sessionHistory, ... }
   * @returns {Array} — ranked results
   */
  async execute(query, candidates, context = {}) {
    if (!candidates || candidates.length === 0) return [];
    if (!query) return candidates;

    // Layer 1: Keyword Filter — 倒排索引快速召回
    let results = this.#keywordFilter(query, candidates);

    // 如果关键词无结果，退回全量
    if (results.length === 0) results = [...candidates];

    // Layer 2: Semantic Rerank — 向量/Jaccard 相似度重排
    results = await this.#semanticRerank(query, results);

    // Layer 2.5: Coarse Ranking — E-E-A-T 五维粗排
    results = this.#coarseRanker.rank(results);

    // Layer 3: Multi-Signal Ranking — 6 信号加权
    results = this.#multiSignalRanker.rank(results, { ...context, query });

    // Layer 4: Context-Aware Reranking — 对话上下文加成
    results = this.#contextAwareRerank(results, context);

    return results;
  }

  /**
   * Layer 1: 倒排索引关键词过滤
   */
  #keywordFilter(query, candidates) {
    const index = buildInvertedIndex(candidates);
    const matchedIndices = lookup(index, query);

    if (matchedIndices.length === 0) return [];
    return matchedIndices.map(idx => candidates[idx]);
  }

  /**
   * Layer 2: 语义重排 — Cross-Encoder AI 评分（降级 Jaccard）
   */
  async #semanticRerank(query, candidates) {
    return this.#crossEncoder.rerank(query, candidates);
  }

  /**
   * Layer 4: 对话上下文感知重排
   * - 会话中提到过的 topic 相关 +20%
   * - 语言匹配 +10%
   */
  #contextAwareRerank(candidates, context) {
    if (!context.sessionHistory || context.sessionHistory.length === 0) return candidates;

    // 收集会话中的关键词
    const sessionKeywords = new Set();
    for (const turn of context.sessionHistory) {
      const tokens = tokenize(turn.content || turn.rawInput || '');
      for (const t of tokens) sessionKeywords.add(t);
    }

    return candidates.map(candidate => {
      let boost = 0;
      const text = [candidate.title, candidate.trigger, candidate.content].filter(Boolean).join(' ').toLowerCase();

      // 会话上下文匹配
      const textTokens = tokenize(text);
      const sessionOverlap = textTokens.filter(t => sessionKeywords.has(t)).length;
      if (sessionOverlap > 0) boost += 0.2 * Math.min(sessionOverlap / 5, 1);

      // 语言匹配
      if (context.language && candidate.language === context.language) boost += 0.1;

      const contextScore = (candidate.rankerScore || candidate.coarseScore || 0) * (1 + boost);
      return { ...candidate, contextScore, contextBoost: boost };
    }).sort((a, b) => b.contextScore - a.contextScore);
  }
}
