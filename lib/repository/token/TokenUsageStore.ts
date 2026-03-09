/**
 * TokenUsageStore — Token 消耗持久化存储 (Drizzle ORM)
 *
 * 写入 AI 调用的 token 用量记录到 SQLite token_usage 表。
 * 提供近 7 日按日/按来源的聚合查询。
 *
 * Drizzle 迁移策略：
 * - INSERT 使用 drizzle 类型安全 API（列名编译期检查）
 * - 聚合查询保留预编译 raw SQL（DATE() / GROUP BY computed-column
 *   在 drizzle query builder 中不够直观，保持原有高效预编译语句）
 */

import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import { getDrizzle } from '../../infrastructure/database/drizzle/index.js';
import { tokenUsage } from '../../infrastructure/database/drizzle/schema.js';
import Logger from '../../infrastructure/logging/Logger.js';

const MAX_ROWS = 10000; // 自动清理: 保留最近 10000 条

/** Token usage record input */
interface TokenRecord {
  source: string;
  dimension?: string;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
  toolCalls?: number;
  sessionId?: string;
}

/** Daily aggregation row */
interface DailyRow {
  date: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  call_count: number;
}

/** Source aggregation row */
interface BySourceRow {
  source: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  call_count: number;
}

/** Summary row */
interface SummaryRow {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  call_count: number;
}

/** 7-day report data */
interface ReportData {
  daily: DailyRow[];
  bySource: BySourceRow[];
  summary: SummaryRow & { avg_per_call: number };
}

export class TokenUsageStore {
  #drizzle: DrizzleDB;
  #db;
  #logger;
  #pruneStmt;
  #dailyStmt;
  #bySourceStmt;
  #summaryStmt;
  /** @type {{ data: object, expireAt: number } | null} */
  #reportCache: { data: ReportData; expireAt: number } | null = null;

  /** @param db — raw better-sqlite3 instance */
  constructor(db: import('better-sqlite3').Database, drizzle?: DrizzleDB) {
    this.#db = db;
    this.#drizzle = drizzle ?? getDrizzle();
    this.#logger = Logger.getInstance();

    // 聚合查询保留预编译语句（使用 SQLite 特有函数，drizzle query builder 不方便表达）
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
   * ★ 使用 drizzle 类型安全 INSERT — 列名拼写编译期检查
   */
  record(record: TokenRecord) {
    try {
      const now = Date.now();
      const total = (record.inputTokens || 0) + (record.outputTokens || 0);
      if (total === 0) {
        return; // 跳过无消耗的调用
      }

      this.#drizzle
        .insert(tokenUsage)
        .values({
          timestamp: now,
          source: record.source || 'unknown',
          dimension: record.dimension ?? null,
          provider: record.provider ?? null,
          model: record.model ?? null,
          inputTokens: record.inputTokens || 0,
          outputTokens: record.outputTokens || 0,
          totalTokens: total,
          durationMs: record.durationMs ?? null,
          toolCalls: record.toolCalls || 0,
          sessionId: record.sessionId ?? null,
        })
        .run();

      // 写入后使缓存失效
      this.#reportCache = null;

      // 定期清理（每 100 次写入检查一次）
      if (Math.random() < 0.01) {
        this.#pruneStmt.run(MAX_ROWS);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.#logger.debug('[TokenUsageStore] record failed', { error: message });
    }
  }

  // ─── 查询 ─────────────────────────────────────────

  /**
   * 近 7 日按日聚合统计
   * @returns >}
   */
  getLast7DaysDaily(): DailyRow[] {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return this.#dailyStmt.all(sevenDaysAgo) as DailyRow[];
  }

  /**
   * 近 7 日按来源 (source) 聚合统计
   * @returns >}
   */
  getLast7DaysBySource(): BySourceRow[] {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return this.#bySourceStmt.all(sevenDaysAgo) as BySourceRow[];
  }

  /**
   * 近 7 日总计
   * @returns }
   */
  getLast7DaysSummary(): SummaryRow & { avg_per_call: number } {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const row = this.#summaryStmt.get(sevenDaysAgo) as SummaryRow;
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
