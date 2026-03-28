/**
 * DecayDetector — 知识衰退检测 + 评分
 *
 * 5 种衰退检测策略（任一满足即触发 decaying 转换）：
 *   1. daysSinceLastHit > 90 — 90 天无使用
 *   2. ruleFalsePositiveRate > 0.4 && triggers > 10 — 规则已不准
 *   3. ReverseGuard: coreCode 引用的 API 符号已删除
 *   4. 同域新 Recipe 发布且 deprecated_by 关系指向它
 *   5. ContradictionDetector: 与更新的 Recipe 硬矛盾
 *
 * 衰退评分 (decayScore 0-100):
 *   freshness(0.3) + usage(0.3) + quality(0.2) + authority(0.2)
 *
 *   80-100: 健康 → 不转换
 *   60-79:  关注 → Dashboard 警告
 *   40-59:  衰退 → active → decaying
 *   20-39:  严重 → Grace Period 缩短到 15d
 *   0-19:   死亡 → 跳过确认直接 deprecated
 */

import Logger from '../../infrastructure/logging/Logger.js';

import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';

/* ────────────────────── Types ────────────────────── */

interface DatabaseLike {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}

export interface DecaySignal {
  recipeId: string;
  strategy: DecayStrategy;
  detail: string;
}

export type DecayStrategy =
  | 'no_recent_usage'
  | 'high_false_positive'
  | 'symbol_drift'
  | 'superseded'
  | 'contradiction';

export interface DecayScoreResult {
  recipeId: string;
  title: string;
  decayScore: number;
  level: 'healthy' | 'watch' | 'decaying' | 'severe' | 'dead';
  signals: DecaySignal[];
  dimensions: {
    freshness: number;
    usage: number;
    quality: number;
    authority: number;
  };
  /** 建议的 Grace Period (ms)。severe=15d，dead=0 */
  suggestedGracePeriod: number;
}

interface RecipeForDecay {
  id: string;
  title: string;
  lifecycle: string;
  stats: string | null;
  quality_grade: string | null;
  quality_score: number | null;
  created_at: string | null;
}

/* ────────────────────── Constants ────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_PERIOD_STANDARD = 30 * DAY_MS;
const GRACE_PERIOD_SEVERE = 15 * DAY_MS;

const DECAY_THRESHOLDS = {
  /** 无使用天数上限 */
  NO_USAGE_DAYS: 90,
  /** FP 率上限 */
  FALSE_POSITIVE_RATE: 0.4,
  /** FP 率可靠性所需最少触发次数 */
  MIN_FP_TRIGGERS: 10,
};

const SCORE_WEIGHTS = {
  freshness: 0.3,
  usage: 0.3,
  quality: 0.2,
  authority: 0.2,
};

/* ────────────────────── Class ────────────────────── */

export class DecayDetector {
  #db: DatabaseLike;
  #signalBus: SignalBus | null;
  #logger = Logger.getInstance();

  constructor(db: DatabaseLike, options: { signalBus?: SignalBus } = {}) {
    this.#db = db;
    this.#signalBus = options.signalBus ?? null;
  }

