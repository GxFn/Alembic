/**
 * CandidateAggregator — 候选条目去重聚合
 *
 * 对候选列表按 title 进行模糊去重，保留最优条目。
 * 被 knowledge handler 的 submitKnowledgeBatch 使用。
 *
 * @module service/candidate/CandidateAggregator
 */

import { jaccardSimilarity, tokenizeForSimilarity } from '../../shared/similarity.js';

/** title 相似度阈值，超过此值视为重复 */
const TITLE_SIMILARITY_THRESHOLD = 0.85;

interface CandidateItem {
  title: string;
  code?: string;
  [key: string]: unknown;
}

interface AggregateOpts {
  threshold?: number;
}

/**
 * 对候选条目列表进行去重聚合
 *
 * @param {CandidateItem[]} items
 * @param {AggregateOpts} [opts]
 * @returns {{ items: CandidateItem[], duplicates: Array<{item: CandidateItem, duplicateOf: string}> }}
 */
export function aggregateCandidates(items: CandidateItem[], opts: AggregateOpts = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: [], duplicates: [] };
  }

  const threshold = opts.threshold ?? TITLE_SIMILARITY_THRESHOLD;
  const kept: CandidateItem[] = [];
  const duplicates: { item: CandidateItem; duplicateOf: string }[] = [];

  for (const item of items) {
    const titleTokens = tokenizeForSimilarity(item.title || '');
    let isDuplicate = false;

    for (const existing of kept) {
      const existingTokens = tokenizeForSimilarity(existing.title || '');
      const sim = jaccardSimilarity(titleTokens, existingTokens);
      if (sim >= threshold) {
        duplicates.push({ item, duplicateOf: existing.title });
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      kept.push(item);
    }
  }

  return { items: kept, duplicates };
}
