/**
 * MultiSignalRanker — 6 信号加权排序
 * Signals: relevance, authority, recency, popularity, difficulty, seasonality
 * 不同场景使用不同权重配置
 */

// 场景权重配置
const SCENARIO_WEIGHTS = {
  lint:     { relevance: 0.40, authority: 0.25, recency: 0.15, popularity: 0.10, difficulty: 0.05, seasonality: 0.05 },
  generate: { relevance: 0.30, authority: 0.20, recency: 0.10, popularity: 0.20, difficulty: 0.10, seasonality: 0.10 },
  search:   { relevance: 0.30, authority: 0.20, recency: 0.15, popularity: 0.15, difficulty: 0.10, seasonality: 0.10 },
  learning: { relevance: 0.20, authority: 0.15, recency: 0.05, popularity: 0.10, difficulty: 0.30, seasonality: 0.20 },
  default:  { relevance: 0.30, authority: 0.20, recency: 0.15, popularity: 0.15, difficulty: 0.10, seasonality: 0.10 },
};

/**
 * 相关性信号 — BM25 + 标题匹配 + 内容匹配
 */
export class RelevanceSignal {
  compute(candidate, context) {
    let score = candidate.bm25Score || candidate.score || 0;
    const query = (context.query || '').toLowerCase();
    if (!query) return Math.min(score, 1.0);

    const title = (candidate.title || '').toLowerCase();
    const trigger = (candidate.trigger || '').toLowerCase();
    const content = (candidate.content || candidate.code || '').toLowerCase();

    // trigger 精确匹配 boost（最高优先级）
    if (trigger && trigger.includes(query)) score += 0.4;
    // 标题精确匹配 boost
    if (title.includes(query)) score += 0.3;
    // 标题单词匹配
    const queryWords = query.split(/\s+/);
    const titleHits = queryWords.filter(w => title.includes(w)).length;
    score += (titleHits / queryWords.length) * 0.2;
    // 内容匹配
    if (content.includes(query)) score += 0.1;

    return Math.min(score, 1.0);
  }
}

/**
 * 权威性信号 — 基于质量评分、使用次数、作者
 */
export class AuthoritySignal {
  compute(candidate) {
    let score = 0;
    if (candidate.qualityScore) score += (candidate.qualityScore / 100) * 0.5;
    if (candidate.authorityScore) score += candidate.authorityScore * 0.3;
    if (candidate.usageCount > 0) score += Math.min(candidate.usageCount / 100, 1) * 0.2;
    return Math.min(score || 0.5, 1.0);
  }
}

/**
 * 时间衰减信号
 */
export class RecencySignal {
  compute(candidate) {
    const updated = candidate.updatedAt || candidate.lastModified || candidate.createdAt;
    if (!updated) return 0.5;
    // 自动识别秒级/毫秒级 Unix 时间戳 (秒级 ≤ 9999999999 即 2286 年)
    const ts = typeof updated === 'number' && updated > 0 && updated <= 9999999999
      ? updated * 1000
      : (typeof updated === 'number' ? updated : new Date(updated).getTime());
    const ageMs = Date.now() - ts;
    if (ageMs < 0) return 1.0; // 未来时间戳视为最新
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    // 指数衰减：半衰期 90 天
    return Math.exp(-0.693 * ageDays / 90);
  }
}

/**
 * 流行度信号 — 使用频次 + CTR
 */
export class PopularitySignal {
  compute(candidate) {
    const usage = candidate.usageCount || 0;
    const ctr = candidate.ctr || 0;
    // 对数缩放
    const usageScore = usage > 0 ? Math.log10(usage + 1) / 3 : 0;
    return Math.min(usageScore * 0.7 + ctr * 0.3, 1.0);
  }
}

/**
 * 难度信号 — 用于学习场景的难度匹配
 */
export class DifficultySignal {
  compute(candidate, context) {
    const levels = { beginner: 1, intermediate: 2, advanced: 3, expert: 4 };
    const candidateLevel = levels[candidate.difficulty || 'intermediate'] || 2;
    const userLevel = levels[context.userLevel || 'intermediate'] || 2;
    // 难度匹配：越接近用户等级得分越高
    const diff = Math.abs(candidateLevel - userLevel);
    return Math.max(0, 1 - diff * 0.3);
  }
}

/**
 * 季节性信号 — 基于标签/上下文的时效性
 */
export class SeasonalitySignal {
  compute(candidate, context) {
    // 简单实现：语言/框架匹配加分
    if (context.language && candidate.language === context.language) return 0.8;
    if (context.category && candidate.category === context.category) return 0.6;
    return 0.5;
  }
}

/**
 * MultiSignalRanker — 多信号排序引擎
 */
export class MultiSignalRanker {
  #signals;
  #scenarioWeights;

  constructor(options = {}) {
    this.#signals = {
      relevance:   new RelevanceSignal(),
      authority:   new AuthoritySignal(),
      recency:     new RecencySignal(),
      popularity:  new PopularitySignal(),
      difficulty:  new DifficultySignal(),
      seasonality: new SeasonalitySignal(),
    };
    this.#scenarioWeights = { ...SCENARIO_WEIGHTS, ...options.scenarioWeights };
  }

  /**
   * 对候选列表进行多信号加权排序
   * @param {Array} candidates
   * @param {object} context — { query, scenario, language, userLevel, ... }
   * @returns {Array} — sorted candidates with rankerScore
   */
  rank(candidates, context = {}) {
    if (!candidates || candidates.length === 0) return [];

    const scenario = context.scenario || context.intent || 'default';
    const weights = this.#scenarioWeights[scenario] || this.#scenarioWeights.default;

    const scored = candidates.map(candidate => {
      const signals = {};
      let totalScore = 0;

      for (const [name, signal] of Object.entries(this.#signals)) {
        const value = signal.compute(candidate, context);
        signals[name] = value;
        totalScore += value * (weights[name] || 0);
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
