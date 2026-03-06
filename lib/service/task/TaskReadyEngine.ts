import { Task } from '../../domain/task/Task.js';

/**
 * TaskReadyEngine — 就绪检测引擎
 *
 * 核心能力：通过递归 CTE 计算传递性阻塞，返回所有无阻塞依赖的就绪任务。
 *
 * 排序策略 (默认 hybrid):
 *   priority ASC → 高优先级优先
 *   created_at ASC → 同优先级先创建优先（防止 starvation）
 */
export class TaskReadyEngine {
  _blockedStmt: any;
  _db: any;
  _depTreeStmt: any;
  _readyStmt: any;
  /**
   * @param {import('better-sqlite3').Database} db - raw SQLite handle
   */
  constructor(db) {
    this._db = db;
    this._prepareStatements();
  }

  /** @private */
  _prepareStatements() {
    // ── 核心: 递归 CTE 计算传递性阻塞 ──
    this._readyStmt = this._db.prepare(`
      WITH RECURSIVE blocked_tasks(id, depth) AS (
        -- Base case: 直接被阻塞的任务
        SELECT td.task_id, 1
        FROM task_dependencies td
        JOIN tasks blocker ON td.depends_on_id = blocker.id
        WHERE td.dep_type IN ('blocks', 'waits-for')
          AND blocker.status != 'closed'

        UNION

        -- Recursive case: 传递性阻塞（深度保护 ≤ 50 层）
        SELECT td.task_id, bt.depth + 1
        FROM task_dependencies td
        JOIN blocked_tasks bt ON td.depends_on_id = bt.id
        WHERE td.dep_type IN ('blocks', 'waits-for')
          AND bt.depth < 50
      )
      SELECT t.*
      FROM tasks t
      WHERE t.status = 'open'
        AND t.id NOT IN (SELECT id FROM blocked_tasks)
      ORDER BY t.priority ASC, t.created_at ASC
      LIMIT ?
    `);

    // ── 查询被阻塞的任务 ──
    this._blockedStmt = this._db.prepare(`
      SELECT t.*, GROUP_CONCAT(td.depends_on_id) as blocked_by
      FROM tasks t
      JOIN task_dependencies td ON t.id = td.task_id
      JOIN tasks blocker ON td.depends_on_id = blocker.id
      WHERE t.status IN ('open', 'in_progress')
        AND td.dep_type IN ('blocks', 'waits-for')
        AND blocker.status != 'closed'
      GROUP BY t.id
      ORDER BY t.priority ASC
    `);

    // ── 依赖树查询 ──
    this._depTreeStmt = this._db.prepare(`
      WITH RECURSIVE dep_tree(id, depth, path) AS (
        SELECT depends_on_id, 1, depends_on_id
        FROM task_dependencies
        WHERE task_id = ?
          AND dep_type IN ('blocks', 'waits-for')

        UNION ALL

        SELECT td.depends_on_id, dt.depth + 1, dt.path || '>' || td.depends_on_id
        FROM task_dependencies td
        JOIN dep_tree dt ON td.task_id = dt.id
        WHERE td.dep_type IN ('blocks', 'waits-for')
          AND dt.depth < 10
      )
      SELECT t.*, dt.depth
      FROM dep_tree dt
      JOIN tasks t ON t.id = dt.id
      ORDER BY dt.depth ASC
    `);
  }

  /**
   * 获取就绪任务（核心方法）
   *
   * 就绪 = status='open' 且无未完成的阻塞型依赖（传递性检测）
   *
   * @param {object} [options]
   * @param {number} [options.limit=10]
   * @returns {Task[]}
   */
  getReadyWork(options: any = {}) {
    const limit = Math.max(1, Math.min(options.limit || 10, 200));
    const rows = this._readyStmt.all(limit);
    return rows.map((r) => Task.fromRow(r));
  }

  /**
   * 获取被阻塞的任务列表
   * @returns {Array<Object>} 带 blocked_by 字段的任务列表
   */
  getBlockedWork() {
    const rows = this._blockedStmt.all();
    return rows.map((r) => ({
      ...Task.fromRow(r)!.toJSON(),
      blockedBy: r.blocked_by ? r.blocked_by.split(',') : [],
    }));
  }

  /**
   * 获取依赖树
   * @param {string} taskId
   * @returns {Array<Object>} 带 depth 的任务列表
   */
  getDependencyTree(taskId) {
    const rows = this._depTreeStmt.all(taskId);
    return rows.map((r) => ({
      ...Task.fromRow(r)!.toJSON(),
      depth: r.depth,
    }));
  }
}

export default TaskReadyEngine;
