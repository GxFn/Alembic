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

/* ────────────────────── Types ────────────────────── */

interface DatabaseLike {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number };
  };
}

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
  #db: DatabaseLike;
  #signalBus: SignalBus | null;
  #logger = Logger.getInstance();

  constructor(db: DatabaseLike, options: { signalBus?: SignalBus } = {}) {
    this.#db = db;
    this.#signalBus = options.signalBus ?? null;
  }

  /**
   * 将条目推入 staging 状态并记录 deadline
   */
  enterStaging(entryId: string, gracePeriodMs: number, confidence: number): boolean {
    const now = Date.now();
    const deadline = now + gracePeriodMs;

    const entry = this.#db
      .prepare(`SELECT id, title, lifecycle FROM knowledge_entries WHERE id = ?`)
      .get(entryId) as { id: string; title: string; lifecycle: string } | undefined;

    if (!entry) {
      this.#logger.warn(`StagingManager: entry not found: ${entryId}`);
      return false;
    }

    if (entry.lifecycle !== 'pending') {
      this.#logger.warn(`StagingManager: entry ${entryId} is "${entry.lifecycle}", not pending`);
      return false;
    }

    // 更新 lifecycle → staging，记录 deadline 到 stats JSON
    const statsRaw = this.#db
      .prepare(`SELECT stats FROM knowledge_entries WHERE id = ?`)
      .get(entryId) as { stats: string } | undefined;

    let stats: Record<string, unknown> = {};
    try {
      stats = JSON.parse(statsRaw?.stats || '{}');
    } catch {
      stats = {};
    }

    stats.stagingDeadline = deadline;
    stats.stagingConfidence = confidence;
    stats.stagingEnteredAt = now;

    this.#db
      .prepare(
        `UPDATE knowledge_entries SET lifecycle = 'staging', stats = ?, updatedAt = ? WHERE id = ?`
      )
      .run(JSON.stringify(stats), now, entryId);

    // 发射信号
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
  checkAndPromote(): StagingCheckResult {
    const now = Date.now();
    const result: StagingCheckResult = { promoted: [], rolledBack: [], waiting: [] };

    const rows = this.#db
      .prepare(`SELECT id, title, stats FROM knowledge_entries WHERE lifecycle = 'staging'`)
      .all() as { id: string; title: string; stats: string }[];

    for (const row of rows) {
      let stats: Record<string, unknown> = {};
      try {
        stats = JSON.parse(row.stats || '{}');
      } catch {
        stats = {};
      }

      const deadline = (stats.stagingDeadline as number) || 0;
      const confidence = (stats.stagingConfidence as number) || 0;

      const entry: StagingEntry = {
        id: row.id,
        title: row.title,
        stagingDeadline: deadline,
        confidence,
      };

      if (deadline === 0) {
        // 无 deadline 数据（旧数据兼容）→ 保持 waiting
        result.waiting.push(entry);
        continue;
      }

      if (now < deadline) {
        // 未到期
        result.waiting.push(entry);
        continue;
      }

      // 到期 → 自动发布
      this.#promote(entry, stats, now);
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
  rollback(entryId: string, reason: string): boolean {
    const now = Date.now();
    const entry = this.#db
      .prepare(`SELECT id, title, lifecycle, stats FROM knowledge_entries WHERE id = ?`)
      .get(entryId) as { id: string; title: string; lifecycle: string; stats: string } | undefined;

    if (!entry || entry.lifecycle !== 'staging') {
      return false;
    }

    let stats: Record<string, unknown> = {};
    try {
      stats = JSON.parse(entry.stats || '{}');
    } catch {
      stats = {};
    }

    // 清除 staging 元数据
    delete stats.stagingDeadline;
    delete stats.stagingConfidence;
    delete stats.stagingEnteredAt;
    stats.lastRollbackReason = reason;
    stats.lastRollbackAt = now;

    this.#db
      .prepare(
        `UPDATE knowledge_entries SET lifecycle = 'pending', stats = ?, updatedAt = ? WHERE id = ?`
      )
      .run(JSON.stringify(stats), now, entryId);

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
  listStaging(): StagingEntry[] {
    const rows = this.#db
      .prepare(`SELECT id, title, stats FROM knowledge_entries WHERE lifecycle = 'staging'`)
      .all() as { id: string; title: string; stats: string }[];

    return rows.map((row) => {
      let stats: Record<string, unknown> = {};
      try {
        stats = JSON.parse(row.stats || '{}');
      } catch {
        stats = {};
      }
      return {
        id: row.id,
        title: row.title,
        stagingDeadline: (stats.stagingDeadline as number) || 0,
        confidence: (stats.stagingConfidence as number) || 0,
      };
    });
  }

  /* ── Private ── */

  #promote(entry: StagingEntry, stats: Record<string, unknown>, now: number): void {
    // 清除 staging 元数据，记录发布信息
    delete stats.stagingDeadline;
    delete stats.stagingConfidence;
    delete stats.stagingEnteredAt;
    stats.autoPublishedAt = now;

    this.#db
      .prepare(
        `UPDATE knowledge_entries SET lifecycle = 'active', publishedAt = ?, stats = ?, updatedAt = ? WHERE id = ?`
      )
      .run(now, JSON.stringify(stats), now, entry.id);

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
