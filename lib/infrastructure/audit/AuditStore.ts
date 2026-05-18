/** AuditStore - 审计日志存储 */

import type { SqliteDatabase } from '@alembic/core/database';

interface AuditDatabaseHandle {
  getDb(): SqliteDatabase;
}

export interface AuditLogRow {
  id: string;
  timestamp: number;
  actor: string;
  actorContext: string;
  action: string;
  resource: string | null;
  operationData: string;
  result: string;
  errorMessage: string | null;
  duration: number | null;
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

interface AuditQueryFilters {
  actor?: string;
  action?: string;
  result?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

export class AuditStore {
  #db: SqliteDatabase;

  constructor(db: AuditDatabaseHandle) {
    this.#db = db.getDb();
  }

  /** 保存审计日志 */
  async save(entry: {
    id: string;
    timestamp: number;
    actor: string;
    actor_context: string;
    action: string;
    resource: string;
    operation_data: string;
    result: string;
    error_message: string | null;
    duration: number | null;
  }) {
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
        entry.id,
        entry.timestamp,
        entry.actor,
        entry.actor_context,
        entry.action,
        entry.resource,
        entry.operation_data,
        entry.result,
        entry.error_message,
        entry.duration
      );
  }

  /** 查询审计日志 */
  query(filters: AuditQueryFilters = {}) {
    const { whereClause, params } = buildAuditWhere(filters);
    const limitClause = filters.limit ? ' LIMIT ?' : '';
    const rows = this.#db
      .prepare(`${selectAuditRowsSql()}${whereClause} ORDER BY timestamp DESC${limitClause}`)
      .all(...params, ...(filters.limit ? [filters.limit] : [])) as AuditLogSqlRow[];

    return rows.map(mapAuditRow);
  }

  /** 根据请求 ID 查询 */
  findByRequestId(requestId: string) {
    const row = this.#db.prepare(`${selectAuditRowsSql()} WHERE id = ? LIMIT 1`).get(requestId) as
      | AuditLogSqlRow
      | undefined;

    return row ? mapAuditRow(row) : undefined;
  }

  /** 根据角色查询 */
  findByActor(actor: string, limit = 100) {
    const rows = this.#db
      .prepare(`${selectAuditRowsSql()} WHERE actor = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(actor, limit) as AuditLogSqlRow[];

    return rows.map(mapAuditRow);
  }

  /** 根据操作查询 */
  findByAction(action: string, limit = 100) {
    const rows = this.#db
      .prepare(`${selectAuditRowsSql()} WHERE action = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(action, limit) as AuditLogSqlRow[];

    return rows.map(mapAuditRow);
  }

  /** 根据结果查询 */
  findByResult(result: string, limit = 100) {
    const rows = this.#db
      .prepare(`${selectAuditRowsSql()} WHERE result = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(result, limit) as AuditLogSqlRow[];

    return rows.map(mapAuditRow);
  }

  /** 获取统计数据 */
  getStats(timeRange = '24h') {
    const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 720; // 30d
    const startTime = Date.now() - hours * 60 * 60 * 1000;

    const total = readCount(
      this.#db,
      'SELECT COUNT(*) AS count FROM audit_logs WHERE timestamp >= ?',
      [startTime]
    );
    const successCount = readCount(
      this.#db,
      'SELECT COUNT(*) AS count FROM audit_logs WHERE timestamp >= ? AND result = ?',
      [startTime, 'success']
    );
    const failureCount = readCount(
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
      success: successCount,
      failure: failureCount,
      successRate: total > 0 ? `${((successCount / total) * 100).toFixed(2)}%` : '0%',
      avgDuration,
      byActor,
      byAction,
    };
  }

  /**
   * 清理过期审计日志
   * @param [opts.maxAgeDays=90] 保留天数
   */
  cleanup({ maxAgeDays = 90 } = {}) {
    try {
      const cutoff = Date.now() - maxAgeDays * 86400000;
      const result = this.#db.prepare('DELETE FROM audit_logs WHERE timestamp < ?').run(cutoff);
      return { deleted: result.changes || 0 };
    } catch {
      return { deleted: 0 };
    }
  }
}

export default AuditStore;

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

function mapAuditRow(row: AuditLogSqlRow): AuditLogRow {
  return {
    id: row.id,
    timestamp: row.timestamp,
    actor: row.actor,
    actorContext: row.actor_context ?? '{}',
    action: row.action,
    resource: row.resource ?? null,
    operationData: row.operation_data ?? '{}',
    result: row.result,
    errorMessage: row.error_message ?? null,
    duration: row.duration ?? null,
  };
}

function readCount(db: SqliteDatabase, sql: string, params: unknown[]) {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}
