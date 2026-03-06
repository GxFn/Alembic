/**
 * InvertedIndex — 倒排索引
 * 构建和查询 token → docIndex 映射
 */

// 使用 SearchEngine 的统一分词器（含完整 CJK 单字/bigram 支持）
// 确保倒排索引与 BM25 搜索使用一致的分词策略，避免中文查询召回率差异
import { tokenize } from './SearchEngine.js';
export { tokenize };

/**
 * 构建倒排索引
 * @param {Array<{ id: string, content: string }>} documents
 * @returns {Map<string, Set<number>>}
 */
export function buildInvertedIndex(documents) {
  const index = new Map();

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const text = [doc.title, doc.trigger, doc.content, doc.code, doc.description]
      .filter(Boolean)
      .join(' ');
    const tokens = tokenize(text);

    for (const token of tokens) {
      if (!index.has(token)) {
        index.set(token, new Set());
      }
      index.get(token).add(i);
    }
  }

  return index;
}

/**
 * 查询倒排索引（OR 语义 — 匹配任一 token）
 * @param {Map<string, Set<number>>} invertedIndex
 * @param {string} query
 * @returns {number[]} - document indices
 */
export function lookup(invertedIndex, query) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  const resultSet = new Set();
  for (const token of queryTokens) {
    const docs = invertedIndex.get(token);
    if (docs) {
      for (const docIdx of docs) {
        resultSet.add(docIdx);
      }
    }
  }

  return [...resultSet];
}

/**
 * 查询倒排索引（AND 语义 — 匹配所有 token）
 * @param {Map<string, Set<number>>} invertedIndex
 * @param {string} query
 * @returns {number[]}
 */
export function lookupAll(invertedIndex, query) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  let result: any = null;
  for (const token of queryTokens) {
    const docs = invertedIndex.get(token);
    if (!docs) {
      return [];
    }
    if (result === null) {
      result = new Set(docs);
    } else {
      for (const idx of result) {
        if (!docs.has(idx)) {
          result.delete(idx);
        }
      }
    }
  }

  return result ? [...result] : [];
}
