/**
 * KnowledgeUnitOfWork — 知识实体写操作的原子协调器
 *
 * 策略: "文件优先 + DB 补偿"
 *
 *   1. 收集所有 DB 变更意图（不执行）
 *   2. 依次执行文件操作（writeFileSync 同步写入）
 *   3. 若任何文件操作失败 → 回滚已完成的文件操作，整体中止
 *   4. 全部文件操作成功 → 开启 SQLite 事务，提交所有 DB 变更
 *   5. 若 DB 事务失败 → 文件已写入，下次 SyncService 扫描自动重建 DB
 *
 * 为何 "文件优先" 而非 "DB 优先"？
 *   - .md 文件 = 唯一真相源（第一原则）
 *   - 文件写成功 + DB 失败 → SyncService 可从文件重建 DB ✅
 *   - DB 写成功 + 文件写失败 → DB 有记录但无对应文件
 *     → SyncService 会标记 deprecated → 数据丢失 ❌
 *   - 文件优先确保：无论哪步失败，.md 文件的存在性始终是判定真相的依据
 *
 * 当前代码现状（改造前）：
 *   - KnowledgeService.create/update: DB 先 → file 后（不一致风险）
 *   - KnowledgeService.delete: file 先 → DB 后（已是正确顺序）
 *   - 本 UoW 统一所有操作为 file-first
 */

import type { KnowledgeEntry } from '../../domain/knowledge/KnowledgeEntry.js';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import Logger from '../../infrastructure/logging/Logger.js';
import type { DrizzleTx } from '../base/RepositoryBase.js';
import type { KnowledgeFileStore } from './KnowledgeFileStore.js';

/* ═══ 类型定义 ═══ */

export interface PendingFileOp {
  type: 'write' | 'move' | 'delete';
  entry: KnowledgeEntry;
  /** move 操作的旧路径（用于回滚时恢复） */
  oldPath?: string;
}

export interface UnitOfWorkResult {
  /** DB 事务是否成功提交 */
  dbCommitted: boolean;
  /** 完成的文件操作列表 */
  fileOpsCompleted: number;
}

export class FileWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FileWriteError';
  }
}

/* ═══ UnitOfWork 实现 ═══ */

export class KnowledgeUnitOfWork {
  #drizzle: DrizzleDB;
  #fileStore: KnowledgeFileStore;
  #pendingFileOps: PendingFileOp[] = [];
  #dbChanges: Array<(tx: DrizzleTx) => void> = [];
  #completedFileOps: PendingFileOp[] = [];
  #logger = Logger.getInstance();

  constructor(drizzle: DrizzleDB, fileStore: KnowledgeFileStore) {
    this.#drizzle = drizzle;
    this.#fileStore = fileStore;
  }

  /** 注册 DB 变更意图（延迟执行） */
  registerDbChange(fn: (tx: DrizzleTx) => void): void {
    this.#dbChanges.push(fn);
  }

  /** 注册文件操作意图 */
  registerFileOp(op: PendingFileOp): void {
    this.#pendingFileOps.push(op);
  }

  /**
   * 提交：文件操作 → DB 事务
   *
   * 失败模式:
   *   1. 文件写失败：中止，回滚已写文件，不触碰 DB → 干净状态
   *   2. 文件全成功 + DB 失败：文件已持久化 → SyncService 下次扫描自动补 DB
   *   3. 文件全成功 + DB 成功：完美一致
   */
  commit(): UnitOfWorkResult {
    // Phase 1: 文件操作 (must-succeed)
    this.#completedFileOps = [];
    for (const op of this.#pendingFileOps) {
      try {
        this.#executeFileOp(op);
        this.#completedFileOps.push(op);
      } catch (err: unknown) {
        // 回滚已完成的文件操作
        this.#rollbackFileOps();
        this.#reset();
        throw new FileWriteError(`File operation failed: ${op.type} for ${op.entry.id}`, {
          cause: err,
        });
      }
    }

    // Phase 2: DB 事务（文件已安全落盘）
    let dbCommitted = false;
    if (this.#dbChanges.length > 0) {
      try {
        this.#drizzle.transaction((tx) => {
          for (const change of this.#dbChanges) {
            change(tx);
          }
        });
        dbCommitted = true;
      } catch (err: unknown) {
        // DB 失败但文件已写入 → 最终一致性
        // SyncService.reconcile() 下次运行时会从文件重建 DB 记录
        this.#logger.warn('UoW: DB transaction failed after file success', {
          fileOpsCompleted: this.#completedFileOps.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      dbCommitted = true; // 无 DB 变更时视为成功
    }

    const result: UnitOfWorkResult = {
      dbCommitted,
      fileOpsCompleted: this.#completedFileOps.length,
    };

    this.#reset();
    return result;
  }

  /** 回滚：清空所有挂起操作（不执行已注册但未提交的操作） */
  rollback(): void {
    this.#reset();
  }

  #executeFileOp(op: PendingFileOp): void {
    switch (op.type) {
      case 'write':
        this.#fileStore.persist(op.entry);
        break;
      case 'move':
        this.#fileStore.moveOnLifecycleChange(op.entry);
        break;
      case 'delete':
        this.#fileStore.remove(op.entry);
        break;
    }
  }

  /** 尽力回滚已完成的文件操作 */
  #rollbackFileOps(): void {
    for (const op of [...this.#completedFileOps].reverse()) {
      try {
        switch (op.type) {
          case 'write':
            this.#fileStore.remove(op.entry); // 回滚写入 → 删除
            break;
          case 'delete':
            this.#fileStore.persist(op.entry); // 回滚删除 → 重写
            break;
          case 'move':
            // move 回滚较复杂，记录日志等 SyncService 修复
            this.#logger.warn('UoW: Cannot auto-rollback move op', {
              entryId: op.entry.id,
            });
            break;
        }
      } catch {
        // 回滚失败不再抛出，记录日志
        this.#logger.error('UoW: File rollback failed', {
          type: op.type,
          entryId: op.entry.id,
        });
      }
    }
  }

  #reset(): void {
    this.#dbChanges = [];
    this.#pendingFileOps = [];
    this.#completedFileOps = [];
  }
}
