/**
 * EvolutionPolicy — 进化决策规则集
 *
 * 纯函数，无 I/O，无副作用。
 * 所有阈值和分级逻辑集中在此，服务层只做编排。
 *
 * @module domain/evolution/EvolutionPolicy
 */

/* ═══ 类型 ═══ */

export type RiskTier = 'low' | 'medium' | 'high';

export type RelevanceVerdict = 'healthy' | 'watch' | 'decay' | 'severe' | 'dead';

export interface UpdateVerdict {
  pass: boolean;
  reason: string;
}

export interface DeprecateVerdict {
  action: 'deprecated' | 'decaying' | 'reject';
  reason: string;
}

/* ═══ 常量（集中定义） ═══ */

/** 观察窗口（毫秒） */
const OBSERVATION_WINDOWS: Record<RiskTier, number> = {
  low: 24 * 60 * 60 * 1000, // 24h
  medium: 72 * 60 * 60 * 1000, // 72h
  high: 7 * 24 * 60 * 60 * 1000, // 7d
};

/** Pending 自动过期天数 */
const PENDING_EXPIRY_DAYS = 14;

/** Update 执行阈值 */
const UPDATE_FP_THRESHOLD = 0.4;

/** Deprecate 死亡/严重阈值 */
const DECAY_DEAD_THRESHOLD = 19;
const DECAY_SEVERE_THRESHOLD = 40;
const DECAY_RECOVERY_DELTA = 10;

/** 相关性评分 → Verdict 分界线 */
const RELEVANCE_THRESHOLDS = {
  healthy: 80,
  watch: 60,
  decay: 40,
  severe: 20,
};

/** Verdict → 置信度 */
const RELEVANCE_CONFIDENCE: Record<string, number> = {
  dead: 0.95,
  severe: 0.6,
  decay: 0.4,
};

/** Auto-observe 阈值（与 ProposalRepository 一致） */
const AUTO_OBSERVE_THRESHOLDS: Record<string, number> = {
  update: 0.7,
  deprecate: 0.0,
};

/* ═══ 策略函数 ═══ */

export class EvolutionPolicy {
  /** 风险分级 */
  static assessRisk(
    action: 'update' | 'deprecate',
    confidence: number,
    _source?: string
  ): RiskTier {
    if (action === 'deprecate') {
      return 'high';
    }
    if (confidence >= 0.8) {
      return 'low';
    }
    return 'medium';
  }

  /** 观察窗口时长（毫秒） */
  static observationWindow(risk: RiskTier): number {
    return OBSERVATION_WINDOWS[risk];
  }

  /** 是否应立即执行（跳过 Proposal 观察） */
  static shouldImmediateExecute(action: string, confidence: number, source: string): boolean {
    return action === 'deprecate' && confidence >= 0.8 && source !== 'metabolism';
  }

  /** Proposal 创建时的初始状态 */
  static resolveInitialStatus(
    type: 'update' | 'deprecate',
    confidence: number
  ): 'pending' | 'observing' {
    const threshold = AUTO_OBSERVE_THRESHOLDS[type] ?? 0.7;
    return confidence >= threshold ? 'observing' : 'pending';
  }

  /** Update Proposal 到期评估 */
  static evaluateUpdate(metrics: {
    ruleFalsePositiveRate: number;
    guardHits: number;
    searchHits: number;
  }): UpdateVerdict {
    const fpOk = metrics.ruleFalsePositiveRate < UPDATE_FP_THRESHOLD;
    const hasUsage = metrics.guardHits > 0 || metrics.searchHits > 0;

    if (!fpOk) {
      return {
        pass: false,
        reason: `FP rate too high: ${(metrics.ruleFalsePositiveRate * 100).toFixed(0)}%`,
      };
    }
    if (!hasUsage) {
      return { pass: false, reason: 'no usage during observation' };
    }
    return { pass: true, reason: 'observation passed' };
  }

  /** Deprecate Proposal 到期评估 */
  static evaluateDeprecate(currentDecay: number, snapshotDecay: number): DeprecateVerdict {
    if (currentDecay > snapshotDecay + DECAY_RECOVERY_DELTA) {
      return {
        action: 'reject',
        reason: `decay recovered: ${snapshotDecay} → ${currentDecay}`,
      };
    }
    if (currentDecay <= DECAY_DEAD_THRESHOLD) {
      return { action: 'deprecated', reason: `dead: decayScore=${currentDecay}` };
    }
    if (currentDecay <= DECAY_SEVERE_THRESHOLD) {
      return { action: 'decaying', reason: `severe: decayScore=${currentDecay}` };
    }
    return { action: 'reject', reason: `decay slowed: decayScore=${currentDecay}` };
  }

  /** 相关性评分 → Verdict + 置信度 */
  static classifyRelevance(score: number): {
    verdict: RelevanceVerdict;
    confidence: number;
  } {
    if (score >= RELEVANCE_THRESHOLDS.healthy) {
      return { verdict: 'healthy', confidence: 0 };
    }
    if (score >= RELEVANCE_THRESHOLDS.watch) {
      return { verdict: 'watch', confidence: 0 };
    }
    if (score >= RELEVANCE_THRESHOLDS.decay) {
      return { verdict: 'decay', confidence: RELEVANCE_CONFIDENCE.decay };
    }
    if (score >= RELEVANCE_THRESHOLDS.severe) {
      return { verdict: 'severe', confidence: RELEVANCE_CONFIDENCE.severe };
    }
    return { verdict: 'dead', confidence: RELEVANCE_CONFIDENCE.dead };
  }

  /** Pending Proposal 是否应过期 */
  static shouldExpirePending(proposedAt: number, now: number): boolean {
    return now - proposedAt > PENDING_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  }
}
