/**
 * RepositoryBase — Drizzle-first 仓储基类
 *
 * 与旧 BaseRepository 的区别：
 * - 构造器接收 DrizzleDB 而非 raw Database
 * - 子类应使用 Drizzle 类型安全 API 实现 CRUD
 * - 保留 rawQuery() 作为复杂查询逃生舱
 * - 无 _assertSafeColumn() —— Drizzle 自带列类型约束
 */

import type { SQLiteTable, SQLiteTransaction } from 'drizzle-orm/sqlite-core';
import type { Logger as WinstonLogger } from 'winston';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import Logger from '../../infrastructure/logging/Logger.js';

/** Drizzle 事务类型 */
export type DrizzleTx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

export interface PaginationOptions {
  page?: number;
  pageSize?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pages: number;
  };
}

/**
 * 新基类：以 Drizzle typed API 为主，raw SQL 为逃生舱。
 *
 * @typeParam TTable  Drizzle 表定义（如 typeof knowledgeEdges）
 * @typeParam TEntity 领域实体类型
 */
export abstract class RepositoryBase<TTable extends SQLiteTable, TEntity> {
  protected readonly drizzle: DrizzleDB;
  protected readonly table: TTable;
  protected readonly logger: WinstonLogger;

  constructor(drizzle: DrizzleDB, table: TTable) {
    this.drizzle = drizzle;
    this.table = table;
    this.logger = Logger.getInstance();
  }

  /**
   * Drizzle 事务包装 — 所有 DB 变更意图应在事务内执行
   */
  protected transaction<R>(fn: (tx: DrizzleTx) => R): R {
    return this.drizzle.transaction(fn);
  }

  abstract findById(id: string | number): Promise<TEntity | null>;
  abstract create(data: unknown): Promise<TEntity>;
  abstract delete(id: string | number): Promise<boolean>;
}
