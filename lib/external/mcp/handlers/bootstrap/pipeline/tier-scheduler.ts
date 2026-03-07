/**
 * TierScheduler.js — 维度分层并行调度器
 *
 * 内部 Agent 和外部 Agent 共享此调度模型。
 * 按维度间信息依赖关系分 3 层执行:
 * - Tier 1: 基础数据层 (project-profile, 语言条件扫描) — 可并行
 * - Tier 2: 规范+架构+模式 (code-standard, architecture, code-pattern) — 依赖 Tier 1
 * - Tier 3: 流转+实践+总结 (event-and-data-flow, best-practice, agent-guidelines) — 依赖 Tier 2
 *
 * 每层内部可并行 (受 concurrency 限制)，层间串行。
 * 未在任何 Tier 中定义的维度会自动归入 Tier 1（并行执行）。
 *
 * 调用方:
 *   - orchestrator.js (内部 Agent) — fillDimensionsV3() 按 Tier 分层调度 AI pipeline
 *   - MissionBriefingBuilder.js (外部 Agent) — executionPlan 中的 Tier 层序展示
 *
 * @module TierScheduler
 */

import Logger from '#infra/logging/Logger.js';
import { createLimit } from '#shared/concurrency.js';

const logger = Logger.getInstance();

// ──────────────────────────────────────────────────────────────────
// 分层定义
// ──────────────────────────────────────────────────────────────────

const DEFAULT_TIERS = [
  // Tier 1: 基础数据（通用 + 语言条件维度并行执行）
  [
    'project-profile',
    'objc-deep-scan',
    'category-scan',
    'module-export-scan',
    'framework-convention-scan',
    'python-package-scan',
    'jvm-annotation-scan',
  ],
  // Tier 2: 规范+架构+模式
  ['code-standard', 'architecture', 'code-pattern'],
  // Tier 3: 流转+实践+总结
  ['event-and-data-flow', 'best-practice', 'agent-guidelines'],
];

/** Dimension execution result */
interface DimensionResult {
  error?: string;
  candidateCount?: number;
  [key: string]: unknown;
}

/** Options for TierScheduler.execute() */
interface TierExecuteOptions {
  concurrency?: number;
  onTierComplete?: (tierIndex: number, tierResults: Map<string, DimensionResult>) => void;
  shouldAbort?: () => boolean;
  activeDimIds?: string[];
  tierHints?: Record<string, number>;
}

// ──────────────────────────────────────────────────────────────────
// TierScheduler
// ──────────────────────────────────────────────────────────────────

export class TierScheduler {
  /** @type {string[][]} */
  #tiers;

  /**
   * @param {string[][]} [tiers] 自定义分层 (默认使用 DEFAULT_TIERS)
   */
  constructor(tiers = DEFAULT_TIERS) {
    this.#tiers = tiers;
  }

  /**
   * 分层执行维度
   *
   * @param {Function} executeDimension - async (dimId) => DimensionResult
   * @param {object} [options]
   * @param {number} [options.concurrency=3] - Tier 内最大并行数
   * @param {Function} [options.onTierComplete] - (tierIndex, tierResults) => void
   * @param {Function} [options.shouldAbort] - () => boolean 外部中止信号
   * @param {string[]} [options.activeDimIds] 实际要执行的维度 ID 列表（过滤不在列表中的维度）
   * @param {Record<string, number>} [options.tierHints] - dimId → 1-based tier index（Enhancement Pack 维度声明的首选 Tier）
   * @returns {Promise<Map<string, any>>} - dimId → result
   */
  async execute(
    executeDimension: (dimId: string) => Promise<DimensionResult>,
    options: TierExecuteOptions = {}
  ) {
    const { concurrency = 3, onTierComplete, shouldAbort, activeDimIds, tierHints } = options;
    const results = new Map();

    // 如果提供了 activeDimIds，根据它构建实际要执行的 tiers
    // 未在任何 tier 中定义的维度: 优先使用 tierHints 归入指定 Tier，否则默认归入 Tier 1
    let effectiveTiers = this.#tiers;
    if (activeDimIds) {
      const activeSet = new Set(activeDimIds);
      const scheduled = new Set(this.#tiers.flat());
      const unscheduled = activeDimIds.filter((id: string) => !scheduled.has(id));
      effectiveTiers = this.#tiers.map((tier) => tier.filter((id) => activeSet.has(id)));
      if (unscheduled.length > 0) {
        // 按 tierHint 分配到对应 Tier，无 hint 的默认归入 Tier 1
        const byTier = new Map(); // 0-based tier index → dimId[]
        for (const id of unscheduled) {
          const hint = tierHints?.[id];
          const tierIdx =
            typeof hint === 'number' && hint >= 1 && hint <= effectiveTiers.length ? hint - 1 : 0;
          if (!byTier.has(tierIdx)) {
            byTier.set(tierIdx, []);
          }
          byTier.get(tierIdx).push(id);
        }
        for (const [tierIdx, ids] of byTier) {
          effectiveTiers[tierIdx] = [...effectiveTiers[tierIdx], ...ids];
        }
        logger.info(
          `[TierScheduler] Unscheduled dims distributed: ${[...byTier.entries()].map(([t, ids]) => `Tier ${t + 1}=[${ids.join(', ')}]`).join(', ')}`
        );
      }
      // 移除空 tier
      effectiveTiers = effectiveTiers.filter((t) => t.length > 0);
    }

    for (let tierIndex = 0; tierIndex < effectiveTiers.length; tierIndex++) {
      const tier = effectiveTiers[tierIndex];

      if (shouldAbort?.()) {
        logger.warn(`[TierScheduler] Aborted before Tier ${tierIndex + 1}`);
        break;
      }

      logger.info(
        `[TierScheduler] ── Tier ${tierIndex + 1}/${this.#tiers.length}: [${tier.join(', ')}] (concurrency=${concurrency})`
      );

      const tierResults = await this.#executeTier(tier, executeDimension, concurrency, shouldAbort);

      for (const [dimId, result] of tierResults) {
        results.set(dimId, result);
      }

      onTierComplete?.(tierIndex, tierResults);
    }

    return results;
  }

  /**
   * 执行单个 Tier 内的所有维度 (p-limit 并发控制)
   */
  async #executeTier(
    dimensionIds: string[],
    executeDimension: (dimId: string) => Promise<DimensionResult>,
    concurrency: number,
    shouldAbort: (() => boolean) | undefined
  ) {
    const limit = createLimit(concurrency);
    const results = new Map();

    await Promise.all(
      dimensionIds.map((dimId: string) =>
        limit(async () => {
          if (shouldAbort?.()) {
            return;
          }
          try {
            const result = await executeDimension(dimId);
            results.set(dimId, result);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`[TierScheduler] Dimension "${dimId}" failed: ${errMsg}`);
            results.set(dimId, { error: errMsg, candidateCount: 0 });
          }
        })
      )
    );

    return results;
  }

  /**
   * 获取维度所在的 Tier 索引
   * @param {string} dimId
   * @returns {number} - 0-based tier index, -1 if not found
   */
  getTierIndex(dimId: string) {
    for (let i = 0; i < this.#tiers.length; i++) {
      if (this.#tiers[i].includes(dimId)) {
        return i;
      }
    }
    return -1;
  }

  /**
   * 获取分层定义
   * @returns {string[][]}
   */
  getTiers() {
    return this.#tiers;
  }
}

export default TierScheduler;
