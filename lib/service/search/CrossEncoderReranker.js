/**
 * CrossEncoderReranker — AI 驱动的语义重排器
 *
 * 替代 Jaccard 相似度，使用 LLM 对 (query, document) 对进行语义相关性评分。
 *
 * 策略:
 *   1. 将候选文档与 query 组成 pairs，批量送入 AI 评分
 *   2. AI 返回每个 pair 的 relevance score (0.0-1.0)
 *   3. 按 score 降序排列
 *
 * 优化:
 *   - 单次 API 调用批量评分（减少延迟和成本）
 *   - 文档截断至 MAX_DOC_LEN 控制 token 消耗
 *   - 候选上限 MAX_CANDIDATES，超出部分保留原始顺序
 *   - AI 不可用时自动降级到 Jaccard
 */

import { jaccardSimilarity } from '../../shared/similarity.js';
import { tokenize } from './InvertedIndex.js';

const MAX_CANDIDATES = 40; // 超过此数量截断（控制 prompt 大小）
const MAX_DOC_LEN = 300; // 每个文档最大字符数

export class CrossEncoderReranker {
  #aiProvider;
  #logger;

  /**
   * @param {object} opts
   * @param {import('../../external/ai/AiProvider.js').AiProvider} opts.aiProvider
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    this.#aiProvider = opts.aiProvider || null;
    this.#logger = opts.logger || console;
  }

  /**
   * 对候选列表进行语义重排
   *
   * @param {string} query — 用户查询
   * @param {Array<object>} candidates — Layer 1 输出的候选列表
   * @returns {Promise<Array<object>>} — 附带 semanticScore 的候选列表（降序）
   */
  async rerank(query, candidates) {
    if (!candidates || candidates.length === 0) {
      return [];
    }
    if (!query) {
      return candidates;
    }

    // 如果 AI Provider 不可用，降级到 Jaccard
    if (!this.#aiProvider || typeof this.#aiProvider.chatWithStructuredOutput !== 'function') {
      return this.#jaccardFallback(query, candidates);
    }

    // 截取前 MAX_CANDIDATES 个候选，剩余保持原始顺序
    const head = candidates.slice(0, MAX_CANDIDATES);
    const tail = candidates.slice(MAX_CANDIDATES);

    try {
      const scored = await this.#batchScore(query, head);
      // tail 部分给一个递减的低分以保持稳定排序
      const minScore =
        scored.length > 0 ? Math.min(...scored.map((s) => s.semanticScore)) * 0.5 : 0;
      const tailScored = tail.map((c, i) => ({
        ...c,
        semanticScore: Math.max(minScore - (i + 1) * 0.001, 0),
      }));
      return [...scored, ...tailScored];
    } catch (err) {
      this.#logger.warn?.(
        `[CrossEncoderReranker] AI scoring failed, falling back to Jaccard: ${err.message}`
      );
      return this.#jaccardFallback(query, candidates);
    }
  }

  /**
   * 批量 AI 评分 — 单次 chatWithStructuredOutput 调用
   */
  async #batchScore(query, candidates) {
    const pairs = candidates.map((c, i) => {
      const doc = this.#extractDocText(c);
      return `[${i}] ${doc.substring(0, MAX_DOC_LEN)}`;
    });

    const prompt = `# Task
Score the relevance of each document to the query. Return ONLY a JSON array.

# Query
${query}

# Documents
${pairs.join('\n')}

# Output Format
Return a JSON array of objects: [{"i": 0, "s": 0.85}, {"i": 1, "s": 0.3}, ...]
- "i": document index (integer)
- "s": relevance score (float 0.0-1.0, where 1.0 = perfectly relevant)

Score guidelines:
- 1.0: exact match or directly answers the query
- 0.7-0.9: highly relevant, covers the main topic
- 0.4-0.6: partially relevant, related topic
- 0.1-0.3: tangentially related
- 0.0: completely irrelevant

Return ONLY a JSON array, no markdown or explanation.`;

    const result = await this.#aiProvider.chatWithStructuredOutput(prompt, {
      openChar: '[',
      closeChar: ']',
      temperature: 0.1,
      maxTokens: 2048,
    });

    if (!Array.isArray(result)) {
      throw new Error('AI returned non-array result');
    }

    // 构建 index → score 映射
    const scoreMap = new Map();
    for (const item of result) {
      const idx = item.i ?? item.index;
      const score = item.s ?? item.score ?? 0;
      if (typeof idx === 'number' && idx >= 0 && idx < candidates.length) {
        scoreMap.set(idx, Math.max(0, Math.min(1, score)));
      }
    }

    // 合并分数，未评分的给 0
    return candidates
      .map((c, i) => ({
        ...c,
        semanticScore: scoreMap.get(i) ?? 0,
      }))
      .sort((a, b) => b.semanticScore - a.semanticScore);
  }

  /**
   * 从候选对象提取用于评分的文本表示
   */
  #extractDocText(candidate) {
    const parts = [
      candidate.title,
      candidate.trigger,
      candidate.description || candidate.summary,
      candidate.code,
      candidate.content,
    ].filter(Boolean);
    return parts.join(' | ');
  }

  /**
   * Jaccard 降级 — 当 AI 不可用时使用
   */
  #jaccardFallback(query, candidates) {
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) {
      return candidates;
    }

    return candidates
      .map((candidate) => {
        const text = this.#extractDocText(candidate);
        const docTokens = new Set(tokenize(text));
        const score = jaccardSimilarity(queryTokens, docTokens);
        return { ...candidate, semanticScore: score };
      })
      .sort((a, b) => b.semanticScore - a.semanticScore);
  }
}
