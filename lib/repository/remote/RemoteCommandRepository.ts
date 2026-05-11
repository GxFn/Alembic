/**
 * RemoteCommandRepository — 远程指令队列 + 状态持久化 (Drizzle ORM)
 *
 * 封装 remote_commands 和 remote_state 两张表的所有数据访问，
 * 替代 remote.ts 路由中散落的 18+ 条内联 SQL。
 *
 * Drizzle 迁移策略：
 * - INSERT / UPDATE / SELECT 使用 drizzle 类型安全 API
 * - 简单聚合使用 drizzle sql`` 表达式
 * - 保留 raw prepared statements 用于有性能要求的高频定时器查询
 *
 * @module repository/remote/RemoteCommandRepository
 */

import type { Database } from 'better-sqlite3';
import { and, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import { getDrizzle } from '../../infrastructure/database/drizzle/index.js';
import { remoteCommands, remoteState } from '../../infrastructure/database/drizzle/schema.js';
import Logger from '../../infrastructure/logging/Logger.js';

/** Unix timestamp in seconds */
function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** Remote command row shape (from Drizzle select) */
export interface RemoteCommandRow {
  id: string;
  source: string;
  chatId: string | null;
  messageId: string | null;
  userId: string | null;
  userName: string | null;
  command: string;
  status: string;
  result: string | null;
  createdAt: number;
  claimedAt: number | null;
  completedAt: number | null;
}

/** Input for creating a new remote command */
export interface CreateCommandInput {
  id: string;
  source: string;
  chatId?: string;
  messageId?: string;
  userId?: string;
  userName?: string;
  command: string;
}

/** Status counts for queue diagnostics */
export interface StatusCounts {
  pending: number;
  running: number;
  completed: number;
  timeout: number;
}

export class RemoteCommandRepository {
  #drizzle: DrizzleDB;
  #db: Database;
  #logger;

  // 高频定时器查询保留预编译语句
  #pendingTimeoutStmt;
  #runningTimeoutStmt;
  #countByStatusStmt;

  constructor(db: Database, drizzle?: DrizzleDB) {
    this.#db = db;
    this.#drizzle = drizzle ?? getDrizzle();
    this.#logger = Logger.getInstance();

    // 确保 remote_state 表存在（原 remote.ts 内联 CREATE）
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS remote_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`
    );

    // 预编译高频语句（定时器每 30 秒调用）
    this.#pendingTimeoutStmt = this.#db.prepare(
      'UPDATE remote_commands SET status = ?, completed_at = ? WHERE status = ? AND created_at < ?'
    );
    this.#runningTimeoutStmt = this.#db.prepare(
      'UPDATE remote_commands SET status = ?, completed_at = ? WHERE status = ? AND claimed_at < ?'
    );
    this.#countByStatusStmt = this.#db.prepare(
      'SELECT COUNT(*) as c FROM remote_commands WHERE status = ?'
    );
  }

  // ═══════════════════════════════════════════════════
  //  写入操作
  // ═══════════════════════════════════════════════════

  /** 写入新的远程指令到队列 */
  enqueue(input: CreateCommandInput): void {
    this.#drizzle
      .insert(remoteCommands)
      .values({
        id: input.id,
        source: input.source,
        chatId: input.chatId || '',
        messageId: input.messageId || '',
        userId: input.userId || '',
        userName: input.userName || 'lark_user',
        command: input.command,
        status: 'pending',
        createdAt: unixNow(),
      })
      .run();
  }

  /**
   * 认领一条 pending 指令（CAS: pending → running）
   * @returns 是否成功（0 changes = 已被认领或不存在）
   */
  claim(id: string): boolean {
    const result = this.#drizzle
      .update(remoteCommands)
      .set({ status: 'running', claimedAt: unixNow() })
      .where(and(eq(remoteCommands.id, id), eq(remoteCommands.status, 'pending')))
      .run();
    return result.changes > 0;
  }

  /** 提交指令执行结果（running → completed/failed/...） */
  complete(id: string, resultText: string, status = 'completed'): void {
    this.#drizzle
      .update(remoteCommands)
      .set({
        status,
        result: resultText,
        completedAt: unixNow(),
      })
      .where(eq(remoteCommands.id, id))
      .run();
  }

  /**
   * 批量取消所有 pending 指令（IDE 重连时 flush）
   * @returns 被取消的指令列表
   */
  flushPending(): Array<{ id: string; command: string; createdAt: number }> {
    const now = unixNow();

    // 先查出所有 pending
    const pending = this.#drizzle
      .select({
        id: remoteCommands.id,
        command: remoteCommands.command,
        createdAt: remoteCommands.createdAt,
      })
      .from(remoteCommands)
      .where(eq(remoteCommands.status, 'pending'))
      .orderBy(remoteCommands.createdAt)
      .all();

    if (pending.length === 0) {
      return [];
    }

    // 批量标记为 cancelled
    this.#drizzle
      .update(remoteCommands)
      .set({
        status: 'cancelled',
        result: '🗑 IDE 重连时自动清理（积压指令）',
        completedAt: now,
      })
      .where(eq(remoteCommands.status, 'pending'))
      .run();

    return pending;
  }

  // ═══════════════════════════════════════════════════
  //  查询操作
  // ═══════════════════════════════════════════════════

  /** 获取最早的一条 pending 指令 */
  findFirstPending(): RemoteCommandRow | null {
    const rows = this.#drizzle
      .select()
      .from(remoteCommands)
      .where(eq(remoteCommands.status, 'pending'))
      .orderBy(remoteCommands.createdAt)
      .limit(1)
      .all();
    return (rows[0] as RemoteCommandRow) ?? null;
  }

  /** 根据 ID 获取指令 */
  findById(id: string): RemoteCommandRow | null {
    const rows = this.#drizzle
      .select()
      .from(remoteCommands)
      .where(eq(remoteCommands.id, id))
      .limit(1)
      .all();
    return (rows[0] as RemoteCommandRow) ?? null;
  }

  /** 获取历史记录（按创建时间降序） */
  getHistory(limit = 20): RemoteCommandRow[] {
    return this.#drizzle
      .select()
      .from(remoteCommands)
      .orderBy(desc(remoteCommands.createdAt))
      .limit(limit)
      .all() as RemoteCommandRow[];
  }

  /** 获取各状态的指令计数（用于 /lark/status 诊断面板） */
  getStatusCounts(): StatusCounts {
    const counts: StatusCounts = { pending: 0, running: 0, completed: 0, timeout: 0 };
    for (const s of ['pending', 'running', 'completed', 'timeout'] as const) {
      const row = this.#countByStatusStmt.get(s) as { c: number } | undefined;
      counts[s] = row?.c || 0;
    }
    return counts;
  }

  /** 查找最近一次 claim 记录（用于 IDE 心跳检测） */
  findRecentClaim(): { claimedAt: number } | null {
    const rows = this.#drizzle
      .select({ claimedAt: remoteCommands.claimedAt })
      .from(remoteCommands)
      .where(isNotNull(remoteCommands.claimedAt))
      .orderBy(desc(remoteCommands.claimedAt))
      .limit(1)
      .all();
    const row = rows[0];
    return row?.claimedAt != null ? { claimedAt: row.claimedAt } : null;
  }

  /** 查找最近有 chatId 的指令（用于恢复活跃会话） */
  findRecentChatId(): string | null {
    const rows = this.#drizzle
      .select({ chatId: remoteCommands.chatId })
      .from(remoteCommands)
      .where(sql`${remoteCommands.chatId} != ''`)
      .orderBy(desc(remoteCommands.createdAt))
      .limit(1)
      .all();
    return rows[0]?.chatId || null;
  }

  // ═══════════════════════════════════════════════════
  //  超时清理（定时器使用预编译语句，已验证高频安全）
  // ═══════════════════════════════════════════════════

  /**
   * 清理超时的 pending 和 running 指令
   * @param pendingTimeoutSec pending 状态超时秒数
   * @param runningTimeoutSec running 状态超时秒数
   * @returns 清理的总条数
   */
  cleanupTimeouts(pendingTimeoutSec: number, runningTimeoutSec: number): number {
    const now = unixNow();
    const r1 = this.#pendingTimeoutStmt.run('timeout', now, 'pending', now - pendingTimeoutSec);
    const r2 = this.#runningTimeoutStmt.run('timeout', now, 'running', now - runningTimeoutSec);
    return (r1.changes || 0) + (r2.changes || 0);
  }

  // ═══════════════════════════════════════════════════
  //  remote_state 键值存储
  // ═══════════════════════════════════════════════════

  /** 持久化键值对到 remote_state */
  setState(key: string, value: string): void {
    this.#drizzle
      .insert(remoteState)
      .values({ key, value, updatedAt: unixNow() })
      .onConflictDoUpdate({
        target: remoteState.key,
        set: { value, updatedAt: unixNow() },
      })
      .run();
  }

  /** 从 remote_state 读取值 */
  getState(key: string): string | null {
    const rows = this.#drizzle
      .select({ value: remoteState.value })
      .from(remoteState)
      .where(eq(remoteState.key, key))
      .limit(1)
      .all();
    return rows[0]?.value ?? null;
  }
}
