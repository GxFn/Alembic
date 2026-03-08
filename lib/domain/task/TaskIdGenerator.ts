import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import { getDrizzle } from '../../infrastructure/database/drizzle/index.js';
import { tasks } from '../../infrastructure/database/drizzle/schema.js';

/**
 * TaskIdGenerator — 短 Hash ID 生成器
 *
 * 渐进式长度扩展（随任务数增长自动加长）：
 *   0-500 tasks  → 4 字符  (16^4 = 65,536 组合)
 *   500-1500     → 5 字符  (16^5 = 1,048,576)
 *   1500+        → 6 字符  (16^6 = 16,777,216)
 *
 * 前缀 'asd-'，与 Beads 的 'bd-' 区分。
 */
interface DbHandle {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): unknown;
  };
}

export class TaskIdGenerator {
  _db: DbHandle;
  _prefix: string;
  #drizzle: DrizzleDB;
  /**
   * @param {import('better-sqlite3').Database} db - raw SQLite handle
   */
  constructor(db: DbHandle, drizzle?: DrizzleDB) {
    this._db = db;
    this._prefix = 'asd';
    this.#drizzle = drizzle ?? getDrizzle();
  }

  /**
   * 生成新的短 Hash ID
   * @returns {string} 如 'asd-a1b2'
   */
  generate(): string {
    const taskCount = this._getTaskCount();
    const hashLen = taskCount < 500 ? 4 : taskCount < 1500 ? 5 : 6;

    // 尝试生成无冲突 ID（最多 10 次）
    for (let attempt = 0; attempt < 10; attempt++) {
      const uuid = uuidv4();
      const hash = createHash('sha256').update(uuid).digest('hex');
      const shortHash = hash.substring(0, hashLen);
      const id = `${this._prefix}-${shortHash}`;

      if (!this._exists(id)) {
        return id;
      }
    }

    // 回退到 6 位 + 冲突检查 + 终极 8 位兜底
    const uuid = uuidv4();
    const hash = createHash('sha256').update(uuid).digest('hex');
    const fallbackId = `${this._prefix}-${hash.substring(0, 6)}`;
    if (!this._exists(fallbackId)) {
      return fallbackId;
    }
    return `${this._prefix}-${hash.substring(0, 8)}`;
  }

  /**
   * 生成子任务 ID
   * asd-a3f8 → asd-a3f8.1, asd-a3f8.2, ...
   * ★ Drizzle 类型安全 SELECT + UPDATE
   */
  generateChild(parentId: string): string {
    const parent = this.#drizzle
      .select({ childSeq: tasks.childSeq })
      .from(tasks)
      .where(eq(tasks.id, parentId))
      .get();

    if (!parent) {
      throw new Error(`Parent task not found: ${parentId}`);
    }

    const nextSeq = (parent.childSeq || 0) + 1;
    this.#drizzle.update(tasks).set({ childSeq: nextSeq }).where(eq(tasks.id, parentId)).run();

    return `${parentId}.${nextSeq}`;
  }

  /** @private ★ Drizzle 类型安全 COUNT */
  _getTaskCount(): number {
    const row = this.#drizzle.select({ cnt: sql<number>`COUNT(*)` }).from(tasks).get();
    return row?.cnt || 0;
  }

  /** @private ★ Drizzle 类型安全 EXISTS */
  _exists(id: string): boolean {
    const row = this.#drizzle
      .select({ x: sql<number>`1` })
      .from(tasks)
      .where(eq(tasks.id, id))
      .get();
    return !!row;
  }
}

export default TaskIdGenerator;
