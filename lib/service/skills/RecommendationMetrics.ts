/**
 * RecommendationMetrics — 推荐效果度量追踪
 *
 * 追踪推荐系统的关键指标:
 *   - 展示次数 (display)
 *   - 查看次数 (view)
 *   - 采纳次数 (adopt)
 *   - 忽略次数 (dismiss)
 *   - 采纳率 = adopt / (adopt + dismiss)
 *   - CTR = view / display
 *
 * 所有数据委托给 FeedbackStore 持久化。
 * 本类只负责实时聚合 + 对外暴露接口。
 */

import Logger from '../../infrastructure/logging/Logger.js';
import type { FeedbackStore } from './FeedbackStore.js';
import type { RecommendationMetricsSnapshot, ScoredRecommendation } from './types.js';

interface MetricsCounters {
  displayed: number;
  viewed: number;
  adopted: number;
  dismissed: number;
  expired: number;
}

export class RecommendationMetrics {
  readonly #feedbackStore: FeedbackStore;
  readonly #logger: ReturnType<typeof Logger.getInstance>;

  /** 内存计数器 — 只追踪本次进程的增量 */
  #session: MetricsCounters = {
    displayed: 0,
    viewed: 0,
    adopted: 0,
    dismissed: 0,
    expired: 0,
  };

  constructor(feedbackStore: FeedbackStore) {
    this.#feedbackStore = feedbackStore;
    this.#logger = Logger.getInstance();
  }

  // ─── 事件记录 ──────────────────────────────────────────

  /**
   * 记录推荐已展示 (dashboard/MCP 返回推荐列表时调用)
   */
  trackDisplayed(recommendations: ScoredRecommendation[]): void {
    this.#session.displayed += recommendations.length;

    // 记录 viewed 事件到 FeedbackStore (展示即视为曝光)
    for (const rec of recommendations) {
      this.#feedbackStore
        .record({
          recommendationId: rec.recommendationId,
          action: 'viewed',
          timestamp: new Date().toISOString(),
          source: rec.source,
          category: rec.signals.category as string | undefined,
        })
        .catch((err: unknown) => {
          this.#logger.warn('RecommendationMetrics: failed to record viewed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  /**
   * 记录推荐被采纳
   */
  async trackAdopted(recommendationId: string, source?: string, category?: string): Promise<void> {
    this.#session.adopted++;
    await this.#feedbackStore.record({
      recommendationId,
      action: 'adopted',
      timestamp: new Date().toISOString(),
      source,
      category,
    });
  }

  /**
   * 记录推荐被忽略
   */
  async trackDismissed(
    recommendationId: string,
    reason?: string,
    source?: string,
    category?: string
  ): Promise<void> {
    this.#session.dismissed++;
    await this.#feedbackStore.record({
      recommendationId,
      action: 'dismissed',
      timestamp: new Date().toISOString(),
      source,
      category,
      reason,
    });
  }

  /**
   * 记录推荐过期
   */
  async trackExpired(recommendationId: string, source?: string): Promise<void> {
    this.#session.expired++;
    await this.#feedbackStore.record({
      recommendationId,
      action: 'expired',
      timestamp: new Date().toISOString(),
      source,
    });
  }

  // ─── 查询 ──────────────────────────────────────────────

  /**
   * 获取当前会话的指标
   */
  getSessionMetrics(): MetricsCounters & { adoptionRate: number; ctr: number } {
    const s = this.#session;
    const decisionTotal = s.adopted + s.dismissed;
    return {
      ...s,
      adoptionRate: decisionTotal > 0 ? s.adopted / decisionTotal : 0,
      ctr: s.displayed > 0 ? s.viewed / s.displayed : 0,
    };
  }

  /**
   * 获取全局指标快照 (含持久化历史)
   */
  getGlobalSnapshot(since?: Date): RecommendationMetricsSnapshot {
    return this.#feedbackStore.getMetricsSnapshot(since);
  }

  /**
   * 获取指定来源的采纳率
   */
  getAdoptionRateBySource(source: string): number {
    return this.#feedbackStore.getAdoptionRate(source);
  }
}

export default RecommendationMetrics;
