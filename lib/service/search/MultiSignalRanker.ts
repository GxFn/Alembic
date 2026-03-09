/**
 * MultiSignalRanker — 6 信号加权排序
 * Signals: relevance, authority, recency, popularity, difficulty, contextMatch
 * 不同场景使用不同权重配置（向后兼容旧配置中的 'seasonality' 键）
 */

interface SignalCandidate {
  bm25Score?: number;
  score?: number;
  title?: string;
  trigger?: string;
  content?: string;
  code?: string;
  qualityScore?: number;
  authorityScore?: number;
  usageCount?: number;
  updatedAt?: number | string;
  lastModified?: number | string;
  createdAt?: number | string;
  difficulty?: string;
  language?: string;
  category?: string;
  tags?: string[];
  [key: string]: unknown;
}

interface SignalContext {
  query?: string;
  scenario?: string;
  intent?: string;
  language?: string;
  category?: string;
  userLevel?: string;
  tags?: string[];
  [key: string]: unknown;
}

// 场景权重配置 (含 vectorScore 第 7 信号)
const SCENARIO_WEIGHTS = {
  lint: {
    relevance: 0.35,
    authority: 0.2,
    recency: 0.15,
    popularity: 0.1,
    difficulty: 0.05,
    contextMatch: 0.05,
    vector: 0.1,
  },
  generate: {
    relevance: 0.25,
    authority: 0.15,
    recency: 0.1,
    popularity: 0.15,
    difficulty: 0.1,
    contextMatch: 0.1,
    vector: 0.15,
  },
  search: {
    relevance: 0.2,
    authority: 0.15,
    recency: 0.1,
    popularity: 0.1,
    difficulty: 0.05,
    contextMatch: 0.1,
    vector: 0.3,
  },
  learning: {
    relevance: 0.15,
    authority: 0.1,
    recency: 0.05,
    popularity: 0.1,
    difficulty: 0.25,
    contextMatch: 0.2,
    vector: 0.15,
  },
  default: {
    relevance: 0.25,
    authority: 0.15,
    recency: 0.1,
    popularity: 0.1,
    difficulty: 0.1,
    contextMatch: 0.1,
    vector: 0.2,
  },
};

/**
 * 相关性信号 — BM25 + 标题匹配 + 内容匹配
 */
export class RelevanceSignal {
  compute(candidate: SignalCandidate, context: SignalContext) {
    let score = candidate.bm25Score || candidate.score || 0;
    const query = (context.query || '').toLowerCase();
    if (!query) {
      return Math.min(score, 1.0);
    }

    const title = (candidate.title || '').toLowerCase();
    const trigger = (candidate.trigger || '').toLowerCase();
    const content = (candidate.content || candidate.code || '').toLowerCase();

    // trigger 精确匹配 boost（最高优先级）
    if (trigger?.includes(query)) {
      score += 0.4;
    }
    // 标题精确匹配 boost
    if (title.includes(query)) {
      score += 0.3;
    }
    // 标题单词匹配
    const queryWords = query.split(/\s+/);
    const titleHits = queryWords.filter((w: string) => title.includes(w)).length;
    score += (titleHits / queryWords.length) * 0.2;
    // 内容匹配
    if (content.includes(query)) {
      score += 0.1;
    }

    return Math.min(score, 1.0);
  }
}

/**
 * 权威性信号 — 基于质量评分、使用次数、作者
 */
export class AuthoritySignal {
  compute(candidate: SignalCandidate) {
    let score = 0;
    if (candidate.qualityScore) {
      score += (candidate.qualityScore / 100) * 0.5;
    }
    if (candidate.authorityScore) {
      score += candidate.authorityScore * 0.3;
    }
    if ((candidate.usageCount ?? 0) > 0) {
      score += Math.min((candidate.usageCount ?? 0) / 100, 1) * 0.2;
    }
    return Math.min(score || 0.5, 1.0);
  }
}

/**
 * 时间衰减信号
 */
export class RecencySignal {
  compute(candidate: SignalCandidate) {
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
    const ageMs = Date.now() - ts;
    if (ageMs < 0) {
      return 1.0; // 未来时间戳视为最新
    }
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    // 指数衰减：半衰期 90 天
    return Math.exp((-Math.LN2 * ageDays) / 90);
  }
}

/**
 * 流行度信号 — 基于使用频次的对数缩放
 * usageCount 1 → 0.10, 10 → 0.37, 100 → 0.67, 1000+ → 1.0
 */
export class PopularitySignal {
  compute(candidate: SignalCandidate) {
    const usage = candidate.usageCount || 0;
    if (usage <= 0) {
      return 0;
    }
    // 对数缩放: log10(usage+1) / 3，上限 1.0
    return Math.min(Math.log10(usage + 1) / 3, 1.0);
  }
}

/**
 * 难度信号 — 用于学习场景的难度匹配
 */
export class DifficultySignal {
  compute(candidate: SignalCandidate, context: SignalContext) {
    const levels = { beginner: 1, intermediate: 2, advanced: 3, expert: 4 };
    const candidateLevel =
      (levels as Record<string, number>)[candidate.difficulty || 'intermediate'] || 2;
    const userLevel = (levels as Record<string, number>)[context.userLevel || 'intermediate'] || 2;
    // 难度匹配：越接近用户等级得分越高
    const diff = Math.abs(candidateLevel - userLevel);
    return Math.max(0, 1 - diff * 0.3);
  }
}

