/** AuditStore - 审计日志存储 */

import type { SqliteDatabase } from '@alembic/core/database';
import {
  type AuditLogSqlRow,
  type AuditQueryFilters,
  deleteAuditLogsBefore,
  findAuditLogByRequestId,
  findAuditLogsByAction,
  findAuditLogsByActor,
  findAuditLogsByResult,
  insertAuditLog,
  queryAuditLogs,
  readAuditAverageDuration,
  readAuditCount,
  readAuditGroupCounts,
} from '../database/AuditStoreQueries.js';
import { unwrapSqliteDatabase } from '../database/SqliteDatabaseAccess.js';

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

export class AuditStore {
  #db: SqliteDatabase;

  constructor(db: AuditDatabaseHandle) {
    this.#db = unwrapSqliteDatabase(db) as SqliteDatabase;
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
    insertAuditLog(this.#db, entry);
  }

  /** 查询审计日志 */
  query(filters: AuditQueryFilters = {}) {
    return queryAuditLogs(this.#db, filters).map(mapAuditRow);
  }

  /** 根据请求 ID 查询 */
  findByRequestId(requestId: string) {
    const row = findAuditLogByRequestId(this.#db, requestId);
    return row ? mapAuditRow(row) : undefined;
  }

  /** 根据角色查询 */
  findByActor(actor: string, limit = 100) {
    return findAuditLogsByActor(this.#db, actor, limit).map(mapAuditRow);
  }

  /** 根据操作查询 */
  findByAction(action: string, limit = 100) {
    return findAuditLogsByAction(this.#db, action, limit).map(mapAuditRow);
  }

  /** 根据结果查询 */
  findByResult(result: string, limit = 100) {
    return findAuditLogsByResult(this.#db, result, limit).map(mapAuditRow);
  }

  /** 获取统计数据 */
  getStats(timeRange = '24h') {
    const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 720; // 30d
    const startTime = Date.now() - hours * 60 * 60 * 1000;

    const total = readAuditCount(
      this.#db,
      'SELECT COUNT(*) AS count FROM audit_logs WHERE timestamp >= ?',
      [startTime]
    );
    const successCount = readAuditCount(
      this.#db,
      'SELECT COUNT(*) AS count FROM audit_logs WHERE timestamp >= ? AND result = ?',
      [startTime, 'success']
    );
    const failureCount = readAuditCount(
      this.#db,
      'SELECT COUNT(*) AS count FROM audit_logs WHERE timestamp >= ? AND result = ?',
      [startTime, 'failure']
    );
    const byActor = readAuditGroupCounts(this.#db, 'actor', startTime) as Array<{
      actor: string;
      count: number;
    }>;
    const byAction = readAuditGroupCounts(this.#db, 'action', startTime) as Array<{
      action: string;
      count: number;
    }>;
    const avgValue = readAuditAverageDuration(this.#db, startTime);
    const avgDuration = avgValue ? `${Math.round(Number(avgValue))}ms` : 'N/A';

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
      return { deleted: deleteAuditLogsBefore(this.#db, cutoff) };
    } catch {
      return { deleted: 0 };
    }
  }
}

export default AuditStore;

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
