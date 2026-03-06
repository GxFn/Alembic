/**
 * TokenUsageStore — Token 消耗持久化存储
 * 写入 AI 调用的 token 用量记录到 SQLite token_usage 表。
 * 提供近 7 日按日/按来源的聚合查询。
 */

import Logger from '../../infrastructure/logging/Logger.js';

const MAX_ROWS = 10000; // 自动清理: 保留最近 10000 条

export class TokenUsageStore {
  #db;
  #logger;
  #insertStmt;
  #pruneStmt;
  #dailyStmt;
  #bySourceStmt;
  #summaryStmt;
  /** @type {{ data: object, expireAt: number } | null} */
  #reportCache: { data: any; expireAt: number } | null = null;

  /**
   * @param {import('better-sqlite3').Database} db
   */
  constructor(db: any) {
    this.#db = db;
    this.#logger = Logger.getInstance();

    // 预编译常用语句
    this.#insertStmt = this.#db.prepare(`
      INSERT INTO token_usage (timestamp, source, dimension, provider, model, input_tokens, output_tokens, total_tokens, duration_ms, tool_calls, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#pruneStmt = this.#db.prepare(`
      DELETE FROM token_usage WHERE id NOT IN (
        SELECT id FROM token_usage ORDER BY timestamp DESC LIMIT ?
      )
    `);
    this.#dailyStmt = this.#db.prepare(`
      SELECT
        DATE(timestamp / 1000, 'unixepoch', 'localtime') AS date,
        SUM(input_tokens)  AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(total_tokens)  AS total_tokens,
        COUNT(*)           AS call_count
      FROM token_usage
      WHERE timestamp >= ?
      GROUP BY date
      ORDER BY date ASC
    `);
    this.#bySourceStmt = this.#db.prepare(`
      SELECT
        source,
        SUM(input_tokens)  AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(total_tokens)  AS total_tokens,
        COUNT(*)           AS call_count
      FROM token_usage
      WHERE timestamp >= ?
      GROUP BY source
      ORDER BY total_tokens DESC
    `);
    this.#summaryStmt = this.#db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0)  AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0)  AS total_tokens,
        COUNT(*)                        AS call_count
      FROM token_usage
      WHERE timestamp >= ?
    `);
  }

  // ─── 写入 ─────────────────────────────────────────

  /**
   * 记录一次 AI 调用的 token 消耗
   * @param {{ source: string, dimension?: string, provider?: string, model?: string, inputTokens: number, outputTokens: number, durationMs?: number, toolCalls?: number, sessionId?: string }} record
   */
  record(record: any) {
    try {
      const now = Date.now();
      const total = (record.inputTokens || 0) + (record.outputTokens || 0);
      if (total === 0) {
        return; // 跳过无消耗的调用
      }

      this.#insertStmt.run(
        now,
        record.source || 'unknown',
        record.dimension || null,
        record.provider || null,
        record.model || null,
        record.inputTokens || 0,
        record.outputTokens || 0,
        total,
        record.durationMs || null,
        record.toolCalls || 0,
        record.sessionId || null
      );

      // 写入后使缓存失效
      this.#reportCache = null;

      // 定期清理（每 100 次写入检查一次）
      if (Math.random() < 0.01) {
        this.#pruneStmt.run(MAX_ROWS);
      }
    } catch (err: any) {
      this.#logger.debug('[TokenUsageStore] record failed', { error: err.message });
    }
  }

  // ─── 查询 ─────────────────────────────────────────

  /**
   * 近 7 日按日聚合统计
   * @returns {Array<{ date: string, input_tokens: number, output_tokens: number, total_tokens: number, call_count: number }>}
   */
  getLast7DaysDaily() {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return this.#dailyStmt.all(sevenDaysAgo);
  }

  /**
   * 近 7 日按来源 (source) 聚合统计
   * @returns {Array<{ source: string, input_tokens: number, output_tokens: number, total_tokens: number, call_count: number }>}
   */
  getLast7DaysBySource() {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return this.#bySourceStmt.all(sevenDaysAgo);
  }

  /**
   * 近 7 日总计
   * @returns {{ input_tokens: number, output_tokens: number, total_tokens: number, call_count: number, avg_per_call: number }}
   */
  getLast7DaysSummary() {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const row = this.#summaryStmt.get(sevenDaysAgo);
    return {
      ...row,
      avg_per_call: row.call_count > 0 ? Math.round(row.total_tokens / row.call_count) : 0,
    };
  }

  /**
   * 获取完整的 7 日报告（前端一次拉取）
   * 带 10s 内存缓存，避免高频请求重复查询
   */
  getLast7DaysReport() {
    const now = Date.now();
    if (this.#reportCache && now < this.#reportCache.expireAt) {
      return this.#reportCache.data;
    }
    const data = {
      daily: this.getLast7DaysDaily(),
      bySource: this.getLast7DaysBySource(),
      summary: this.getLast7DaysSummary(),
    };
    this.#reportCache = { data, expireAt: now + 10_000 }; // 10s 缓存
    return data;
  }
}
