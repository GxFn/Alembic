/**
 * ViolationsStore — Guard 违反记录存储（DB 版）
 * 记录每次 as:audit 运行的审计结果，持久化到 SQLite guard_violations 表。
 * 最多保留 200 条。
 */

const MAX_RUNS = 200;

interface DatabaseLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown>;
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

interface ViolationRecord {
  ruleId?: string;
  severity?: string;
  message?: string;
  [key: string]: unknown;
}

interface RunInput {
  filePath?: string;
  violations?: ViolationRecord[];
  summary?: string;
}

interface RunOutput {
  id: string;
  filePath: string;
  triggeredAt: string;
  violations: ViolationRecord[];
  violationCount: number;
  summary: string;
}

export class ViolationsStore {
  #db: DatabaseLike;

  /**
   * @param {import('better-sqlite3').Database} db - SQLite 数据库实例
   */
  constructor(db: DatabaseLike) {
    this.#db = db;
  }

  // ─── 写入 ─────────────────────────────────────────────

  /**
   * 追加一次 Guard 运行记录
   * @param {{ filePath: string, violations: object[], summary?: string }} run
   * @returns {string} runId
   */
  appendRun(run: RunInput) {
    const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Math.floor(Date.now() / 1000);

    this.#db
      .prepare(`
      INSERT INTO guard_violations (id, file_path, triggered_at, violation_count, summary, violations_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        run.filePath || '',
        new Date().toISOString(),
        (run.violations || []).length,
        run.summary || '',
        JSON.stringify(run.violations || []),
        now
      );

    // 超限截断：保留最新 MAX_RUNS 条
    this.#db
      .prepare(`
      DELETE FROM guard_violations WHERE id NOT IN (
        SELECT id FROM guard_violations ORDER BY created_at DESC LIMIT ?
      )
    `)
      .run(MAX_RUNS);

    return id;
  }

  // ─── 查询 ─────────────────────────────────────────────

  /**
   * 获取所有运行记录（最新在后）
   */
  getRuns() {
    const rows = this.#db.prepare('SELECT * FROM guard_violations ORDER BY created_at ASC').all();
    return rows.map((r) => this.#rowToRun(r));
  }

  /**
   * 按文件路径查询历史
   */
  getRunsByFile(filePath: string) {
    const rows = this.#db
      .prepare('SELECT * FROM guard_violations WHERE file_path = ? ORDER BY created_at ASC')
      .all(filePath);
    return rows.map((r) => this.#rowToRun(r));
  }

  /**
   * 获取最近 N 条记录
   */
  getRecentRuns(n = 20) {
    const rows = this.#db
      .prepare('SELECT * FROM guard_violations ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(n);
    return rows.reverse().map((r) => this.#rowToRun(r));
  }

  /**
   * 获取统计汇总
   */
  getStats() {
    const row = this.#db
      .prepare(`
      SELECT
        COUNT(*)                 AS totalRuns,
        COALESCE(SUM(violation_count), 0) AS totalViolations,
        MAX(triggered_at)        AS lastRunAt
      FROM guard_violations
    `)
      .get() as { totalRuns: number; totalViolations: number; lastRunAt: string | null };

    return {
      totalRuns: row.totalRuns,
      totalViolations: row.totalViolations,
      averageViolationsPerRun:
        row.totalRuns > 0 ? (row.totalViolations / row.totalRuns).toFixed(2) : 0,
      lastRunAt: row.lastRunAt || null,
    };
  }

  /**
   * 按规则 ID 聚合统计
   * 利用 SQLite json_each 展开 violations_json 数组
   * @returns {Array<{ruleId: string, severity: string, count: number}>}
   */
  getStatsByRule() {
    try {
      return this.#db
        .prepare(`
        SELECT
          json_extract(j.value, '$.ruleId') AS ruleId,
          json_extract(j.value, '$.severity') AS severity,
          COUNT(*) AS count
        FROM guard_violations gv, json_each(gv.violations_json) j
        WHERE json_extract(j.value, '$.ruleId') IS NOT NULL
        GROUP BY ruleId, severity
        ORDER BY count DESC
      `)
        .all();
    } catch {
      return [];
    }
  }

  /**
   * 获取趋势数据 — 对比最近两次运行
   * @returns {{ errorsChange: number, warningsChange: number, latestErrors: number, latestWarnings: number, previousErrors: number, previousWarnings: number }}
   */
  getTrend() {
    const recent = this.getRecentRuns(2);
    if (recent.length < 2) {
      const latest = recent[0]?.violations || [];
      return {
        errorsChange: 0,
        warningsChange: 0,
        latestErrors: latest.filter((v) => v.severity === 'error').length,
        latestWarnings: latest.filter((v) => v.severity === 'warning').length,
        previousErrors: 0,
        previousWarnings: 0,
        hasHistory: false,
      };
    }

    const [prev, latest] = recent;
    const latestErrors = latest.violations.filter((v) => v.severity === 'error').length;
    const latestWarnings = latest.violations.filter((v) => v.severity === 'warning').length;
    const previousErrors = prev.violations.filter((v) => v.severity === 'error').length;
    const previousWarnings = prev.violations.filter((v) => v.severity === 'warning').length;

    return {
      errorsChange: latestErrors - previousErrors,
      warningsChange: latestWarnings - previousWarnings,
      latestErrors,
      latestWarnings,
      previousErrors,
      previousWarnings,
      hasHistory: true,
    };
  }

  // ─── 清除 ─────────────────────────────────────────────

  /**
   * 清空所有记录
   */
  clearRuns() {
    this.#db.prepare('DELETE FROM guard_violations').run();
  }

  /**
   * 清除指定规则或文件的记录
   */
  async clearAll() {
    this.clearRuns();
  }

  async clear({ ruleId, file }: { ruleId?: string; file?: string } = {}) {
    if (file) {
      this.#db.prepare('DELETE FROM guard_violations WHERE file_path = ?').run(file);
    } else {
      this.clearRuns();
    }
  }

  /**
   * 兼容 v2 violations.js 路由的 list()
   */
  async list(filters: { file?: string } = {}, { page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;
    let sql = 'SELECT * FROM guard_violations';
    const params: (string | number)[] = [];

    if (filters.file) {
      sql += ' WHERE file_path = ?';
      params.push(filters.file);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.#db.prepare(sql).all(...params);

    const countSql = filters.file
      ? 'SELECT COUNT(*) AS c FROM guard_violations WHERE file_path = ?'
      : 'SELECT COUNT(*) AS c FROM guard_violations';
    const countParams = filters.file ? [filters.file] : [];
    const total = (this.#db.prepare(countSql).get(...countParams) as { c: number }).c;

    return {
      data: rows.map((r) => this.#rowToRun(r)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  // ─── 内部 ─────────────────────────────────────────────

  #rowToRun(row: Record<string, unknown>): RunOutput {
    return {
      id: row.id as string,
      filePath: row.file_path as string,
      triggeredAt: row.triggered_at as string,
      violations: row.violations_json ? JSON.parse(row.violations_json as string) : [],
      violationCount: row.violation_count as number,
      summary: (row.summary as string) || '',
    };
  }
}
