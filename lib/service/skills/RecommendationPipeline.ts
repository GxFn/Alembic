/**
 * RecommendationPipeline — 统一推荐管线
 *
 * 多阶段处理:
 *   1. Recall  — 多策略并行召回候选 (Rule / AI / Vector / Popularity)
 *   2. Score   — 综合评分 (信号强度 × 用户偏好 × 新鲜度)
 *   3. Rank    — 排序 + 截断
 *   4. Filter  — 去重、过滤已有 Skill、过滤频繁忽略的类别
 *   5. Deliver — 输出最终推荐列表 + 触发 Hook
 *
 * 设计原则:
 *   - 静默降级: 任何策略失败不影响其他策略
 *   - 离线优先: 无 AI 时降级到规则召回
 *   - 反馈闪环: 利用 FeedbackStore 调整排序权重
 */

import Logger from '../../infrastructure/logging/Logger.js';
import type { FeedbackStore } from './FeedbackStore.js';
import type { SkillHooks } from './SkillHooks.js';
import type {
  RecallStrategy,
  RecommendationCandidate,
  RecommendationContext,
  ScoredRecommendation,
  UserPreference,
} from './types.js';

/** 最大召回超时 (ms) — 单个策略超时不阻塞整体 */
const RECALL_TIMEOUT_MS = 15_000;
/** 默认返回推荐数量 */
const DEFAULT_TOP_K = 5;