/**
 * 上下文匹配信号 — 语言/类别/标签与搜索上下文的匹配度
 * (原 SeasonalitySignal，重命名以准确反映实际语义)
 */
export class ContextMatchSignal {
  compute(candidate: SignalCandidate, context: SignalContext) {
    let score = 0;

    // 语言匹配（最强上下文信号）
    if (context.language && candidate.language) {
      if (candidate.language === context.language) {
        score += 0.4;
      } else if (_isRelatedLanguage(candidate.language, context.language)) {
        score += 0.15;
      }
    }

    // 类别匹配
    if (context.category && candidate.category === context.category) {
      score += 0.25;
    }

    // 标签重叠
    if ((context.tags?.length ?? 0) > 0 && (candidate.tags?.length ?? 0) > 0) {
      const ctxTags = new Set(context.tags!.map((t: string) => t.toLowerCase()));
      const hits = candidate.tags!.filter((t: string) => ctxTags.has(t.toLowerCase())).length;
      if (hits > 0) {
        score += 0.25 * Math.min(hits / ctxTags.size, 1);
      }
    }

    // 基线分 — 避免无上下文时信号全零
    return Math.max(score, 0.1);
  }
}

// 语言家族关系表 — 跨语言上下文匹配
const LANGUAGE_FAMILIES = {
  'objective-c': ['swift', 'c', 'c++'],
  swift: ['objective-c', 'c'],
  javascript: ['typescript', 'jsx', 'tsx'],
  typescript: ['javascript', 'jsx', 'tsx'],
  java: ['kotlin'],
  kotlin: ['java'],
  c: ['c++', 'objective-c'],
  'c++': ['c', 'objective-c'],
  python: ['cython'],
};

function _isRelatedLanguage(a: string, b: string) {
  const related = (LANGUAGE_FAMILIES as Record<string, string[]>)[a?.toLowerCase()] || [];
  return related.includes(b?.toLowerCase());
}

/**
 * 向量相似度信号 — 利用 VectorService 附加的 vectorScore
 * 当向量服务不可用时, vectorScore 为 0, 信号返回 0（权重自然归零）
 */
export class VectorSignal {
  compute(candidate: SignalCandidate, _context: SignalContext) {
    const vectorScore = (candidate as { vectorScore?: number }).vectorScore;
    if (typeof vectorScore === 'number' && vectorScore > 0) {
      return Math.min(vectorScore, 1.0);
    }
    return 0;
  }
}

/**
 * MultiSignalRanker — 多信号排序引擎
 */
export class MultiSignalRanker {
  #signals;
  #scenarioWeights;

  constructor(options: { scenarioWeights?: Record<string, Record<string, number>> } = {}) {
    this.#signals = {
      relevance: new RelevanceSignal(),
      authority: new AuthoritySignal(),
      recency: new RecencySignal(),
      popularity: new PopularitySignal(),
      difficulty: new DifficultySignal(),
      contextMatch: new ContextMatchSignal(),
      vector: new VectorSignal(),
    };
    // 合并自定义权重，支持旧配置中的 "seasonality" 键向后兼容
    const customWeights = options.scenarioWeights || {};
    const remapped: Record<string, Record<string, number>> = {};
    for (const [scenario, weights] of Object.entries(customWeights)) {
      remapped[scenario] = { ...(weights as Record<string, number>) };
      if ('seasonality' in remapped[scenario] && !('contextMatch' in remapped[scenario])) {
        remapped[scenario].contextMatch = remapped[scenario].seasonality;
        delete remapped[scenario].seasonality;
      }
    }
    this.#scenarioWeights = { ...SCENARIO_WEIGHTS, ...remapped };
  }

  /**
   * 对候选列表进行多信号加权排序
   * @param {Array} candidates
   * @param {object} context - { query, scenario, language, userLevel, ... }
   * @returns {Array} - sorted candidates with rankerScore
   */
  rank(candidates: SignalCandidate[], context: SignalContext = {}) {
    if (!candidates || candidates.length === 0) {
      return [];
    }

    const scenario = context.scenario || context.intent || 'default';
    const weights =
      (this.#scenarioWeights as Record<string, Record<string, number>>)[scenario] ||
      this.#scenarioWeights.default;

    const scored = candidates.map((candidate: SignalCandidate) => {
      const signals: Record<string, number> = {};
      let totalScore = 0;

      for (const [name, signal] of Object.entries(this.#signals)) {
        const value = (
          signal as { compute: (c: SignalCandidate, ctx: SignalContext) => number }
        ).compute(candidate, context);
        signals[name] = value;
        // 向后兼容: 旧配置可能用 "seasonality" 而非 "contextMatch"
        const weight = weights[name] ?? (name === 'contextMatch' ? (weights.seasonality ?? 0) : 0);
        totalScore += value * weight;
      }

      return {
        ...candidate,
        rankerScore: totalScore,
        signals,
      };
    });

    return scored.sort((a, b) => b.rankerScore - a.rankerScore);
  }
}
