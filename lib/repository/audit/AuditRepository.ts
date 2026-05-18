/**
 * AuditRepository — 审计日志的仓储实现
 *
 * 从 AuditStore 提取的数据操作，使用 raw SQLite 操作 Core 拥有的 audit_logs 表。
 */

import type { SqliteDatabase } from '@alembic/core/database';

/* ═══ 类型定义 ═══ */

interface AuditRepositoryDatabase {
  getDb(): SqliteDatabase;
}

interface AuditLogSqlRow {
  id: string;
  timestamp: number;
  actor: string;
  actor_context: string | null;
  action: string;
  resource: string | null;
  operation_data: string | null;
  result: string;
  error_message: string | null;
  duration: number | null;
}

export interface AuditLogEntity {
  id: string;
  timestamp: number;
  actor: string;
  actorContext: Record<string, unknown>;
  action: string;
  resource: string | null;
  operationData: Record<string, unknown>;
  result: string;
  errorMessage: string | null;
  duration: number | null;
}

export interface AuditLogInsert {
  id: string;
  timestamp: number;
  actor: string;
  actorContext?: string;
  action: string;
  resource?: string;
  operationData?: string;
  result: string;
  errorMessage?: string | null;
  duration?: number | null;
}

export interface AuditQueryFilters {
  actor?: string;
  action?: string;
  result?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

export interface AuditStats {
  timeRange: string;
  total: number;
  success: number;
  failure: number;
  successRate: string;
  avgDuration: string;
  byActor: Array<{ actor: string; count: number }>;
  byAction: Array<{ action: string; count: number }>;
}

/* ═══ Repository 实现 ═══ */

export class AuditRepositoryImpl {
  #db: SqliteDatabase;

  constructor(database: AuditRepositoryDatabase) {
    this.#db = database.getDb();
  }

  /* ─── CRUD ─── */

  async findById(id: string): Promise<AuditLogEntity | null> {
    const row = this.#db.prepare(`${selectAuditRowsSql()} WHERE id = ? LIMIT 1`).get(id) as
      | AuditLogSqlRow
      | undefined;
    return row ? this.#mapRow(row) : null;
  }

