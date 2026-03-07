import type { Database, Statement } from 'better-sqlite3';
import type { Logger as WinstonLogger } from 'winston';
import { Task } from '../../domain/task/Task.js';
import Logger from '../../infrastructure/logging/Logger.js';

/** Row shape returned by task_dependencies queries */
interface TaskDependencyRow {
  task_id: string;
  depends_on_id: string;
  dep_type: string;
  created_at: number;
  created_by: string;
}

/** Row shape returned by task statistics query */
interface TaskStatsRow {
  total: number;
  open: number;
  in_progress: number;
  closed: number;
  deferred: number;
  pinned: number;
}

/** Filters accepted by findAll */
interface TaskFilters {
  status?: string;
  taskType?: string;
  assignee?: string;
  parentId?: string;
}

/** Options accepted by findAll */
interface TaskFindOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
}

/** Column mapping for update fields */
interface TaskUpdateFields {
  status?: string;
  priority?: number;
  assignee?: string;
  notes?: string;
  description?: string;
  design?: string;
  acceptance?: string;
  closeReason?: string;
  closedAt?: number | null;
  updatedAt?: number;
  failCount?: number;
  lastFailReason?: string;
  childSeq?: number;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Database connection wrapper interface */
interface DatabaseWrapper {
  getDb(): Database;
}

/**
 * TaskRepositoryImpl — 任务实体 SQLite 持久化
 *
 * 直接操作 better-sqlite3 同步 API，方法签名保持 async 以对齐 DDD 接口约定。
 * DB 列名 snake_case，实体属性 camelCase—— Task.fromRow() / _entityToRow() 负责映射。
 */
export class TaskRepositoryImpl {
  _addDepStmt!: Statement;
  _deleteStmt!: Statement;
  _findByHashStmt!: Statement;
  _findByIdStmt!: Statement;
  _getBlockersStmt!: Statement;
  _getDependentsStmt!: Statement;
  _getDepsStmt!: Statement;
  _insertStmt!: Statement;
  _logEventStmt!: Statement;
  _reachableStmt!: Statement;
  _removeDepStmt!: Statement;
  _statsStmt!: Statement;
  _updateFieldsStmt: Statement | null = null;
  db: Database;
  logger: WinstonLogger;
  /**
   * @param {import('../../infrastructure/database/DatabaseConnection.js').default} database
   */
  constructor(database: DatabaseWrapper) {
    this.db = database.getDb();
    this.logger = Logger.getInstance();
    this._prepareStatements();
  }

