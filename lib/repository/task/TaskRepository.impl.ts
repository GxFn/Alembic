import type { Database, Statement } from 'better-sqlite3';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Logger as WinstonLogger } from 'winston';
import { Task } from '../../domain/task/Task.js';
import { type DrizzleDB, getDrizzle } from '../../infrastructure/database/drizzle/index.js';
import {
  taskDependencies,
  taskEvents,
  tasks,
} from '../../infrastructure/database/drizzle/schema.js';
import Logger from '../../infrastructure/logging/Logger.js';

/** Row shape returned by task_dependencies queries (camelCase — matches Drizzle schema) */
interface TaskDependencyRow {
  id: number;
  taskId: string;
  dependsOnId: string;
  depType: string;
  metadata: string | null;
  createdAt: number;
  createdBy: string | null;
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
 * TaskRepositoryImpl — 任务实体 SQLite 持久化 (Drizzle ORM)
 *
 * DB 列名 snake_case，实体属性 camelCase—— Task.fromRow() / _entityToRow() 负责映射。
 *
 * Drizzle 迁移策略：
 * - CRUD (create/findById/update/delete) → drizzle 类型安全 API
 * - 依赖管理 (add/remove/get) → drizzle 类型安全 API
 * - 事件审计 / 统计 → drizzle 类型安全 API
 * - 环检测 (递归 CTE) / 复杂动态查询 (findAll) → 保留 raw SQL
 */
export class TaskRepositoryImpl {
  _reachableStmt!: Statement;
  #drizzle: DrizzleDB;
  db: Database;
  logger: WinstonLogger;
  /**
   * @param {import('../../infrastructure/database/DatabaseConnection.js').default} database
   */
  constructor(database: DatabaseWrapper) {
    this.db = database.getDb();
    this.logger = Logger.getInstance();
    this.#drizzle = getDrizzle();
    this._prepareStatements();
  }

  /** @private 预编译复杂查询（仅保留 drizzle 无法表达的递归 CTE） */
  _prepareStatements() {
    // ── 环检测 (递归 CTE) — drizzle 不支持递归 CTE ──
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
  }

  // ═══ CRUD ═══════════════════════════════════════════

  /**
   * 创建任务
   * ★ Drizzle 类型安全 INSERT
   */
  create(task: Task) {
    const row = this._entityToRow(task);
    this.#drizzle.insert(tasks).values(row).run();
    return this.findById(task.id!);
  }

  /**
   * 按 ID 查询
   * ★ Drizzle 类型安全 SELECT
   */
  findById(id: string) {
    const row = this.#drizzle.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? Task.fromRow(row as unknown as Record<string, unknown>) : null;
  }

  /**
   * 按内容哈希查询（去重用）
   * ★ Drizzle 类型安全 SELECT
   */
  findByContentHash(hash: string | null) {
    if (!hash) {
      return null;
    }
    const row = this.#drizzle
      .select()
      .from(tasks)
      .where(and(eq(tasks.contentHash, hash), sql`${tasks.status} != 'closed'`))
      .get();
    return row ? Task.fromRow(row as unknown as Record<string, unknown>) : null;
  }

  /**
   * 更新任务字段
   * ★ Drizzle 类型安全 UPDATE
   */
  update(id: string, fields: TaskUpdateFields) {
    const setObj: Record<string, unknown> = {};
    const columnMap: Record<string, string> = {
      status: 'status',
      priority: 'priority',
      assignee: 'assignee',
      notes: 'notes',
      description: 'description',
      design: 'design',
      acceptance: 'acceptance',
      closeReason: 'closeReason',
      closedAt: 'closedAt',
      updatedAt: 'updatedAt',
      failCount: 'failCount',
      lastFailReason: 'lastFailReason',
      childSeq: 'childSeq',
      metadata: 'metadata',
    };

    for (const [key, value] of Object.entries(fields)) {
      const schemaKey = columnMap[key];
      if (!schemaKey) {
        continue;
      }
      setObj[schemaKey] = key === 'metadata' ? JSON.stringify(value) : value;
    }

    if (Object.keys(setObj).length === 0) {
      return this.findById(id);
    }

    // 始终更新 updatedAt
    if (!fields.updatedAt) {
      setObj.updatedAt = Math.floor(Date.now() / 1000);
    }

    this.#drizzle.update(tasks).set(setObj).where(eq(tasks.id, id)).run();
    return this.findById(id);
  }

