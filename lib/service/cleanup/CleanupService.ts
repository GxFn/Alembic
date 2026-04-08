/**
 * CleanupService — 统一数据清理策略
 *
 * 提供两种清理模式:
 *   - fullReset(): 全量清理（删除一切知识/缓存/衍生数据），用于 bootstrap 冷启动
 *   - rescanClean(): Rescan 清理（保留 Recipe，清除衍生缓存），用于增量知识更新
 *   - snapshotRecipes(): 快照当前活跃 Recipe 信息
 *
 * 设计原则:
 *   - 配置数据 (config.json, constitution.yaml, boxspec.json) 永不清理
 *   - IDE 集成配置 (.vscode/, .cursor/, .github/) 永不清理
 *   - 交付物 (.cursor/rules/autosnippet-*) 由 R4 重建，不在此清理
 *
 * @module service/cleanup/CleanupService
 */

import fs from 'node:fs';
import path from 'node:path';
import { CANDIDATES_DIR, KNOWLEDGE_BASE_DIR } from '#infra/config/Defaults.js';
import {
  getContextIndexPath,
  getProjectKnowledgePath,
  getProjectRecipesPath,
  getProjectSkillsPath,
} from '#infra/config/Paths.js';

// ── 类型定义 ────────────────────────────────────────────────

/** 最小化 better-sqlite3 Database 接口 */
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

/** DB 可能包含 getDb 方法的包装 */
interface DbWrapper {
  getDb?: () => SqliteDb;
}

/** Logger 接口 */
interface CleanupLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** 清理结果 */
export interface CleanupResult {
  deletedFiles: number;
  clearedTables: string[];
  preservedRecipes: number;
  errors: string[];
}

/** Recipe 快照条目 */
export interface RecipeSnapshotEntry {
  id: string;
  title: string;
  trigger: string;
  category: string;
  knowledgeType: string;
  doClause: string;
  sourceFile?: string;
  lifecycle: string;
}

/** Recipe 快照 */
export interface RecipeSnapshot {
  count: number;
  entries: RecipeSnapshotEntry[];
  coverageByDimension: Record<string, number>;
}

// ── 常量 ────────────────────────────────────────────────────

/** fullReset 时清除的所有 DB 表（不含 schema_migrations） */
const ALL_DATA_TABLES = [
  'knowledge_entries',
  'knowledge_edges',
  'guard_violations',
  'audit_logs',
  'sessions',
  'token_usage',
  'semantic_memories',
  'bootstrap_snapshots',
  'bootstrap_dim_files',
  'code_entities',
  'remote_commands',
  'remote_state',
  'evolution_proposals',
  'recipe_source_refs',
];

/** rescanClean 时清除的 DB 表（保留知识/进化相关表） */
const RESCAN_CLEAN_TABLES = [
  'code_entities',
  'guard_violations',
  'bootstrap_snapshots',
  'bootstrap_dim_files',
  'semantic_memories',
  'sessions',
  'audit_logs',
  'token_usage',
  'remote_commands',
  'remote_state',
  'recipe_source_refs',
];

// ── CleanupService ──────────────────────────────────────────

export class CleanupService {
  readonly #projectRoot: string;
  readonly #logger: CleanupLogger;
  #db: SqliteDb | null;

  constructor(opts: {
    projectRoot: string;
    db?: unknown;
    logger?: CleanupLogger;
  }) {
    this.#projectRoot = opts.projectRoot;
    this.#logger = opts.logger || { info() {}, warn() {} };
    this.#db = opts.db
      ? typeof (opts.db as DbWrapper)?.getDb === 'function'
        ? (opts.db as DbWrapper).getDb!()
        : (opts.db as SqliteDb)
      : null;
  }

  /** 更新 DB 引用（fullReset 后重连时调用） */
  setDb(db: unknown): void {
    this.#db = db
      ? typeof (db as DbWrapper)?.getDb === 'function'
        ? (db as DbWrapper).getDb!()
        : (db as SqliteDb)
      : null;
  }

  // ─── 需求 A：全量清理（删除一切） ─────────────────────

