/**
 * Drizzle ORM 实例管理
 *
 * 延迟初始化 — 在 DatabaseConnection.connect() 之后由 initDrizzle() 激活。
 * 新旧代码共存：drizzle 和 raw better-sqlite3 可同时操作同一个连接。
 */

import type { Database } from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type DrizzleDB = BetterSQLite3Database<typeof schema>;

/** 单例实例（延迟初始化） */
let _drizzle: DrizzleDB | null = null;

/**
 * 初始化 Drizzle ORM 实例
 * @param betterSqlite3Db raw better-sqlite3 Database 实例
 * @returns Drizzle 包装实例
 */
export function initDrizzle(betterSqlite3Db: Database): DrizzleDB {
  _drizzle = drizzle(betterSqlite3Db, { schema });
  return _drizzle;
}

/**
 * 获取已初始化的 Drizzle 实例
 * @deprecated 优先使用 DatabaseConnection.getDrizzle() 或通过 DI 注入。
 *             全局单例将在未来版本移除。
 * @throws 若未调用 initDrizzle() 则抛错
 */
export function getDrizzle(): DrizzleDB {
  if (!_drizzle) {
    throw new Error(
      'Drizzle not initialized. Call initDrizzle() after DatabaseConnection.connect().'
    );
  }
  return _drizzle;
}

/** 重置 Drizzle 实例（测试用） */
export function resetDrizzle(): void {
  _drizzle = null;
}

// Re-export schema for convenience
export { schema };