  /** @private 预编译常用语句 */
  _prepareStatements() {
    this._insertStmt = this.db.prepare(`
      INSERT INTO tasks (
        id, parent_id, child_seq,
        title, description, design, acceptance, notes,
        status, priority, task_type, close_reason, content_hash,
        fail_count, last_fail_reason,
        assignee, created_by,
        created_at, updated_at, closed_at,
        metadata
      ) VALUES (
        @id, @parent_id, @child_seq,
        @title, @description, @design, @acceptance, @notes,
        @status, @priority, @task_type, @close_reason, @content_hash,
        @fail_count, @last_fail_reason,
        @assignee, @created_by,
        @created_at, @updated_at, @closed_at,
        @metadata
      )
    `);

    this._findByIdStmt = this.db.prepare('SELECT * FROM tasks WHERE id = ? LIMIT 1');

    this._findByHashStmt = this.db.prepare(
      "SELECT * FROM tasks WHERE content_hash = ? AND status != 'closed' LIMIT 1"
    );

    this._updateFieldsStmt = null; // 动态构建

    this._deleteStmt = this.db.prepare('DELETE FROM tasks WHERE id = ?');

    // ── 依赖相关 ──
    this._addDepStmt = this.db.prepare(`
      INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, dep_type, created_at, created_by)
      VALUES (?, ?, ?, ?, 'agent')
    `);

    this._removeDepStmt = this.db.prepare(
      'DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ? AND dep_type = ?'
    );

    this._getDepsStmt = this.db.prepare(
      'SELECT * FROM task_dependencies WHERE task_id = ? ORDER BY created_at'
    );

    this._getDependentsStmt = this.db.prepare(
      'SELECT * FROM task_dependencies WHERE depends_on_id = ?'
    );

    this._getBlockersStmt = this.db.prepare(`
      SELECT t.*
      FROM task_dependencies td
      JOIN tasks t ON td.depends_on_id = t.id
      WHERE td.task_id = ?
        AND td.dep_type IN ('blocks', 'waits-for')
        AND t.status != 'closed'
    `);

    // ── 环检测 (递归 CTE) ──
    this._reachableStmt = this.db.prepare(`
      WITH RECURSIVE reachable(id, depth) AS (
        SELECT depends_on_id, 1
        FROM task_dependencies
        WHERE task_id = ?
          AND dep_type IN ('blocks', 'waits-for')

        UNION ALL

        SELECT td.depends_on_id, r.depth + 1
        FROM task_dependencies td
        JOIN reachable r ON td.task_id = r.id
        WHERE td.dep_type IN ('blocks', 'waits-for')
          AND r.depth < 50
      )
      SELECT 1 FROM reachable WHERE id = ? LIMIT 1
    `);

    // ── 事件审计 ──
    this._logEventStmt = this.db.prepare(`
      INSERT INTO task_events (task_id, event_type, actor, old_value, new_value, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // ── 统计 ──
    this._statsStmt = this.db.prepare(`
      SELECT
        COUNT(*)                                           as total,
        SUM(CASE WHEN status = 'open'        THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'closed'      THEN 1 ELSE 0 END) as closed,
        SUM(CASE WHEN status = 'deferred'    THEN 1 ELSE 0 END) as deferred,
        SUM(CASE WHEN status = 'pinned'      THEN 1 ELSE 0 END) as pinned
      FROM tasks
    `);
  }

  // ═══ CRUD ═══════════════════════════════════════════

  /**
   * 创建任务
   * @param {Task} task
   * @returns {Task}
   */
  create(task: Task) {
    const row = this._entityToRow(task);
    this._insertStmt.run(row);
    return this.findById(task.id!);
  }

  /**
   * 按 ID 查询
   * @param {string} id
   * @returns {Task|null}
   */
  findById(id: string) {
    const row = this._findByIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? Task.fromRow(row) : null;
  }

  /**
   * 按内容哈希查询（去重用）
   * @param {string} hash
   * @returns {Task|null}
   */
  findByContentHash(hash: string | null) {
    if (!hash) {
      return null;
    }
    const row = this._findByHashStmt.get(hash) as Record<string, unknown> | undefined;
    return row ? Task.fromRow(row) : null;
  }

  /**
   * 更新任务字段
   * @param {string} id
   * @param {object} fields 部分字段 (camelCase)
   * @returns {Task}
   */
  update(id: string, fields: TaskUpdateFields) {
    const columnMap: Record<string, string> = {
      status: 'status',
      priority: 'priority',
      assignee: 'assignee',
      notes: 'notes',
      description: 'description',
      design: 'design',
      acceptance: 'acceptance',
      closeReason: 'close_reason',
      closedAt: 'closed_at',
      updatedAt: 'updated_at',
      failCount: 'fail_count',
      lastFailReason: 'last_fail_reason',
      childSeq: 'child_seq',
      metadata: 'metadata',
    };

    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    for (const [key, value] of Object.entries(fields)) {
      const col = columnMap[key];
      if (!col) {
        continue;
      }
      setClauses.push(`${col} = ?`);
      values.push(key === 'metadata' ? JSON.stringify(value) : (value as string | number | null));
    }

    if (setClauses.length === 0) {
      return this.findById(id);
    }

    // 始终更新 updated_at
    if (!fields.updatedAt) {
      setClauses.push('updated_at = ?');
      values.push(Math.floor(Date.now() / 1000));
    }

    values.push(id);
    const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    return this.findById(id);
  }

  /**
   * 删除任务
   * @param {string} id
   * @returns {boolean}
   */
  delete(id: string) {
    const result = this._deleteStmt.run(id);
    return result.changes > 0;
  }

  /**
   * 列表查询
   * @param {object} filters - { status, taskType, assignee, parentId }
   * @param {object} options - { limit, offset, orderBy }
   * @returns {Task[]}
   */
  findAll(filters: TaskFilters = {}, options: TaskFindOptions = {}) {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters.taskType) {
      conditions.push('task_type = ?');
      params.push(filters.taskType);
    }
    if (filters.assignee) {
      conditions.push('assignee = ?');
      params.push(filters.assignee);
    }
    if (filters.parentId) {
      conditions.push('parent_id = ?');
      params.push(filters.parentId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(options.limit || 50, 500));
    const offset = Math.max(0, options.offset || 0);
    const orderBy = _sanitizeOrderBy(options.orderBy);

    const sql = `SELECT * FROM tasks ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r: unknown) => Task.fromRow(r as Record<string, unknown>));
  }

  // ═══ 依赖管理 ═══════════════════════════════════════

  /**
   * 添加依赖
   */
  addDependency(taskId: string, dependsOnId: string, depType: string) {
    this._addDepStmt.run(taskId, dependsOnId, depType, Math.floor(Date.now() / 1000));
  }

