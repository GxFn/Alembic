/** AuditStore - 审计日志存储 */
import { desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../database/drizzle/index.js';
import { getDrizzle } from '../database/drizzle/index.js';
import { auditLogs } from '../database/drizzle/schema.js';

export class AuditStore {
  db: import('better-sqlite3').Database;
  #drizzle: DrizzleDB;
  constructor(db: { getDb: () => import('better-sqlite3').Database }, drizzle?: DrizzleDB) {
    this.db = db.getDb();
    this.#drizzle = drizzle ?? getDrizzle();
  }

  /**
   * 保存审计日志
   * ★ Drizzle 类型安全 INSERT
   */
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
    this.#drizzle
      .insert(auditLogs)
      .values({
        id: entry.id,
        timestamp: entry.timestamp,
        actor: entry.actor,
        actorContext: entry.actor_context,
        action: entry.action,
        resource: entry.resource,
        operationData: entry.operation_data,
        result: entry.result,
        errorMessage: entry.error_message,
        duration: entry.duration,
      })
      .run();
  }

  /** 查询审计日志 */
  query(
    filters: {
      actor?: string;
      action?: string;
      result?: string;
      startDate?: number;
      endDate?: number;
      limit?: number;
    } = {}
  ) {
    let sql = 'SELECT * FROM audit_logs WHERE 1=1';
    const params: (string | number)[] = [];

    if (filters.actor) {
      sql += ' AND actor = ?';
      params.push(filters.actor);
    }

    if (filters.action) {
      sql += ' AND action = ?';
      params.push(filters.action);
    }

    if (filters.result) {
      sql += ' AND result = ?';
      params.push(filters.result);
    }

    if (filters.startDate) {
      sql += ' AND timestamp >= ?';
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      sql += ' AND timestamp <= ?';
      params.push(filters.endDate);
    }

    sql += ' ORDER BY timestamp DESC';

    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  /**
   * 根据请求 ID 查询
   * ★ Drizzle 类型安全 SELECT
   */
  findByRequestId(requestId: string) {
    return this.#drizzle.select().from(auditLogs).where(eq(auditLogs.id, requestId)).get();
  }

  /**
   * 根据角色查询
   * ★ Drizzle 类型安全 SELECT
   */
  findByActor(actor: string, limit = 100) {
    return this.#drizzle
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actor, actor))
      .orderBy(desc(auditLogs.timestamp))
      .limit(limit)
      .all();
  }

  /**
   * 根据操作查询
   * ★ Drizzle 类型安全 SELECT
   */
  findByAction(action: string, limit = 100) {
    return this.#drizzle
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, action))
      .orderBy(desc(auditLogs.timestamp))
      .limit(limit)
      .all();
  }

  /**
   * 根据结果查询
   * ★ Drizzle 类型安全 SELECT
   */
  findByResult(result: string, limit = 100) {
    return this.#drizzle
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.result, result))
      .orderBy(desc(auditLogs.timestamp))
      .limit(limit)
      .all();
  }

  /** 获取统计数据 */
  getStats(timeRange = '24h') {
    // 计算时间范围
    const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 720; // 30d
    const startTime = Date.now() - hours * 60 * 60 * 1000;

    // 总数统计
    const total = this.db
      .prepare('SELECT COUNT(*) as count FROM audit_logs WHERE timestamp >= ?')
      .get(startTime) as { count: number };

    // 成功/失败统计
    const successCount = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM audit_logs WHERE timestamp >= ? AND result = 'success'"
      )
      .get(startTime) as { count: number };

    const failureCount = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM audit_logs WHERE timestamp >= ? AND result = 'failure'"
      )
      .get(startTime) as { count: number };

    // 按角色统计
    const byActor = this.db
      .prepare(`
        SELECT actor, COUNT(*) as count
        FROM audit_logs
        WHERE timestamp >= ?
        GROUP BY actor
        ORDER BY count DESC
      `)
      .all(startTime);

    // 按操作统计
    const byAction = this.db
      .prepare(`
        SELECT action, COUNT(*) as count
        FROM audit_logs
        WHERE timestamp >= ?
        GROUP BY action
        ORDER BY count DESC
      `)
      .all(startTime);

    // 平均响应时间
    const avgDuration = this.db
      .prepare(`
        SELECT AVG(duration) as avg_duration
        FROM audit_logs
        WHERE timestamp >= ? AND duration IS NOT NULL
      `)
      .get(startTime) as { avg_duration: number | null };

    return {
      timeRange,
      total: total.count,
      success: successCount.count,
      failure: failureCount.count,
      successRate:
        total.count > 0 ? `${((successCount.count / total.count) * 100).toFixed(2)}%` : '0%',
      avgDuration: avgDuration.avg_duration ? `${Math.round(avgDuration.avg_duration)}ms` : 'N/A',
      byActor,
      byAction,
    };
  }

  /**
   * 清理过期审计日志
   * ★ Drizzle 类型安全 DELETE
   * @param [opts.maxAgeDays=90] 保留天数，超过此天数的记录将被删除
   * @returns }
   */
  cleanup({ maxAgeDays = 90 } = {}) {
    try {
      const cutoff = Date.now() - maxAgeDays * 86400000;
      const result = this.#drizzle
        .delete(auditLogs)
        .where(sql`${auditLogs.timestamp} < ${cutoff}`)
        .run();
      return { deleted: result.changes || 0 };
    } catch {
      return { deleted: 0 };
    }
  }
}

export default AuditStore;
