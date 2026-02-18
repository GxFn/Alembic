/**
 * CoarseRanker — 粗排器
 * 基于 E-E-A-T 标准的 5 维加权排序（BM25 + Semantic + Quality + Freshness + Popularity）
 */

export class CoarseRanker {
  #weights;

  constructor(options = {}) {
    this.#weights = {
      bm25:       options.bm25Weight       ?? 0.30,
      semantic:   options.semanticWeight   ?? 0.30,
      quality:    options.qualityWeight    ?? 0.20,
      freshness:  options.freshnessWeight  ?? 0.10,
      popularity: options.popularityWeight ?? 0.10,
    };
  }

  /**
   * 粗排
   * @param {Array} candidates — 需有 bm25Score、semanticScore 等字段
   * @returns {Array} — sorted with coarseScore
   */
  rank(candidates) {
    if (!candidates || candidates.length === 0) return [];

    return candidates.map(c => {
      const bm25      = this.#normalize(c.bm25Score || c.score || 0);
      const semantic   = this.#normalize(c.semanticScore || 0);
      const quality    = this.#computeQuality(c);
      const freshness  = this.#computeFreshness(c);
      const popularity = this.#computePopularity(c);

      const coarseScore =
        bm25       * this.#weights.bm25 +
        semantic   * this.#weights.semantic +
        quality    * this.#weights.quality +
        freshness  * this.#weights.freshness +
        popularity * this.#weights.popularity;

      return { ...c, coarseScore, coarseSignals: { bm25, semantic, quality, freshness, popularity } };
    }).sort((a, b) => b.coarseScore - a.coarseScore);
  }

  /**
   * E-E-A-T 质量评分
   * - 内容完整性 40%: 有 title + code + description
   * - 结构质量 30%: 有 category + language + tags
   * - 代码可读性 30%: 合理长度、有注释
   */
  #computeQuality(candidate) {
    let score = 0;

    // 内容完整性 (40%)
    const hasTitle = !!candidate.title;
    const hasCode = !!(candidate.code || candidate.content);
    const hasDesc = !!(candidate.description || candidate.summary);
    score += (hasTitle ? 0.15 : 0) + (hasCode ? 0.15 : 0) + (hasDesc ? 0.10 : 0);

    // 结构质量 (30%)
    const hasCat = !!candidate.category;
    const hasLang = !!candidate.language;
    const hasTags = Array.isArray(candidate.tags) && candidate.tags.length > 0;
    score += (hasCat ? 0.10 : 0) + (hasLang ? 0.10 : 0) + (hasTags ? 0.10 : 0);

    // 代码可读性 (30%)
    const code = candidate.code || candidate.content || '';
    const lines = code.split('\n').length;
    const hasComments = /\/\/|\/\*|#/.test(code);
    const reasonableLength = lines >= 3 && lines <= 500;
    score += (hasComments ? 0.15 : 0) + (reasonableLength ? 0.15 : 0);

    return Math.min(score, 1.0);
  }

  #computeFreshness(candidate) {
    const updated = candidate.updatedAt || candidate.lastModified || candidate.createdAt;
    if (!updated) return 0.5;
    // 自动识别秒级/毫秒级 Unix 时间戳 (秒级 ≤ 9999999999 即 2286 年)
    const ts = typeof updated === 'number' && updated > 0 && updated <= 9999999999
      ? updated * 1000
      : (typeof updated === 'number' ? updated : new Date(updated).getTime());
    const ageDays = (Date.now() - ts) / 86400000;
    if (ageDays < 0) return 1.0; // 未来时间戳视为最新
    return Math.exp(-0.693 * ageDays / 180); // 半衰期 180 天
  }

  #computePopularity(candidate) {
    const usage = candidate.usageCount || 0;
    return usage > 0 ? Math.min(Math.log10(usage + 1) / 3, 1.0) : 0;
  }

  #normalize(value) {
    return Math.min(Math.max(value, 0), 1.0);
  }
}
