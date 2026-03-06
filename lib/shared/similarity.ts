/**
 * similarity — 统一相似度计算工具
 *
 * 项目内所有文本/向量相似度计算统一使用此模块：
 *   - jaccardSimilarity: 基于 token 集合的 Jaccard 系数
 *   - cosineSimilarity:  向量余弦相似度
 *   - textSimilarity:    高层文本相似度（Jaccard + 可选子串加分）
 *   - tokenizeForSimilarity: 通用 bigram 分词（面向相似度场景）
 *
 * @module shared/similarity
 */

/**
 * 通用 bigram 分词 — 面向相似度计算
 *
 * 将文本小写化、去标点后，生成 word + character n-gram 集合。
 * 同时支持 CJK（单字 + bigram）和英文（整词 + bigram）。
 *
 * @param {string} text 原始文本
 * @param {number} [n=2] - n-gram 长度
 * @returns {Set<string>} token 集合
 */
export function tokenizeForSimilarity(text, n = 2) {
  if (!text) {
    return new Set();
  }
  const lower = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf]+/g, ' ')
    .trim();
  const tokens = new Set();
  const words = lower.split(/\s+/);
  for (const w of words) {
    if (w.length >= n) {
      tokens.add(w);
    }
    for (let i = 0; i <= w.length - n; i++) {
      tokens.add(w.slice(i, i + n));
    }
  }
  return tokens;
}

/**
 * Jaccard 相似度 — |A ∩ B| / |A ∪ B|
 *
 * @param {Set<string>} a - token 集合 A
 * @param {Set<string>} b - token 集合 B
 * @returns {number} 0.0 - 1.0
 */
export function jaccardSimilarity(a, b) {
  if ((!a || a.size === 0) && (!b || b.size === 0)) {
    return 0;
  }
  if (!a || a.size === 0 || !b || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const t of smaller) {
    if (larger.has(t)) {
      intersection++;
    }
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * 余弦相似度 — 向量点积 / (||a|| * ||b||)
 *
 * @param {number[]} a 向量 A
 * @param {number[]} b 向量 B
 * @returns {number} 0.0 - 1.0（输入均为正值时）
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dotProduct = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dotProduct / denom : 0;
}

/**
 * 高层文本相似度 — Jaccard + 可选子串包含加分
 *
 * @param {string} textA 文本 A
 * @param {string} textB 文本 B
 * @param {object} [opts]
 * @param {number} [opts.n=2] - n-gram 长度
 * @param {boolean} [opts.substringBonus=false] 是否启用子串包含加分 (+0.3)
 * @returns {number} 0.0 - 1.0
 */
export function textSimilarity(textA, textB, opts: any = {}) {
  const { n = 2, substringBonus = false } = opts;
  const tokensA = tokenizeForSimilarity(textA, n);
  const tokensB = tokenizeForSimilarity(textB, n);
  let sim = jaccardSimilarity(tokensA, tokensB);

  if (substringBonus) {
    const lowerA = (textA || '').toLowerCase();
    const lowerB = (textB || '').toLowerCase();
    if (lowerA && lowerB && (lowerA.includes(lowerB) || lowerB.includes(lowerA))) {
      sim = Math.min(1.0, sim + 0.3);
    }
  }

  return sim;
}
