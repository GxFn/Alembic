/**
 * StagingManager — staging Grace Period 管理 + 自动发布
 *
 * 核心职责：
 *   1. 条目进入 staging 后记录 deadline
 *   2. 定时检查：deadline 到期 + 无异议 → 自动转 active
 *   3. 异常回滚：Guard 检测到冲突 → 回滚到 pending
 *   4. 发射信号通知 Dashboard
 *
 * 分级 Grace Period（由 ConfidenceRouter 决定）：
 *   ≥ 0.90 → 24h
 *   0.85-0.89 → 72h
 */

import Logger from '../../infrastructure/logging/Logger.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import { unixNow } from '../../shared/utils/common.js';

/* ────────────────────── Types ────────────────────── */

export interface StagingEntry {
  id: string;
  title: string;
  stagingDeadline: number;
  confidence: number;
}

export interface StagingCheckResult {
  promoted: StagingEntry[];
  rolledBack: StagingEntry[];
  waiting: StagingEntry[];
}

/* ────────────────────── Class ────────────────────── */

export class StagingManager {
  #knowledgeRepo: KnowledgeRepositoryImpl;
  #signalBus: SignalBus | null;
  #logger = Logger.getInstance();

  constructor(knowledgeRepo: KnowledgeRepositoryImpl, options: { signalBus?: SignalBus } = {}) {
    this.#knowledgeRepo = knowledgeRepo;
    this.#signalBus = options.signalBus ?? null;
  }

  /**
   * 将条目推入 staging 状态并记录 deadline
   */
  async enterStaging(entryId: string, gracePeriodMs: number, confidence: number): Promise<boolean> {
    const now = Date.now();
    const deadline = now + gracePeriodMs;

    const entry = await this.#knowledgeRepo.findById(entryId);

    if (!entry) {
      this.#logger.warn(`StagingManager: entry not found: ${entryId}`);
      return false;
    }

    if (entry.lifecycle !== 'pending') {
      this.#logger.warn(`StagingManager: entry ${entryId} is "${entry.lifecycle}", not pending`);
      return false;
    }

    await this.#knowledgeRepo.update(entryId, {
      lifecycle: 'staging',
      stagingDeadline: deadline,
    } as unknown as Record<string, unknown>);

    if (this.#signalBus) {
      this.#signalBus.send('lifecycle', 'StagingManager.enter', confidence, {
        target: entryId,
        metadata: {
          action: 'enter_staging',
          deadline,
          gracePeriodMs,
          title: entry.title,
        },
      });
    }

    this.#logger.info(
      `StagingManager: ${entry.title} → staging (deadline: ${new Date(deadline).toISOString()})`
    );
    return true;
  }

  /**
   * 检查所有 staging 条目，执行自动发布或回滚
   */
  async checkAndPromote(): Promise<StagingCheckResult> {
    const now = Date.now();
    const result: StagingCheckResult = { promoted: [], rolledBack: [], waiting: [] };

    const entries = await this.#knowledgeRepo.findAllByLifecycles(['staging']);

    for (const e of entries) {
      const deadline = e.stagingDeadline || 0;

      const entry: StagingEntry = {
        id: e.id,
        title: e.title,
        stagingDeadline: deadline,
        confidence: 0,
      };

      if (deadline === 0) {
        result.waiting.push(entry);
        continue;
      }

      if (now < deadline) {
        result.waiting.push(entry);
        continue;
      }

      await this.#promote(entry, now);
      result.promoted.push(entry);
    }

    if (result.promoted.length > 0) {
      this.#logger.info(`StagingManager: promoted ${result.promoted.length} entries to active`);
    }

    return result;
  }

  /**
   * 回滚 staging 条目到 pending（Guard 检测到冲突时调用）
   */
  async rollback(entryId: string, reason: string): Promise<boolean> {
    const entry = await this.#knowledgeRepo.findById(entryId);

    if (!entry || entry.lifecycle !== 'staging') {
      return false;
    }

    await this.#knowledgeRepo.update(entryId, {
      lifecycle: 'pending',
      stagingDeadline: null,
    } as unknown as Record<string, unknown>);

    if (this.#signalBus) {
      this.#signalBus.send('lifecycle', 'StagingManager.rollback', 0.8, {
        target: entryId,
        metadata: {
          action: 'staging_rollback',
          reason,
          title: entry.title,
        },
      });
    }

    this.#logger.info(`StagingManager: ${entry.title} rolled back to pending — ${reason}`);
    return true;
  }

  /**
   * 获取所有 staging 条目及其状态
   */
  async listStaging(): Promise<StagingEntry[]> {
    const entries = await this.#knowledgeRepo.findAllByLifecycles(['staging']);

    return entries.map((e) => ({
      id: e.id,
      title: e.title,
      stagingDeadline: e.stagingDeadline || 0,
      confidence: 0,
    }));
  }

  /* ── Private ── */

  async #promote(entry: StagingEntry, now: number): Promise<void> {
    const nowS = unixNow();
    await this.#knowledgeRepo.update(entry.id, {
      lifecycle: 'active',
      publishedAt: nowS,
      stagingDeadline: null,
    } as unknown as Record<string, unknown>);

    if (this.#signalBus) {
      this.#signalBus.send('lifecycle', 'StagingManager.promote', 1.0, {
        target: entry.id,
        metadata: {
          action: 'auto_publish',
          title: entry.title,
          confidence: entry.confidence,
        },
      });
    }
  }
}
