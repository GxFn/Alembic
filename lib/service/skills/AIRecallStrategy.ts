/**
 * AIRecallStrategy — 将 SignalCollector 的 AI 分析结果包装为 RecallStrategy 接口
 *
 * 读取 SignalCollector 的缓存快照中的 pendingSuggestions，
 * 转换为标准 RecommendationCandidate。
 *
 * 依赖 AI Provider，不可用时返回空数组。
 */

import type { RecallStrategy, RecommendationCandidate, RecommendationContext } from './types.js';

interface SignalCollectorLike {
  getSnapshot(): {
    pendingSuggestions?: Array<Record<string, unknown>>;
    lastAiSummary?: string;
  };
  getMode(): string;
}

export class AIRecallStrategy implements RecallStrategy {
  readonly name = 'ai';
  readonly type = 'ai' as const;

  #signalCollector: SignalCollectorLike | null;

  constructor(signalCollector: SignalCollectorLike | null) {
    this.#signalCollector = signalCollector;
  }

  async recall(context: RecommendationContext): Promise<RecommendationCandidate[]> {
    if (!this.#signalCollector) {
      return [];
    }

    const snapshot = this.#signalCollector.getSnapshot();
    const pending = snapshot.pendingSuggestions ?? [];
    const existingSet = context.existingSkills ?? new Set<string>();

    return pending
      .filter((s) => !existingSet.has(s.name as string))
      .map((s) => ({
        name: (s.name as string) || 'unknown',
        description: (s.description as string) || '',
        rationale: (s.rationale as string) || '',
        source: 'ai:signal_collector',
        priority: (s.priority as 'high' | 'medium' | 'low') || 'medium',
        signals: s,
        body: s.body as string | undefined,
      }));
  }

  isAvailable(context: RecommendationContext): boolean {
    if (!this.#signalCollector) {
      return false;
    }
    const mode = this.#signalCollector.getMode();
    // AI 策略只在 suggest/auto 模式下可用
    return mode === 'suggest' || mode === 'auto';
  }

  /**
   * 更新 SignalCollector 引用 (用于延迟注入)
   */
  setSignalCollector(sc: SignalCollectorLike) {
    this.#signalCollector = sc;
  }
}

export default AIRecallStrategy;
