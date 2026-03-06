/**
 * contextBoost — 会话上下文感知排序加成
 *
 * 从 SearchEngine._contextBoost 和 RetrievalFunnel.#contextAwareRerank 统一提取。
 *
 * 规则:
 *   - 会话历史关键词重叠 → +20% (最多 5 个词满分)
 *   - 语言匹配            → +10%
 *
 * @module contextBoost
 */

import { tokenize } from './InvertedIndex.js';

/**
 * @param {Array} items  - 已排序的候选列表（需有 rankerScore / coarseScore / score）
 * @param {object} context
 * @param {Array<{content?: string, rawInput?: string}>} [context.sessionHistory]
 * @param {string} [context.language]
 * @returns {Array} - 含 contextScore / contextBoost 字段的排序列表
 */
export function contextBoost(items: any, context: any = {}) {
  const { sessionHistory = [], language } = context;
  if (!sessionHistory.length) {
    return items;
  }

  // 收集会话中的关键词
  const sessionKeywords = new Set();
  for (const turn of sessionHistory) {
    const tokens = tokenize(turn.content || turn.rawInput || '');
    for (const t of tokens) {
      sessionKeywords.add(t);
    }
  }

  return items
    .map((item: any) => {
      let boost = 0;

      // 会话上下文匹配
      const textTokens = tokenize(
        [item.title, item.trigger, item.content].filter(Boolean).join(' ')
      );
      const overlap = textTokens.filter((t) => sessionKeywords.has(t)).length;
      if (overlap > 0) {
        boost += 0.2 * Math.min(overlap / 5, 1);
      }

      // 语言匹配
      if (language && item.language === language) {
        boost += 0.1;
      }

      const baseScore = item.rankerScore || item.coarseScore || item.score || 0;
      const contextScore = baseScore * (1 + boost);
      return { ...item, contextScore, contextBoost: boost };
    })
    .sort((a: any, b: any) => b.contextScore - a.contextScore);
}