  async create(data: AuditLogInsert): Promise<AuditLogEntity> {
    this.#db
      .prepare(
        `INSERT INTO audit_logs (
          id,
          timestamp,
          actor,
          actor_context,
          action,
          resource,
          operation_data,
          result,
          error_message,
          duration
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.id,
        data.timestamp,
        data.actor,
        data.actorContext ?? '{}',
        data.action,
        data.resource ?? null,
        data.operationData ?? '{}',
        data.result,
        data.errorMessage ?? null,
        data.duration ?? null
      );

    return (await this.findById(data.id))!;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.#db.prepare('DELETE FROM audit_logs WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /* ─── 查询 ─── */

  /** 动态多条件查询 */
  async query(filters: AuditQueryFilters = {}): Promise<AuditLogEntity[]> {
    const { whereClause, params } = buildAuditWhere(filters);
    const limitClause = filters.limit ? ' LIMIT ?' : '';
    const rows = this.#db
      .prepare(`${selectAuditRowsSql()}${whereClause} ORDER BY timestamp DESC${limitClause}`)
      .all(...params, ...(filters.limit ? [filters.limit] : [])) as AuditLogSqlRow[];

    return rows.map((r) => this.#mapRow(r));
  }

  /** 根据请求 ID 查询 */
  async findByRequestId(requestId: string): Promise<AuditLogEntity | null> {
    return this.findById(requestId);
  }

  /** 根据角色查询 */
  async findByActor(actor: string, limit = 100): Promise<AuditLogEntity[]> {
    const rows = this.#db
      .prepare(`${selectAuditRowsSql()} WHERE actor = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(actor, limit) as AuditLogSqlRow[];
    return rows.map((r) => this.#mapRow(r));
  }

  /** 根据操作查询 */
  async findByAction(action: string, limit = 100): Promise<AuditLogEntity[]> {
    const rows = this.#db
      .prepare(`${selectAuditRowsSql()} WHERE action = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(action, limit) as AuditLogSqlRow[];
    return rows.map((r) => this.#mapRow(r));
  }

  /** 根据结果查询 */
  async findByResult(result: string, limit = 100): Promise<AuditLogEntity[]> {
    const rows = this.#db
      .prepare(`${selectAuditRowsSql()} WHERE result = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(result, limit) as AuditLogSqlRow[];
    return rows.map((r) => this.#mapRow(r));
  }

  /* ─── 统计 ─── */

  /** 获取统计数据 */
  async getStats(timeRange = '24h'): Promise<AuditStats> {
    const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 720; // 30d
    const startTime = Date.now() - hours * 60 * 60 * 1000;

    const total = readCount(
      this.#db,
      'SELECT COUNT(*) AS count FROM audit_logs WHERE timestamp >= ?',
      [startTime]
    );
    const success = readCount(
      this.#db,
      'SELECT COUNT(*) AS count FROM audit_logs WHERE timestamp >= ? AND result = ?',
      [startTime, 'success']
    );
    const failure = readCount(
      this.#db,
      'SELECT COUNT(*) AS count FROM audit_logs WHERE timestamp >= ? AND result = ?',
      [startTime, 'failure']
    );
    const byActor = this.#db
      .prepare(
        `SELECT actor, COUNT(*) AS count
         FROM audit_logs
         WHERE timestamp >= ?
         GROUP BY actor
         ORDER BY count DESC`
      )
      .all(startTime) as Array<{ actor: string; count: number }>;
    const byAction = this.#db
      .prepare(
        `SELECT action, COUNT(*) AS count
         FROM audit_logs
         WHERE timestamp >= ?
         GROUP BY action
         ORDER BY count DESC`
      )
      .all(startTime) as Array<{ action: string; count: number }>;
    const avgRow = this.#db
      .prepare(
        `SELECT AVG(duration) AS avgDuration
         FROM audit_logs
         WHERE timestamp >= ? AND duration IS NOT NULL`
      )
      .get(startTime) as { avgDuration: number | null } | undefined;
    const avgDuration = avgRow?.avgDuration ? `${Math.round(Number(avgRow.avgDuration))}ms` : 'N/A';

    return {
      timeRange,
      total,
      success,
      failure,
      successRate: total > 0 ? `${((success / total) * 100).toFixed(2)}%` : '0%',
      avgDuration,
      byActor,
      byAction,
    };
  }

  /* ─── 清理 ─── */

  /**
   * 清理过期审计日志
   * @param maxAgeDays 保留天数
   */
  async cleanup(maxAgeDays = 90): Promise<{ deleted: number }> {
    try {
      const cutoff = Date.now() - maxAgeDays * 86400000;
      const result = this.#db.prepare('DELETE FROM audit_logs WHERE timestamp < ?').run(cutoff);
      return { deleted: result.changes ?? 0 };
    } catch {
      return { deleted: 0 };
    }
  }

  /* ─── 内部辅助 ─── */

  #mapRow(row: AuditLogSqlRow): AuditLogEntity {
    return {
      id: row.id,
      timestamp: row.timestamp,
      actor: row.actor,
      actorContext: safeParseJSON(row.actor_context, {} as Record<string, unknown>),
      action: row.action,
      resource: row.resource ?? null,
      operationData: safeParseJSON(row.operation_data, {} as Record<string, unknown>),
      result: row.result,
      errorMessage: row.error_message ?? null,
      duration: row.duration ?? null,
    };
  }
}

function selectAuditRowsSql() {
  return `SELECT
    id,
    timestamp,
    actor,
    actor_context,
    action,
    resource,
    operation_data,
    result,
    error_message,
    duration
  FROM audit_logs`;
}

function buildAuditWhere(filters: AuditQueryFilters): { whereClause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.actor) {
    conditions.push('actor = ?');
    params.push(filters.actor);
  }
  if (filters.action) {
    conditions.push('action = ?');
    params.push(filters.action);
  }
  if (filters.result) {
    conditions.push('result = ?');
    params.push(filters.result);
  }
  if (filters.startDate) {
    conditions.push('timestamp >= ?');
    params.push(filters.startDate);
  }
  if (filters.endDate) {
    conditions.push('timestamp <= ?');
    params.push(filters.endDate);
  }

  return {
    whereClause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function readCount(db: SqliteDatabase, sql: string, params: unknown[]) {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

function safeParseJSON<T>(str: string | null | undefined, fallback: T): T {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch {
    return fallback;
  }
}
