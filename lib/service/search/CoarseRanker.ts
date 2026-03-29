/**
 * CoarseRanker — 粗排器
 * 多维加权排序（Recall + Semantic + Freshness + Popularity）
 * Quality 维度保留但默认权重 0 — 待场景化区分后按需启用
 */

interface RankerCandidate {
  recallScore?: number;
  score?: number;
  semanticScore?: number;
  title?: string;
  code?: string;
  content?: string;
  description?: string;
  summary?: string;
  category?: string;
  language?: string;
  tags?: string[];
  updatedAt?: number | string;
  lastModified?: number | string;
  createdAt?: number | string;
  usageCount?: number;
  [key: string]: unknown;
}

export class CoarseRanker {
  #weights;

  constructor(
    options: {
      recallWeight?: number;
      semanticWeight?: number;
      qualityWeight?: number;
      freshnessWeight?: number;
      popularityWeight?: number;
    } = {}
  ) {
    this.#weights = {
      recall: options.recallWeight ?? 0.45,
      semantic: options.semanticWeight ?? 0.3,
      quality: options.qualityWeight ?? 0,
      freshness: options.freshnessWeight ?? 0.15,
      popularity: options.popularityWeight ?? 0.1,
    };
  }

  /**
   * 粗排
   * @param candidates 需有 recallScore、semanticScore 等字段
   * @returns sorted with coarseScore
   */
  rank(candidates: RankerCandidate[]) {
    if (!candidates || candidates.length === 0) {
      return [];
    }

    // 动态权重调整：semantic 不可用时将其权重按比例重分配给其他维度
    const hasSemanticScores = candidates.some((c: RankerCandidate) => (c.semanticScore || 0) > 0);
    const effectiveWeights = { ...this.#weights };
    if (!hasSemanticScores && effectiveWeights.semantic > 0) {
      const semWeight = effectiveWeights.semantic;
      const otherTotal = 1 - semWeight;
      if (otherTotal > 0) {
        for (const key of Object.keys(effectiveWeights)) {
          if (key !== 'semantic') {
            (effectiveWeights as Record<string, number>)[key] +=
              ((effectiveWeights as Record<string, number>)[key] / otherTotal) * semWeight;
          }
        }
      }
      effectiveWeights.semantic = 0;
    }

    // 召回分数 max-based 归一化（保留相对排序，避免 clamp 截断高分差异）
    const maxRecall =
      candidates.reduce(
        (m: number, c: RankerCandidate) => Math.max(m, c.recallScore || c.score || 0),
        0
      ) || 1;

    return candidates
      .map((c: RankerCandidate) => {
        const recall = Math.min((c.recallScore || c.score || 0) / maxRecall, 1.0);
        const semantic = this.#normalize(c.semanticScore || 0);
        const quality = this.#computeQuality(c);
        const freshness = this.#computeFreshness(c);
        const popularity = this.#computePopularity(c);

        const coarseScore =
          recall * effectiveWeights.recall +
          semantic * effectiveWeights.semantic +
          quality * effectiveWeights.quality +
          freshness * effectiveWeights.freshness +
          popularity * effectiveWeights.popularity;

        return {
          ...c,
          coarseScore,
          coarseSignals: { recall, semantic, quality, freshness, popularity },
        };
      })
      .sort((a, b) => b.coarseScore - a.coarseScore);
  }

  /**
   * E-E-A-T 质量评分
   * - 内容完整性 40%: 有 title + code + description
   * - 结构质量 30%: 有 category + language + tags
   * - 代码可读性 30%: 合理长度、有注释
   */
  #computeQuality(candidate: RankerCandidate) {
    let score = 0;

    // 内容完整性 (40%)
    const hasTitle = !!candidate.title;
    const hasCode = !!(candidate.code || candidate.content);
    const hasDesc = !!(candidate.description || candidate.summary);
    score += (hasTitle ? 0.15 : 0) + (hasCode ? 0.15 : 0) + (hasDesc ? 0.1 : 0);

    // 结构质量 (30%)
    const hasCat = !!candidate.category;
    const hasLang = !!candidate.language;
    const hasTags = Array.isArray(candidate.tags) && candidate.tags.length > 0;
    score += (hasCat ? 0.1 : 0) + (hasLang ? 0.1 : 0) + (hasTags ? 0.1 : 0);

    // 代码可读性 (30%)
    const code = candidate.code || candidate.content || '';
    const lines = code.split('\n').length;
    const hasComments = /\/\/|\/\*|#/.test(code);
    const reasonableLength = lines >= 3 && lines <= 500;
    score += (hasComments ? 0.15 : 0) + (reasonableLength ? 0.15 : 0);

    return Math.min(score, 1.0);
  }

  #computeFreshness(candidate: RankerCandidate) {
    const updated = candidate.updatedAt || candidate.lastModified || candidate.createdAt;
    if (!updated) {
      return 0.5;
    }
    // 自动识别秒级/毫秒级 Unix 时间戳 (秒级 ≤ 9999999999 即 2286 年)
    const ts =
      typeof updated === 'number' && updated > 0 && updated <= 9999999999
        ? updated * 1000
        : typeof updated === 'number'
          ? updated
          : new Date(updated).getTime();
    const ageDays = (Date.now() - ts) / 86400000;
    if (ageDays < 0) {
      return 1.0; // 未来时间戳视为最新
    }
    return Math.exp((-Math.LN2 * ageDays) / 180); // 半衰期 180 天
  }

  #computePopularity(candidate: RankerCandidate) {
    const usage = candidate.usageCount || 0;
    return usage > 0 ? Math.min(Math.log10(usage + 1) / 3, 1.0) : 0;
  }

  #normalize(value: number) {
    return Math.min(Math.max(value, 0), 1.0);
  }
}
