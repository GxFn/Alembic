/**
 * DatabaseProvider — 数据库访问抽象接口
 *
 * 用于替代全局 getDrizzle() 单例，使 Repository/Store 通过 DI 获取 Drizzle 实例。
 * 支持多项目场景下的隔离。
 */
import type { DrizzleDB } from '../infrastructure/database/drizzle/index.js';

export interface DatabaseProvider {
  /** 获取 Drizzle ORM 包装实例（类型安全查询） */
  getDrizzle(): DrizzleDB;
  /** 获取 raw better-sqlite3 Database 实例 */
  getDb(): import('better-sqlite3').Database;
}