  /**
   * 删除依赖
   */
  removeDependency(taskId: string, dependsOnId: string, depType: string) {
    this._removeDepStmt.run(taskId, dependsOnId, depType);
  }

  /**
   * 获取任务的所有依赖
   */
  getDependencies(taskId: string): TaskDependencyRow[] {
    return this._getDepsStmt.all(taskId) as TaskDependencyRow[];
  }

  /**
   * 获取依赖此任务的所有任务
   */
  getDependents(dependsOnId: string): TaskDependencyRow[] {
    return this._getDependentsStmt.all(dependsOnId) as TaskDependencyRow[];
  }

  /**
   * 获取阻塞某任务的所有任务（含任务详情）
   */
  getBlockers(taskId: string) {
    return this._getBlockersStmt
      .all(taskId)
      .map((r: unknown) => Task.fromRow(r as Record<string, unknown>));
  }

  /**
   * 环检测：检查 fromId → toId 是否已有可达路径
   * @param {string} fromId
   * @param {string} toId
   * @returns {boolean}
   */
  hasReachablePath(fromId: string, toId: string) {
    const row = this._reachableStmt.get(fromId, toId);
    return !!row;
  }

  // ═══ 事务支持 ═══════════════════════════════════════

  /**
   * 在事务中执行操作
   * @param {Function} fn
   * @returns {*}
   */
  inTransaction<T>(fn: () => T): T {
    const txn = this.db.transaction(fn);
    return txn();
  }

  // ═══ 统计 ═══════════════════════════════════════════

  /**
   * 获取任务统计
   */
  getStatistics() {
    const row = this._statsStmt.get() as TaskStatsRow;
    return {
      total: row.total || 0,
      open: row.open || 0,
      in_progress: row.in_progress || 0,
      closed: row.closed || 0,
      deferred: row.deferred || 0,
      pinned: row.pinned || 0,
    };
  }

  // ═══ 事件审计 ═══════════════════════════════════════

  /**
   * 记录任务事件
   */
  logEvent(
    taskId: string,
    eventType: string,
    oldValue: string | null = null,
    newValue: string | null = null,
    comment: string | null = null,
    actor = 'agent'
  ) {
    this._logEventStmt.run(
      taskId,
      eventType,
      actor,
      oldValue,
      newValue,
      comment,
      Math.floor(Date.now() / 1000)
    );
  }

  // ═══ 私有方法 ═══════════════════════════════════════

  /**
   * 实体 → DB 行 (camelCase → snake_case)
   * @param {Task} task
   * @returns {object}
   */
  _entityToRow(task: Task) {
    return {
      id: task.id,
      parent_id: task.parentId || null,
      child_seq: task.childSeq || 0,
      title: task.title,
      description: task.description || '',
      design: task.design || '',
      acceptance: task.acceptance || '',
      notes: task.notes || '',
      status: task.status,
      priority: task.priority ?? 2,
      task_type: task.taskType || 'task',
      close_reason: task.closeReason || '',
      content_hash: task.contentHash || '',
      fail_count: task.failCount || 0,
      last_fail_reason: task.lastFailReason || '',
      assignee: task.assignee || '',
      created_by: task.createdBy || 'agent',
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      closed_at: task.closedAt || null,
      metadata: JSON.stringify(task.metadata || {}),
    };
  }
}

// ═══ 内部工具 ═══════════════════════════════════════

const ALLOWED_ORDER_FIELDS = new Set([
  'priority',
  'created_at',
  'updated_at',
  'status',
  'title',
  'task_type',
  'closed_at',
]);
const ALLOWED_DIRECTIONS = new Set(['ASC', 'DESC']);

/**
 * orderBy 白名单校验，防止 SQL 注入
 * @param {string} [orderBy]
 * @returns {string}
 */
function _sanitizeOrderBy(orderBy?: string): string {
  if (!orderBy) {
    return 'priority ASC, created_at ASC';
  }
  return (
    orderBy
      .split(',')
      .map((clause: string) => {
        const parts = clause.trim().split(/\s+/);
        const field = parts[0];
        if (!ALLOWED_ORDER_FIELDS.has(field)) {
          return null;
        }
        const dir = ALLOWED_DIRECTIONS.has(parts[1]?.toUpperCase())
          ? parts[1].toUpperCase()
          : 'ASC';
        return `${field} ${dir}`;
      })
      .filter(Boolean)
      .join(', ') || 'priority ASC, created_at ASC'
  );
}

export default TaskRepositoryImpl;