  /**
   * 删除任务
   * ★ Drizzle 类型安全 DELETE
   */
  delete(id: string) {
    const result = this.#drizzle.delete(tasks).where(eq(tasks.id, id)).run();
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
   * ★ Drizzle 类型安全 INSERT OR IGNORE
   */
  addDependency(taskId: string, dependsOnId: string, depType: string) {
    this.#drizzle
      .insert(taskDependencies)
      .values({
        taskId,
        dependsOnId,
        depType,
        createdAt: Math.floor(Date.now() / 1000),
        createdBy: 'agent',
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * 删除依赖
   * ★ Drizzle 类型安全 DELETE
   */
  removeDependency(taskId: string, dependsOnId: string, depType: string) {
    this.#drizzle
      .delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.taskId, taskId),
          eq(taskDependencies.dependsOnId, dependsOnId),
          eq(taskDependencies.depType, depType)
        )
      )
      .run();
  }

  /**
   * 获取任务的所有依赖
   * ★ Drizzle 类型安全 SELECT
   */
  getDependencies(taskId: string): TaskDependencyRow[] {
    return this.#drizzle
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, taskId))
      .orderBy(asc(taskDependencies.createdAt))
      .all() as TaskDependencyRow[];
  }

  /**
   * 获取依赖此任务的所有任务
   * ★ Drizzle 类型安全 SELECT
   */
  getDependents(dependsOnId: string): TaskDependencyRow[] {
    return this.#drizzle
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.dependsOnId, dependsOnId))
      .all() as TaskDependencyRow[];
  }

  /**
   * 获取阻塞某任务的所有任务（含任务详情）
   * 保留 raw SQL — JOIN 查询
   */
  getBlockers(taskId: string) {
    const rows = this.db
      .prepare(`
      SELECT t.*
      FROM task_dependencies td
      JOIN tasks t ON td.depends_on_id = t.id
      WHERE td.task_id = ?
        AND td.dep_type IN ('blocks', 'waits-for')
        AND t.status != 'closed'
    `)
      .all(taskId);
    return rows.map((r: unknown) => Task.fromRow(r as Record<string, unknown>));
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
   * 保留 raw SQL — SUM(CASE WHEN) 聚合在 drizzle 中不如直写清晰
   */
  getStatistics() {
    const row = this.db
      .prepare(`
      SELECT
        COUNT(*)                                           as total,
        SUM(CASE WHEN status = 'open'        THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'closed'      THEN 1 ELSE 0 END) as closed,
        SUM(CASE WHEN status = 'deferred'    THEN 1 ELSE 0 END) as deferred,
        SUM(CASE WHEN status = 'pinned'      THEN 1 ELSE 0 END) as pinned
      FROM tasks
    `)
      .get() as TaskStatsRow;
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
   * ★ Drizzle 类型安全 INSERT
   */
  logEvent(
    taskId: string,
    eventType: string,
    oldValue: string | null = null,
    newValue: string | null = null,
    comment: string | null = null,
    actor = 'agent'
  ) {
    this.#drizzle
      .insert(taskEvents)
      .values({
        taskId,
        eventType,
        actor,
        oldValue,
        newValue,
        comment,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();
  }

  // ═══ 私有方法 ═══════════════════════════════════════

  /**
   * 实体 → DB 行 (camelCase → snake_case)
   * @param {Task} task
   * @returns {object}
   */
  _entityToRow(task: Task) {
    return {
      id: task.id!,
      parentId: task.parentId || null,
      childSeq: task.childSeq || 0,
      title: task.title,
      description: task.description || '',
      design: task.design || '',
      acceptance: task.acceptance || '',
      notes: task.notes || '',
      status: task.status,
      priority: task.priority ?? 2,
      taskType: task.taskType || 'task',
      closeReason: task.closeReason || '',
      contentHash: task.contentHash || '',
      failCount: task.failCount || 0,
      lastFailReason: task.lastFailReason || '',
      assignee: task.assignee || '',
      createdBy: task.createdBy || 'agent',
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      closedAt: task.closedAt || null,
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
