import type { SqliteDatabase } from '@alembic/core/database';

export interface AuditLogSqlRow {
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

export interface AuditQueryFilters {
  actor?: string;
  action?: string;
  result?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

export interface AuditLogInsertRow {
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
}

export function insertAuditLog(db: SqliteDatabase, entry: AuditLogInsertRow): void {
  db.prepare(
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
  ).run(
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

export function queryAuditLogs(
  db: SqliteDatabase,
  filters: AuditQueryFilters = {}
): AuditLogSqlRow[] {
  const { whereClause, params } = buildAuditWhere(filters);
  const limitClause = filters.limit ? ' LIMIT ?' : '';
  return db
    .prepare(`${selectAuditRowsSql()}${whereClause} ORDER BY timestamp DESC${limitClause}`)
    .all(...params, ...(filters.limit ? [filters.limit] : [])) as AuditLogSqlRow[];
}

export function findAuditLogByRequestId(
  db: SqliteDatabase,
  requestId: string
): AuditLogSqlRow | undefined {
  return db.prepare(`${selectAuditRowsSql()} WHERE id = ? LIMIT 1`).get(requestId) as
    | AuditLogSqlRow
    | undefined;
}

export function findAuditLogsByActor(
  db: SqliteDatabase,
  actor: string,
  limit: number
): AuditLogSqlRow[] {
  return db
    .prepare(`${selectAuditRowsSql()} WHERE actor = ? ORDER BY timestamp DESC LIMIT ?`)
    .all(actor, limit) as AuditLogSqlRow[];
}

export function findAuditLogsByAction(
  db: SqliteDatabase,
  action: string,
  limit: number
): AuditLogSqlRow[] {
  return db
    .prepare(`${selectAuditRowsSql()} WHERE action = ? ORDER BY timestamp DESC LIMIT ?`)
    .all(action, limit) as AuditLogSqlRow[];
}

export function findAuditLogsByResult(
  db: SqliteDatabase,
  result: string,
  limit: number
): AuditLogSqlRow[] {
  return db
    .prepare(`${selectAuditRowsSql()} WHERE result = ? ORDER BY timestamp DESC LIMIT ?`)
    .all(result, limit) as AuditLogSqlRow[];
}

export function readAuditCount(db: SqliteDatabase, sql: string, params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function readAuditGroupCounts(
  db: SqliteDatabase,
  field: 'actor' | 'action',
  startTime: number
): Array<{ actor: string; count: number }> | Array<{ action: string; count: number }> {
  return db
    .prepare(
      `SELECT ${field}, COUNT(*) AS count
       FROM audit_logs
       WHERE timestamp >= ?
       GROUP BY ${field}
       ORDER BY count DESC`
    )
    .all(startTime) as
    | Array<{ actor: string; count: number }>
    | Array<{
        action: string;
        count: number;
      }>;
}

export function readAuditAverageDuration(db: SqliteDatabase, startTime: number): number | null {
  const row = db
    .prepare(
      `SELECT AVG(duration) AS avgDuration
       FROM audit_logs
       WHERE timestamp >= ? AND duration IS NOT NULL`
    )
    .get(startTime) as { avgDuration: number | null } | undefined;
  return row?.avgDuration ?? null;
}

export function deleteAuditLogsBefore(db: SqliteDatabase, cutoff: number): number {
  const result = db.prepare('DELETE FROM audit_logs WHERE timestamp < ?').run(cutoff);
  return result.changes || 0;
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
