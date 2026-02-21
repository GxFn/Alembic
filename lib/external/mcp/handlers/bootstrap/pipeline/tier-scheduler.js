/**
 * TierScheduler.js — 维度分层并行调度器
 *
 * 按维度间信息依赖关系分 3 层执行:
 * - Tier 1: 基础数据层 (project-profile, 语言条件扫描) — 可并行
 * - Tier 2: 规范+架构+模式 (code-standard, architecture, code-pattern) — 依赖 Tier 1
 * - Tier 3: 流转+实践+总结 (event-and-data-flow, best-practice, agent-guidelines) — 依赖 Tier 2
 *
 * 每层内部可并行 (受 concurrency 限制)，层间串行。
 * 未在任何 Tier 中定义的维度会自动归入 Tier 1（并行执行）。
 *
 * @module TierScheduler
 */

import Logger from '../../../../../infrastructure/logging/Logger.js';

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

// ──────────────────────────────────────────────────────────────────
// 简单信号量 (控制并发)
// ──────────────────────────────────────────────────────────────────

class Semaphore {
  #permits;
  #queue = [];

  constructor(permits) {
    this.#permits = permits;
  }

  async acquire() {
    if (this.#permits > 0) {
      this.#permits--;
      return;
    }
    return new Promise((resolve) => {
      this.#queue.push(resolve);
    });
  }

  release() {
    if (this.#queue.length > 0) {
      const resolve = this.#queue.shift();
      resolve();
    } else {
      this.#permits++;
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// TierScheduler
// ──────────────────────────────────────────────────────────────────

export class TierScheduler {
  /** @type {string[][]} */
  #tiers;

  /**
   * @param {string[][]} [tiers] — 自定义分层 (默认使用 DEFAULT_TIERS)
   */
  constructor(tiers = DEFAULT_TIERS) {
    this.#tiers = tiers;
  }

  /**
   * 分层执行维度
   *
   * @param {Function} executeDimension — async (dimId) => DimensionResult
   * @param {object} [options]
   * @param {number} [options.concurrency=3] — Tier 内最大并行数
   * @param {Function} [options.onTierComplete] — (tierIndex, tierResults) => void
   * @param {Function} [options.shouldAbort] — () => boolean — 外部中止信号
   * @param {string[]} [options.activeDimIds] — 实际要执行的维度 ID 列表（过滤不在列表中的维度）
   * @returns {Promise<Map<string, any>>} — dimId → result
   */
  async execute(executeDimension, options = {}) {
    const { concurrency = 3, onTierComplete, shouldAbort, activeDimIds } = options;
    const results = new Map();

    // 如果提供了 activeDimIds，根据它构建实际要执行的 tiers
    // 未在任何 tier 中定义的维度追加到 Tier 1
    let effectiveTiers = this.#tiers;
    if (activeDimIds) {
      const activeSet = new Set(activeDimIds);
      const scheduled = new Set(this.#tiers.flat());
      const unscheduled = activeDimIds.filter((id) => !scheduled.has(id));
      effectiveTiers = this.#tiers.map((tier) => tier.filter((id) => activeSet.has(id)));
      if (unscheduled.length > 0) {
        // 动态维度（Enhancement Pack 追加的）归入 Tier 1
        effectiveTiers[0] = [...effectiveTiers[0], ...unscheduled];
        logger.info(
          `[TierScheduler] Unscheduled dims added to Tier 1: [${unscheduled.join(', ')}]`
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
   * 执行单个 Tier 内的所有维度 (并发控制)
   */
  async #executeTier(dimensionIds, executeDimension, concurrency, shouldAbort) {
    const semaphore = new Semaphore(concurrency);
    const results = new Map();

    await Promise.all(
      dimensionIds.map(async (dimId) => {
        if (shouldAbort?.()) {
          return;
        }

        await semaphore.acquire();
        try {
          if (shouldAbort?.()) {
            return;
          }
          const result = await executeDimension(dimId);
          results.set(dimId, result);
        } catch (err) {
          logger.error(`[TierScheduler] Dimension "${dimId}" failed: ${err.message}`);
          results.set(dimId, { error: err.message, candidateCount: 0 });
        } finally {
          semaphore.release();
        }
      })
    );

    return results;
  }

  /**
   * 获取维度所在的 Tier 索引
   * @param {string} dimId
   * @returns {number} — 0-based tier index, -1 if not found
   */
  getTierIndex(dimId) {
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