  /**
   * 扫描所有 active 条目的衰退状态
   */
  scanAll(): DecayScoreResult[] {
    const recipes = this.#loadActiveRecipes();
    const results: DecayScoreResult[] = [];

    for (const recipe of recipes) {
      const result = this.evaluate(recipe);
      results.push(result);
    }

    // 发射衰退信号
    if (this.#signalBus) {
      for (const r of results) {
        if (r.level !== 'healthy') {
          this.#signalBus.send('decay', 'DecayDetector', 1 - r.decayScore / 100, {
            target: r.recipeId,
            metadata: {
              level: r.level,
              decayScore: r.decayScore,
              signals: r.signals.map((s) => s.strategy),
            },
          });
        }
      }
    }

    this.#logger.debug(
      `DecayDetector: scanned ${results.length} recipes, ${results.filter((r) => r.level !== 'healthy').length} need attention`
    );
    return results;
  }

  /**
   * 评估单条 Recipe 的衰退状态
   */
  evaluate(recipe: RecipeForDecay): DecayScoreResult {
    const stats = DecayDetector.#parseStats(recipe.stats);
    const signals: DecaySignal[] = [];
    const now = Date.now();

    // 策略 1: 90 天无使用
    const lastHitAt = stats.lastHitAt ?? null;
    if (lastHitAt) {
      const daysSince = (now - lastHitAt) / DAY_MS;
      if (daysSince > DECAY_THRESHOLDS.NO_USAGE_DAYS) {
        signals.push({
          recipeId: recipe.id,
          strategy: 'no_recent_usage',
          detail: `No usage in ${Math.round(daysSince)} days (threshold: ${DECAY_THRESHOLDS.NO_USAGE_DAYS}d)`,
        });
      }
    } else {
      // 无 lastHitAt，检查创建时间
      const createdAt = recipe.created_at ? new Date(recipe.created_at).getTime() : now;
      const daysSinceCreation = (now - createdAt) / DAY_MS;
      if (daysSinceCreation > DECAY_THRESHOLDS.NO_USAGE_DAYS) {
        signals.push({
          recipeId: recipe.id,
          strategy: 'no_recent_usage',
          detail: `Never used, created ${Math.round(daysSinceCreation)} days ago`,
        });
      }
    }

    // 策略 2: 高 FP 率
    const fpRate = stats.ruleFalsePositiveRate ?? 0;
    const triggers = stats.guardHits ?? 0;
    if (
      fpRate > DECAY_THRESHOLDS.FALSE_POSITIVE_RATE &&
      triggers >= DECAY_THRESHOLDS.MIN_FP_TRIGGERS
    ) {
      signals.push({
        recipeId: recipe.id,
        strategy: 'high_false_positive',
        detail: `FP rate ${(fpRate * 100).toFixed(0)}% with ${triggers} triggers (threshold: ${DECAY_THRESHOLDS.FALSE_POSITIVE_RATE * 100}%)`,
      });
    }

    // 策略 3: 符号漂移（由 ReverseGuard 提供，此处从 DB 查 drift 标记）
    if (this.#hasSymbolDrift(recipe.id)) {
      signals.push({
        recipeId: recipe.id,
        strategy: 'symbol_drift',
        detail: 'ReverseGuard detected symbol drift in coreCode',
      });
    }

    // 策略 4: 被取代（有 deprecated_by 关系指向更新版本）
    if (this.#isSuperseded(recipe.id)) {
      signals.push({
        recipeId: recipe.id,
        strategy: 'superseded',
        detail: 'Newer version exists via deprecated_by relation',
      });
    }

    // 计算 decayScore
    const dimensions = this.#computeScoreDimensions(stats, recipe);
    const decayScore = Math.round(
      dimensions.freshness * SCORE_WEIGHTS.freshness * 100 +
        dimensions.usage * SCORE_WEIGHTS.usage * 100 +
        dimensions.quality * SCORE_WEIGHTS.quality * 100 +
        dimensions.authority * SCORE_WEIGHTS.authority * 100
    );

    const level = DecayDetector.#scoreToLevel(decayScore);
    const suggestedGracePeriod =
      level === 'dead' ? 0 : level === 'severe' ? GRACE_PERIOD_SEVERE : GRACE_PERIOD_STANDARD;

    return {
      recipeId: recipe.id,
      title: recipe.title,
      decayScore,
      level,
      signals,
      dimensions,
      suggestedGracePeriod,
    };
  }

  /* ── Internal ── */

  #loadActiveRecipes(): RecipeForDecay[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT id, title, lifecycle, stats, quality_grade, quality_score, created_at
         FROM knowledge_entries
         WHERE lifecycle = 'active'`
        )
        .all();
      return rows.map((r) => ({
        id: r.id as string,
        title: r.title as string,
        lifecycle: r.lifecycle as string,
        stats: (r.stats as string) ?? null,
        quality_grade: (r.quality_grade as string) ?? null,
        quality_score: r.quality_score !== undefined ? Number(r.quality_score) : null,
        created_at: (r.created_at as string) ?? null,
      }));
    } catch {
      return [];
    }
  }

  static #parseStats(statsJson: string | null): Record<string, number | null> {
    if (!statsJson) {
      return {};
    }
    try {
      return JSON.parse(statsJson) as Record<string, number | null>;
    } catch {
      return {};
    }
  }

  #computeScoreDimensions(
    stats: Record<string, number | null>,
    recipe: RecipeForDecay
  ): { freshness: number; usage: number; quality: number; authority: number } {
    const now = Date.now();

    // freshness: days since last hit → 0-1 (0 = 365+ days, 1 = today)
    const lastHit = (stats.lastHitAt as number) ?? 0;
    const daysSinceHit = lastHit > 0 ? (now - lastHit) / DAY_MS : 365;
    const freshness = Math.max(0, 1 - daysSinceHit / 365);

    // usage: hitsLast90d 归一化 (0 = 0 hits, 1 = 50+ hits)
    const hitsLast90d = (stats.hitsLast90d as number) ?? 0;
    const usage = Math.min(1, hitsLast90d / 50);

    // quality: qualityScore 直接使用
    const quality = recipe.quality_score ?? 0.5;

    // authority: from stats.authority 归一化 (0-100 → 0-1)
    const authorityRaw = (stats.authority as number) ?? 50;
    const authority = Math.min(1, authorityRaw / 100);

    return { freshness, usage, quality, authority };
  }

  #hasSymbolDrift(recipeId: string): boolean {
    try {
      // 查找 audit_logs 中 ReverseGuard 为此 recipe 发过 drift 信号
      const row = this.#db
        .prepare(
          `SELECT 1 FROM audit_logs
         WHERE action LIKE '%ReverseGuard%'
           AND json_extract(details, '$.target') = ?
         LIMIT 1`
        )
        .get(recipeId);
      return !!row;
    } catch {
      return false;
    }
  }

  #isSuperseded(recipeId: string): boolean {
    try {
      const row = this.#db
        .prepare(
          `SELECT 1 FROM knowledge_edges
         WHERE source_id = ? AND relation_type = 'deprecated_by'
         LIMIT 1`
        )
        .get(recipeId);
      return !!row;
    } catch {
      return false;
    }
  }

  static #scoreToLevel(score: number): 'healthy' | 'watch' | 'decaying' | 'severe' | 'dead' {
    if (score >= 80) {
      return 'healthy';
    }
    if (score >= 60) {
      return 'watch';
    }
    if (score >= 40) {
      return 'decaying';
    }
    if (score >= 20) {
      return 'severe';
    }
    return 'dead';
  }
}