  /**
   * 全量清理 — 用于 bootstrap 冷启动
   *
   * 清除: DB 所有数据表、candidates/、recipes/、skills/、wiki/、
   *       向量索引、bootstrap-report.json、logs/signals/
   * 保留: config.json、constitution.yaml、boxspec.json、IDE 配置
   */
  async fullReset(): Promise<CleanupResult> {
    const result: CleanupResult = {
      deletedFiles: 0,
      clearedTables: [],
      preservedRecipes: 0,
      errors: [],
    };

    this.#logger.info('[CleanupService] Starting fullReset...');

    // 1. 清除 DB 所有数据表
    if (this.#db) {
      for (const table of ALL_DATA_TABLES) {
        try {
          this.#db.exec(`DELETE FROM ${table}`);
          result.clearedTables.push(table);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          // 表可能不存在（未 migrate），跳过
          if (!msg.includes('no such table')) {
            result.errors.push(`Failed to clear ${table}: ${msg}`);
          }
        }
      }
      // 也清除 tasks 相关表（来自 migration 002）
      for (const table of ['tasks', 'task_dependencies', 'task_events']) {
        try {
          this.#db.exec(`DELETE FROM ${table}`);
          result.clearedTables.push(table);
        } catch {
          /* table may not exist */
        }
      }
    }

    // 2. 清空 candidates/ 目录
    result.deletedFiles += this.#clearDirectory(path.join(this.#projectRoot, CANDIDATES_DIR));

    // 3. 清空 recipes/ 目录
    result.deletedFiles += this.#clearDirectory(getProjectRecipesPath(this.#projectRoot));

    // 4. 清空 skills/ 目录
    result.deletedFiles += this.#clearDirectory(getProjectSkillsPath(this.#projectRoot));

    // 5. 清空 wiki/ 目录
    result.deletedFiles += this.#clearDirectory(
      path.join(getProjectKnowledgePath(this.#projectRoot), 'wiki')
    );

    // 6. 删除向量索引
    result.deletedFiles += this.#clearDirectory(getContextIndexPath(this.#projectRoot));

    // 7. 删除 bootstrap-report.json
    result.deletedFiles += this.#deleteFile(
      path.join(getProjectKnowledgePath(this.#projectRoot), '.autosnippet', 'bootstrap-report.json')
    );

    // 8. 清除 logs/signals/
    result.deletedFiles += this.#clearDirectory(
      path.join(getProjectKnowledgePath(this.#projectRoot), '.autosnippet', 'logs', 'signals')
    );

    this.#logger.info('[CleanupService] fullReset complete', {
      tables: result.clearedTables.length,
      files: result.deletedFiles,
      errors: result.errors.length,
    });

    return result;
  }

  // ─── 需求 B：Rescan 清理（保留 Recipe） ───────────────

  /**
   * Rescan 清理 — 保留 Recipe，清除衍生缓存
   *
   * 清除: 衍生 DB 表、pending/rejected/deprecated 知识条目、
   *       candidates/、skills/、wiki/、向量索引、bootstrap-report
   * 保留: recipes/、active/published/staging/evolving 知识条目、
   *       knowledge_edges、evolution_proposals
   */
  async rescanClean(): Promise<CleanupResult> {
    const result: CleanupResult = {
      deletedFiles: 0,
      clearedTables: [],
      preservedRecipes: 0,
      errors: [],
    };

    this.#logger.info('[CleanupService] Starting rescanClean...');

    // 1. 清除衍生 DB 表
    if (this.#db) {
      for (const table of RESCAN_CLEAN_TABLES) {
        try {
          this.#db.exec(`DELETE FROM ${table}`);
          result.clearedTables.push(table);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('no such table')) {
            result.errors.push(`Failed to clear ${table}: ${msg}`);
          }
        }
      }

      // 清除旧候选/废弃条目，保留活跃知识
      try {
        this.#db.exec(
          `DELETE FROM knowledge_entries WHERE lifecycle IN ('pending', 'rejected', 'deprecated')`
        );
        result.clearedTables.push('knowledge_entries (pending/rejected/deprecated)');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to clean old entries: ${msg}`);
      }

      // 也清除 tasks 相关表
      for (const table of ['tasks', 'task_dependencies', 'task_events']) {
        try {
          this.#db.exec(`DELETE FROM ${table}`);
          result.clearedTables.push(table);
        } catch {
          /* table may not exist */
        }
      }
    }

    // 2. 清空 candidates/ 目录
    result.deletedFiles += this.#clearDirectory(path.join(this.#projectRoot, CANDIDATES_DIR));

    // 3. 清空 skills/ 目录
    result.deletedFiles += this.#clearDirectory(getProjectSkillsPath(this.#projectRoot));

    // 4. 清空 wiki/ 目录
    result.deletedFiles += this.#clearDirectory(
      path.join(getProjectKnowledgePath(this.#projectRoot), 'wiki')
    );

    // 5. 删除向量索引
    result.deletedFiles += this.#clearDirectory(getContextIndexPath(this.#projectRoot));

    // 6. 删除 bootstrap-report.json
    result.deletedFiles += this.#deleteFile(
      path.join(getProjectKnowledgePath(this.#projectRoot), '.autosnippet', 'bootstrap-report.json')
    );

    this.#logger.info('[CleanupService] rescanClean complete', {
      tables: result.clearedTables.length,
      files: result.deletedFiles,
      errors: result.errors.length,
    });

    return result;
  }

  // ─── 快照当前 Recipe ──────────────────────────────────

  /**
   * 快照当前活跃 Recipe 信息
   * 用于 rescan 前记录保留的知识条目
   */
  async snapshotRecipes(): Promise<RecipeSnapshot> {
    if (!this.#db) {
      return { count: 0, entries: [], coverageByDimension: {} };
    }

    try {
      const rows = this.#db
        .prepare(
          `SELECT id, title, trigger, category, knowledgeType, doClause, source_file AS sourceFile, lifecycle
           FROM knowledge_entries
           WHERE lifecycle IN ('active', 'staging', 'evolving')`
        )
        .all() as Array<{
        id: string;
        title: string;
        trigger: string;
        category: string;
        knowledgeType: string | null;
        doClause: string | null;
        sourceFile: string | null;
        lifecycle: string;
      }>;

      const entries: RecipeSnapshotEntry[] = rows.map((r) => ({
        id: r.id,
        title: r.title || '',
        trigger: r.trigger || '',
        category: r.category || '',
        knowledgeType: r.knowledgeType || 'code-pattern',
        doClause: r.doClause || '',
        sourceFile: r.sourceFile || undefined,
        lifecycle: r.lifecycle,
      }));

      // 按维度统计覆盖度 (使用 knowledgeType = 维度 id)
      const coverageByDimension: Record<string, number> = {};
      for (const entry of entries) {
        const dim = entry.knowledgeType || 'unknown';
        coverageByDimension[dim] = (coverageByDimension[dim] || 0) + 1;
      }

      return {
        count: entries.length,
        entries,
        coverageByDimension,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#logger.warn(`[CleanupService] snapshotRecipes failed: ${msg}`);
      return { count: 0, entries: [], coverageByDimension: {} };
    }
  }

  // ─── 内部工具方法 ─────────────────────────────────────

  /**
   * 清空目录内容（保留目录本身）
   * @returns 删除的文件数
   */
  #clearDirectory(dirPath: string): number {
    let count = 0;
    try {
      if (!fs.existsSync(dirPath)) {
        return 0;
      }
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true });
          } else {
            fs.unlinkSync(fullPath);
          }
          count++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.#logger.warn(`[CleanupService] Failed to delete ${entry}: ${msg}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#logger.warn(`[CleanupService] clearDirectory failed for ${dirPath}: ${msg}`);
    }
    return count;
  }

  /**
   * 删除单个文件
   * @returns 1 if deleted, 0 otherwise
   */
  #deleteFile(filePath: string): number {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return 1;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#logger.warn(`[CleanupService] Failed to delete file ${filePath}: ${msg}`);
    }
    return 0;
  }
}
