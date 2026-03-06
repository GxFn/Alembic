/**
 * AuditStore - 审计日志存储
 */
export class AuditStore {
  db: any;
  constructor(db) {
    this.db = db.getDb();
  }

  /**
   * 保存审计日志
   */
  async save(entry) {
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
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

  /**
   * 查询审计日志
   */
  query(filters: any = {}) {
    let sql = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];

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
   */
  findByRequestId(requestId) {
    const stmt = this.db.prepare('SELECT * FROM audit_logs WHERE id = ?');
    return stmt.get(requestId);
  }

  /**
   * 根据角色查询
   */
  findByActor(actor, limit = 100) {
    const stmt = this.db.prepare(`
      SELECT * FROM audit_logs
      WHERE actor = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(actor, limit);
  }

  /**
   * 根据操作查询
   */
  findByAction(action, limit = 100) {
    const stmt = this.db.prepare(`
      SELECT * FROM audit_logs
      WHERE action = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(action, limit);
  }

  /**
   * 根据结果查询
   */
  findByResult(result, limit = 100) {
    const stmt = this.db.prepare(`
      SELECT * FROM audit_logs
      WHERE result = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(result, limit);
  }

  /**
   * 获取统计数据
   */
  getStats(timeRange = '24h') {
    // 计算时间范围
    const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 720; // 30d
    const startTime = Date.now() - hours * 60 * 60 * 1000;

    // 总数统计
    const total = this.db
      .prepare('SELECT COUNT(*) as count FROM audit_logs WHERE timestamp >= ?')
      .get(startTime);

    // 成功/失败统计
    const successCount = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM audit_logs WHERE timestamp >= ? AND result = 'success'"
      )
      .get(startTime);

    const failureCount = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM audit_logs WHERE timestamp >= ? AND result = 'failure'"
      )
      .get(startTime);

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
      .get(startTime);

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
   * @param {object} [opts]
   * @param {number} [opts.maxAgeDays=90] 保留天数，超过此天数的记录将被删除
   * @returns {{ deleted: number }}
   */
  cleanup({ maxAgeDays = 90 } = {}) {
    try {
      const cutoff = Date.now() - maxAgeDays * 86400000;
      const result = this.db.prepare('DELETE FROM audit_logs WHERE timestamp < ?').run(cutoff);
      return { deleted: result.changes || 0 };
    } catch {
      return { deleted: 0 };
    }
  }
}

export default AuditStore;
