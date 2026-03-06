import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

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
export class TaskIdGenerator {
  _db: any;
  _prefix: any;
  /**
   * @param {import('better-sqlite3').Database} db - raw SQLite handle
   */
  constructor(db: any) {
    this._db = db;
    this._prefix = 'asd';
  }

  /**
   * 生成新的短 Hash ID
   * @returns {string} 如 'asd-a1b2'
   */
  generate() {
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
   * @param {string} parentId
   * @returns {string}
   */
  generateChild(parentId: any) {
    const parent = this._db.prepare('SELECT child_seq FROM tasks WHERE id = ?').get(parentId);

    if (!parent) {
      throw new Error(`Parent task not found: ${parentId}`);
    }

    const nextSeq = (parent.child_seq || 0) + 1;
    this._db.prepare('UPDATE tasks SET child_seq = ? WHERE id = ?').run(nextSeq, parentId);

    return `${parentId}.${nextSeq}`;
  }

  /** @private */
  _getTaskCount() {
    const row = this._db.prepare('SELECT COUNT(*) as cnt FROM tasks').get();
    return row?.cnt || 0;
  }

  /** @private */
  _exists(id: any) {
    const row = this._db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id);
    return !!row;
  }
}

export default TaskIdGenerator;