/** 生成唯一推荐 ID (不依赖外部库) */
function generateRecommendationId(): string {
  // crypto.randomUUID() — Node.js >=19 可用
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `rec_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }
  // fallback
  return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class RecommendationPipeline {
  readonly #strategies: RecallStrategy[] = [];
  readonly #feedbackStore: FeedbackStore | null;
  readonly #skillHooks: SkillHooks | null;
  readonly #logger: ReturnType<typeof Logger.getInstance>;

  constructor(
    opts: {
      feedbackStore?: FeedbackStore | null;
      skillHooks?: SkillHooks | null;
    } = {}
  ) {
    this.#feedbackStore = opts.feedbackStore ?? null;
    this.#skillHooks = opts.skillHooks ?? null;
    this.#logger = Logger.getInstance();
  }

  // ─── 策略管理 ──────────────────────────────────────────

  /** 注册召回策略 */
  addStrategy(strategy: RecallStrategy): void {
    this.#strategies.push(strategy);
    this.#logger.debug(`RecommendationPipeline: strategy "${strategy.name}" registered`);
  }

  /** 获取已注册策略列表 */
  getStrategies(): ReadonlyArray<RecallStrategy> {
    return this.#strategies;
  }

  // ─── 主管线 ────────────────────────────────────────────

  /**
   * 执行推荐管线
   *
   * @param context 推荐上下文
   * @param topK 最多返回数量
   * @returns 排序后的推荐结果列表
   */
  async recommend(
    context: RecommendationContext,
    topK: number = DEFAULT_TOP_K
  ): Promise<ScoredRecommendation[]> {
    // 注入用户偏好
    if (this.#feedbackStore && !context.userPreference) {
      context.userPreference = this.#feedbackStore.getUserPreference();
    }

    // ── 1. Recall: 多策略并行召回 ──
    const rawCandidates = await this.#recall(context);

    if (rawCandidates.length === 0) {
      return [];
    }

    // ── 2. Score: 综合评分 ──
    const scored = this.#score(rawCandidates, context);

    // ── 3. Rank: 排序 ──
    scored.sort((a, b) => b.score - a.score);

    // ── 4. Filter: 去重 + 过滤 ──
    const filtered = this.#filter(scored, context);

    // ── 5. Truncate + Deliver ──
    const results = filtered.slice(0, topK);

    // 触发 onRecommendation hook (waterfall: 允许 hook 修改结果)
    if (this.#skillHooks?.has('onRecommendation')) {
      try {
        const modified = await this.#skillHooks.run('onRecommendation', results, context);
        if (Array.isArray(modified)) {
          return modified as ScoredRecommendation[];
        }
      } catch (err: unknown) {
        this.#logger.warn('RecommendationPipeline: onRecommendation hook error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  // ─── 阶段 1: 召回 ─────────────────────────────────────

  async #recall(context: RecommendationContext): Promise<RecommendationCandidate[]> {
    const availableStrategies = this.#strategies.filter((s) => {
      try {
        return s.isAvailable(context);
      } catch {
        return false;
      }
    });

    if (availableStrategies.length === 0) {
      this.#logger.warn('RecommendationPipeline: no available recall strategies');
      return [];
    }

    // 并行召回 — 每个策略独立超时
    const results = await Promise.allSettled(
      availableStrategies.map((strategy) => this.#recallWithTimeout(strategy, context))
    );

    const candidates: RecommendationCandidate[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        candidates.push(...r.value);
        this.#logger.debug(
          `RecommendationPipeline: "${availableStrategies[i].name}" recalled ${r.value.length} candidates`
        );
      } else {
        this.#logger.warn(`RecommendationPipeline: "${availableStrategies[i].name}" failed`, {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }

    return candidates;
  }

  async #recallWithTimeout(
    strategy: RecallStrategy,
    context: RecommendationContext
  ): Promise<RecommendationCandidate[]> {
    return new Promise<RecommendationCandidate[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Strategy "${strategy.name}" timed out after ${RECALL_TIMEOUT_MS}ms`));
      }, RECALL_TIMEOUT_MS);

      strategy
        .recall(context)
        .then((results) => {
          clearTimeout(timer);
          resolve(results);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  // ─── 阶段 2: 评分 ─────────────────────────────────────

  #score(
    candidates: RecommendationCandidate[],
    context: RecommendationContext
  ): ScoredRecommendation[] {
    const preference = context.userPreference;

    return candidates.map((c) => {
      const signalScores: Record<string, number> = {};

      // 基础优先级分
      signalScores.priority = c.priority === 'high' ? 0.9 : c.priority === 'medium' ? 0.6 : 0.3;

      // 来源可信度分
      signalScores.sourceConfidence = this.#getSourceConfidence(c.source);

      // 用户偏好匹配分
      signalScores.userAffinity = this.#getUserAffinityScore(c, preference);

      // 综合得分: 加权平均
      const weights = { priority: 0.4, sourceConfidence: 0.3, userAffinity: 0.3 };
      const score =
        signalScores.priority * weights.priority +
        signalScores.sourceConfidence * weights.sourceConfidence +
        signalScores.userAffinity * weights.userAffinity;

      return {
        ...c,
        score: Math.max(0, Math.min(score, 1)),
        signalScores,
        recommendationId: generateRecommendationId(),
        generatedAt: new Date().toISOString(),
      };
    });
  }

  #getSourceConfidence(source: string): number {
    if (source.startsWith('ai:')) {
      return 0.8;
    }
    if (source.startsWith('rule:')) {
      return 0.7;
    }
    if (source.startsWith('vector:')) {
      return 0.6;
    }
    return 0.5;
  }

  #getUserAffinityScore(
    candidate: RecommendationCandidate,
    preference?: UserPreference | null
  ): number {
    if (!preference) {
      return 0.5; // 无偏好数据，中性分
    }

    let score = 0.5;

    // 来源偏好加分
    const sourceType = candidate.source.split(':')[1] ?? candidate.source;
    if (preference.preferredSources.includes(sourceType)) {
      score += 0.2;
    }

    // 避开类别降分 (通过 signals 中可能包含的 category 信息)
    const category = candidate.signals.category as string | undefined;
    if (category) {
      if (preference.preferredCategories.includes(category)) {
        score += 0.2;
      }
      if (preference.avoidedCategories.includes(category)) {
        score -= 0.3;
      }
    }

    return Math.max(0, Math.min(score, 1));
  }

  // ─── 阶段 3: 过滤 ─────────────────────────────────────

  #filter(scored: ScoredRecommendation[], context: RecommendationContext): ScoredRecommendation[] {
    const existingSet = context.existingSkills ?? new Set<string>();
    const seen = new Set<string>();
    const results: ScoredRecommendation[] = [];

    for (const rec of scored) {
      // 去重 (同名)
      if (seen.has(rec.name)) {
        continue;
      }

      // 已有 Skill 过滤
      if (existingSet.has(rec.name)) {
        continue;
      }

      // 频繁忽略的类别过滤
      const category = rec.signals.category as string | undefined;
      if (category && this.#feedbackStore?.isFrequentlyDismissed(category)) {
        continue;
      }

      // 低分过滤 (得分 < 0.2 的推荐丢弃)
      if (rec.score < 0.2) {
        continue;
      }

      seen.add(rec.name);
      results.push(rec);
    }

    return results;
  }
}

export default RecommendationPipeline;
