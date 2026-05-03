/**
 * CleanupService — 统一数据清理策略（垃圾桶模式）
 *
 * 提供两种清理模式:
 *   - fullReset(): 全量清理 — 将旧数据打包到时间戳垃圾桶文件夹，DB 表清空
 *   - rescanClean(): Rescan 清理 — 保留 Recipe，清除衍生缓存
 *   - snapshotRecipes(): 快照当前活跃 Recipe 信息
 *   - purgeExpiredTrash(): 清除超时限的垃圾桶文件夹
 *
 * 垃圾桶设计:
 *   - 位于 .asd/.trash/<ISO-timestamp>/ 下
 *   - fullReset 时先将 candidates/ recipes/ skills/ wiki/ 移入垃圾桶，再清 DB
 *   - DB 数据导出为 db-snapshot.jsonl 保存在垃圾桶内
 *   - 超过保留天数(默认 7 天)的垃圾桶在下次 fullReset 或服务启动时自动清除
 *   - 暂不提供恢复功能（需要 merge 处理过于复杂）
 *
 * 保留原则:
 *   - 配置数据 (config.json, constitution.yaml, boxspec.json) 永不清理
 *   - IDE 集成配置 (.vscode/, .cursor/, .github/) 永不清理
 *   - 交付物 (.cursor/rules/alembic-*) 由 R4 重建，不在此清理
 *
 * @module service/cleanup/CleanupService
 */

import fs from 'node:fs';
import path from 'node:path';
import { recipeDimensionIdOrUnknown } from '#domain/dimension/index.js';
import { CANDIDATES_DIR } from '#infra/config/Defaults.js';
import {
  getContextIndexPath,
  getProjectKnowledgePath,
  getProjectRecipesPath,
  getProjectSkillsPath,
} from '#infra/config/Paths.js';
import type { WriteZone } from '#infra/io/WriteZone.js';
import { CONSUMABLE_LIFECYCLES, lifecycleInSql } from '../../domain/knowledge/Lifecycle.js';

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
  /** 垃圾桶信息（fullReset 时填充） */
  trash?: {
    /** 垃圾桶文件夹路径 */
    folder: string;
    /** 移入垃圾桶的文件/目录数 */
    movedItems: number;
    /** DB 快照行数 */
    dbSnapshotRows: number;
  };
  /** 本次清除的过期垃圾桶 */
  purgedTrash?: {
    /** 清除的垃圾桶数 */
    count: number;
    /** 释放的磁盘空间估算 (bytes) */
    freedBytes: number;
  };
}

/** Recipe 快照条目 */
export interface RecipeSnapshotEntry {
  id: string;
  title: string;
  trigger: string;
  dimensionId?: string;
  category: string;
  knowledgeType: string;
  doClause: string;
  sourceFile?: string;
  lifecycle: string;
  /** Recipe 完整内容 (JSON parsed) — Evolution Agent 需要 */
  content?: { markdown?: string; rationale?: string; coreCode?: string };
  /** 源文件引用列表 (JSON parsed) — Evolution Agent 需要 */
  sourceRefs?: string[];
}

/** Recipe 快照 */
export interface RecipeSnapshot {
  count: number;
  entries: RecipeSnapshotEntry[];
  coverageByDimension: Record<string, number>;
}

// ── 常量 ────────────────────────────────────────────────────

/** 垃圾桶根目录（相对于 .asd/） */
const TRASH_DIR = '.trash';

/** 垃圾桶保留天数，超过后自动 purge */
const TRASH_RETENTION_DAYS = 7;

/** DB 快照文件名 */
const DB_SNAPSHOT_FILE = 'db-snapshot.jsonl';

/**
 * fullReset 时清除的所有 DB 表（不含 schema_migrations）
 *
 * ⚠️ 顺序重要：子表必须排在父表之前，否则 FK 约束会阻止 DELETE。
 *   lifecycle_transition_events → knowledge_entries, evolution_proposals
 *   evolution_proposals         → knowledge_entries
 *   recipe_source_refs          → knowledge_entries (CASCADE)
 *   bootstrap_dim_files         → bootstrap_snapshots (CASCADE)
 */
const ALL_DATA_TABLES = [
  // ── FK 子表先删 ──
  'lifecycle_transition_events',
  'recipe_source_refs',
  'evolution_proposals',
  'knowledge_edges',
  'bootstrap_dim_files',
  // ── 父表后删 ──
  'knowledge_entries',
  'bootstrap_snapshots',
  // ── 无 FK 依赖 ──
  'guard_violations',
  'audit_logs',
  'sessions',
  'semantic_memories',
  'code_entities',
  'remote_commands',
  'remote_state',
];

/** rescanClean 时清除的 DB 表（保留知识/进化相关表） */
const RESCAN_CLEAN_TABLES = [
  'bootstrap_dim_files', // FK → bootstrap_snapshots, 先删
  'recipe_source_refs', // FK → knowledge_entries, 先删
  'bootstrap_snapshots',
  'code_entities',
  'guard_violations',
  'semantic_memories',
  'sessions',
  'audit_logs',
  'remote_commands',
  'remote_state',
];

/**
 * forceRescanClean 时清除的 DB 表
 * 保留增量证据（bootstrap_snapshots, bootstrap_dim_files, recipe_source_refs）
 */
const FORCE_RESCAN_CLEAN_TABLES = [
  'code_entities',
  'guard_violations',
  'semantic_memories',
  'sessions',
  'audit_logs',
  'remote_commands',
  'remote_state',
];

// ── CleanupService ──────────────────────────────────────────

export class CleanupService {
  readonly #projectRoot: string;
  readonly #dataRoot: string;
  readonly #logger: CleanupLogger;
  readonly #wz: WriteZone | null;
  #db: SqliteDb | null;

  constructor(opts: {
    projectRoot: string;
    dataRoot?: string;
    db?: unknown;
    logger?: CleanupLogger;
    writeZone?: WriteZone | null;
  }) {
    this.#projectRoot = opts.projectRoot;
    this.#dataRoot = opts.dataRoot || opts.projectRoot;
    this.#logger = opts.logger || { info() {}, warn() {} };
    this.#wz = opts.writeZone || null;
    this.#db = resolveSqliteDb(opts.db);
  }

  /** 更新 DB 引用（fullReset 后重连时调用） */
  setDb(db: unknown): void {
    this.#db = resolveSqliteDb(db);
  }

  // ─── 需求 A：全量清理（垃圾桶模式） ────────────────────

  /**
   * 全量清理 — 用于 bootstrap 冷启动（垃圾桶模式）
   *
   * 流程:
   *   1. 先清除过期垃圾桶（超过 TRASH_RETENTION_DAYS）
   *   2. 创建时间戳垃圾桶文件夹
   *   3. 将 candidates/ recipes/ skills/ wiki/ 移入垃圾桶
   *   4. 导出 DB 关键表数据到 db-snapshot.jsonl
   *   5. 清空 DB 所有数据表
   *   6. 清除向量索引、bootstrap-report、logs 等缓存
   *
   * 保留: config.json、constitution.yaml、boxspec.json、IDE 配置
   */
  async fullReset(): Promise<CleanupResult> {
    const result: CleanupResult = {
      deletedFiles: 0,
      clearedTables: [],
      preservedRecipes: 0,
      errors: [],
    };

    this.#logger.info('[CleanupService] Starting fullReset (trash-bin mode)...');

    // 0. 清除过期垃圾桶
    const purged = this.#purgeExpiredTrash();
    if (purged.count > 0) {
      result.purgedTrash = purged;
      this.#logger.info(`[CleanupService] Purged ${purged.count} expired trash folders`);
    }

    // 1. 创建时间戳垃圾桶文件夹
    const trashFolder = this.#createTrashFolder();
    let movedItems = 0;
    let dbSnapshotRows = 0;

    // 2. 将知识目录移入垃圾桶（move 而非 copy，速度快）
    // Ghost 模式下操作外置工作区的知识目录
    const kbPath = getProjectKnowledgePath(this.#dataRoot);
    const dirsToTrash: Array<{ src: string; name: string }> = [
      { src: path.join(this.#dataRoot, CANDIDATES_DIR), name: 'candidates' },
      { src: getProjectRecipesPath(this.#dataRoot), name: 'recipes' },
      { src: getProjectSkillsPath(this.#dataRoot), name: 'skills' },
      { src: path.join(kbPath, 'wiki'), name: 'wiki' },
    ];

    for (const { src, name } of dirsToTrash) {
      const moved = this.#moveToTrash(src, path.join(trashFolder, name));
      movedItems += moved;
    }

    // 3. 导出 DB 数据到垃圾桶（JSONL 格式，每行一个 {table, row}）
    if (this.#db) {
      dbSnapshotRows = this.#exportDbToTrash(trashFolder);
    }

    // 4. 清空 DB 所有数据表
    if (this.#db) {
      for (const table of ALL_DATA_TABLES) {
        try {
          this.#db.exec(`DELETE FROM ${table}`);
          result.clearedTables.push(table);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('no such table')) {
            result.errors.push(`Failed to clear ${table}: ${msg}`);
            this.#logger.warn(`[CleanupService] DELETE FROM ${table} failed: ${msg}`);
          }
        }
      }
      // tasks 相关表（来自 migration 002，需先删子表）
      for (const table of ['task_events', 'task_dependencies', 'tasks']) {
        try {
          this.#db.exec(`DELETE FROM ${table}`);
          result.clearedTables.push(table);
        } catch {
          /* table may not exist */
        }
      }
    } else {
      this.#logger.warn('[CleanupService] No database reference — DB tables NOT cleared!');
      result.errors.push('DB reference is null, database tables were not cleared');
    }

    for (const { src } of dirsToTrash) {
      if (!fs.existsSync(src)) {
        if (this.#wz) {
          const rel = src.replace(this.#wz.dataRoot, '').replace(/^\//, '');
          this.#wz.ensureDir(this.#wz.data(rel));
        } else {
          fs.mkdirSync(src, { recursive: true });
        }
      }
    }

    // 6. 清除向量索引
    result.deletedFiles += this.#clearDirectory(getContextIndexPath(this.#dataRoot));

    // 7. 删除 bootstrap-report.json
    result.deletedFiles += this.#deleteFile(
      path.join(this.#dataRoot, '.asd', 'bootstrap-report.json')
    );

    // 8. 清除 logs/signals/
    result.deletedFiles += this.#clearDirectory(
      path.join(this.#dataRoot, '.asd', 'logs', 'signals')
    );

    result.deletedFiles += movedItems;
    result.trash = { folder: trashFolder, movedItems, dbSnapshotRows };

    this.#logger.info('[CleanupService] fullReset complete (trash-bin mode)', {
      trashFolder: path.basename(trashFolder),
      movedItems,
      dbSnapshotRows,
      tables: result.clearedTables.length,
      purgedExpired: purged.count,
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
    result.deletedFiles += this.#clearDirectory(path.join(this.#dataRoot, CANDIDATES_DIR));

    // 3. 清空 skills/ 目录
    result.deletedFiles += this.#clearDirectory(getProjectSkillsPath(this.#dataRoot));

    // 4. 清空 wiki/ 目录
    result.deletedFiles += this.#clearDirectory(
      path.join(getProjectKnowledgePath(this.#dataRoot), 'wiki')
    );

    // 5. 删除向量索引
    result.deletedFiles += this.#clearDirectory(getContextIndexPath(this.#dataRoot));

    // 6. 删除 bootstrap-report.json
    result.deletedFiles += this.#deleteFile(
      path.join(this.#dataRoot, '.asd', 'bootstrap-report.json')
    );

    this.#logger.info('[CleanupService] rescanClean complete', {
      tables: result.clearedTables.length,
      files: result.deletedFiles,
      errors: result.errors.length,
    });

    return result;
  }

  // ─── 需求 C：强制 Rescan 清理（保留增量证据） ──────────

  /**
   * 强制 Rescan 清理 — 清除会话态缓存，但保留增量证据
   *
   * 与 rescanClean 的区别：不清 bootstrap_snapshots / bootstrap_dim_files / recipe_source_refs
   * 这些表是增量管线的核心状态，保留以支持后续增量 diff 计算。
   *
   * 清除: 衍生 DB 表（code_entities 等）、pending/rejected/deprecated 知识条目、
   *       candidates/、skills/、wiki/、向量索引、bootstrap-report
   * 保留: recipes/、active/published/staging/evolving 知识条目、
   *       knowledge_edges、evolution_proposals、bootstrap_snapshots、recipe_source_refs
   */
  async forceRescanClean(): Promise<CleanupResult> {
    const result: CleanupResult = {
      deletedFiles: 0,
      clearedTables: [],
      preservedRecipes: 0,
      errors: [],
    };

    this.#logger.info('[CleanupService] Starting forceRescanClean...');

    // 1. 清除衍生 DB 表（不含增量证据表）
    if (this.#db) {
      for (const table of FORCE_RESCAN_CLEAN_TABLES) {
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
    result.deletedFiles += this.#clearDirectory(path.join(this.#dataRoot, CANDIDATES_DIR));

    // 3. 清空 skills/ 目录
    result.deletedFiles += this.#clearDirectory(getProjectSkillsPath(this.#dataRoot));

    // 4. 清空 wiki/ 目录
    result.deletedFiles += this.#clearDirectory(
      path.join(getProjectKnowledgePath(this.#dataRoot), 'wiki')
    );

    // 5. 删除向量索引
    result.deletedFiles += this.#clearDirectory(getContextIndexPath(this.#dataRoot));

    // 6. 删除 bootstrap-report.json
    result.deletedFiles += this.#deleteFile(
      path.join(this.#dataRoot, '.asd', 'bootstrap-report.json')
    );

    this.#logger.info('[CleanupService] forceRescanClean complete', {
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
      const { sql: lcFilter, params: lcParams } = lifecycleInSql(CONSUMABLE_LIFECYCLES);
      const columns = this.#db.prepare('PRAGMA table_info(knowledge_entries)').all() as Array<{
        name: string;
      }>;
      const hasDimensionId = columns.some((column) => column.name === 'dimensionId');
      const rows = this.#db
        .prepare(
          // @escape-hatch(permanent) — dynamic lifecycle filter + json_extract
          `SELECT id, title, trigger, ${hasDimensionId ? 'dimensionId' : "'' AS dimensionId"},
                  category, knowledgeType, doClause,
                  sourceFile, lifecycle, content, json_extract(reasoning, '$.sources') AS sourceRefsJson
           FROM knowledge_entries
           WHERE ${lcFilter}`
        )
        .all(...lcParams) as Array<{
        id: string;
        title: string;
        trigger: string;
        dimensionId: string | null;
        category: string;
        knowledgeType: string | null;
        doClause: string | null;
        sourceFile: string | null;
        lifecycle: string;
        content: string | null;
        sourceRefsJson: string | null;
      }>;

      const entries: RecipeSnapshotEntry[] = rows.map((r) => {
        let parsedContent: RecipeSnapshotEntry['content'];
        try {
          parsedContent = r.content
            ? (JSON.parse(r.content) as RecipeSnapshotEntry['content'])
            : undefined;
        } catch {
          parsedContent = undefined;
        }
        let parsedSourceRefs: string[] | undefined;
        try {
          parsedSourceRefs = r.sourceRefsJson
            ? (JSON.parse(r.sourceRefsJson) as string[])
            : undefined;
        } catch {
          parsedSourceRefs = undefined;
        }
        return {
          id: r.id,
          title: r.title || '',
          trigger: r.trigger || '',
          dimensionId: r.dimensionId || undefined,
          category: r.category || '',
          knowledgeType: r.knowledgeType || 'code-pattern',
          doClause: r.doClause || '',
          sourceFile: r.sourceFile || undefined,
          lifecycle: r.lifecycle,
          content: parsedContent,
          sourceRefs: parsedSourceRefs,
        };
      });

      // 按维度统计覆盖度。新数据使用 dimensionId；旧数据由 resolver 兼容回推。
      const coverageByDimension: Record<string, number> = {};
      for (const entry of entries) {
        const dim = recipeDimensionIdOrUnknown(entry);
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

  // ─── 垃圾桶管理 ───────────────────────────────────────

  /**
   * 清除超过保留期限的垃圾桶文件夹
   * 可在服务启动时或 fullReset 前调用
   */
  purgeExpiredTrash(): { count: number; freedBytes: number; folders: string[] } {
    return this.#purgeExpiredTrash();
  }

  /**
   * 列出当前所有垃圾桶（供 Dashboard 展示）
   */
  listTrashFolders(): Array<{ name: string; createdAt: Date; sizeMB: number }> {
    const trashRoot = this.#getTrashRoot();
    if (!fs.existsSync(trashRoot)) {
      return [];
    }
    const entries = fs.readdirSync(trashRoot).sort().reverse();
    return entries
      .filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name))
      .map((name) => {
        const fullPath = path.join(trashRoot, name);
        const stat = fs.statSync(fullPath);
        return {
          name,
          createdAt: stat.birthtime,
          sizeMB: Math.round((this.#getDirSize(fullPath) / 1024 / 1024) * 100) / 100,
        };
      });
  }

  // ─── 内部工具方法 ─────────────────────────────────────

  /** 获取垃圾桶根目录 (.asd/.trash/) — Ghost 模式下在外置工作区 */
  #getTrashRoot(): string {
    return path.join(this.#dataRoot, '.asd', TRASH_DIR);
  }

  #createTrashFolder(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const trashFolder = path.join(this.#getTrashRoot(), ts);
    if (this.#wz) {
      const rel = trashFolder.replace(this.#wz.dataRoot, '').replace(/^\//, '');
      this.#wz.ensureDir(this.#wz.data(rel));
    } else {
      fs.mkdirSync(trashFolder, { recursive: true });
    }
    return trashFolder;
  }

  /**
   * 将源目录内容移入垃圾桶对应子目录
   * 使用 rename 实现（同文件系统内是原子操作，速度极快）
   * @returns 移动的顶层条目数
   */
  #moveToTrash(srcDir: string, trashSubDir: string): number {
    if (!fs.existsSync(srcDir)) {
      return 0;
    }
    const entries = fs.readdirSync(srcDir);
    if (entries.length === 0) {
      return 0;
    }

    if (this.#wz) {
      const trashRel = trashSubDir.replace(this.#wz.dataRoot, '').replace(/^\//, '');
      this.#wz.ensureDir(this.#wz.data(trashRel));
    } else {
      fs.mkdirSync(trashSubDir, { recursive: true });
    }
    let count = 0;
    for (const entry of entries) {
      const src = path.join(srcDir, entry);
      const dest = path.join(trashSubDir, entry);
      try {
        if (this.#wz) {
          const srcRel = src.replace(this.#wz.dataRoot, '').replace(/^\//, '');
          const destRel = dest.replace(this.#wz.dataRoot, '').replace(/^\//, '');
          this.#wz.rename(this.#wz.data(srcRel), this.#wz.data(destRel));
        } else {
          fs.renameSync(src, dest);
        }
        count++;
      } catch {
        try {
          fs.cpSync(src, dest, { recursive: true });
          fs.rmSync(src, { recursive: true, force: true });
          count++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.#logger.warn(`[CleanupService] Failed to move ${entry} to trash: ${msg}`);
        }
      }
    }
    return count;
  }

  /**
   * 导出 DB 关键表数据到垃圾桶（JSONL 格式）
   * 只导出有实际业务数据的表，跳过纯缓存表
   */
  #exportDbToTrash(trashFolder: string): number {
    if (!this.#db) {
      return 0;
    }

    const tablesToExport = [
      'knowledge_entries',
      'knowledge_edges',
      'lifecycle_transition_events',
      'evolution_proposals',
      'recipe_source_refs',
      'guard_violations',
    ];

    const snapshotPath = path.join(trashFolder, DB_SNAPSHOT_FILE);
    let totalRows = 0;
    const lines: string[] = [];

    for (const table of tablesToExport) {
      try {
        const rows = this.#db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]; // @escape-hatch(permanent) — dynamic table name for backup export
        for (const row of rows) {
          lines.push(JSON.stringify({ _table: table, ...row }));
          totalRows++;
        }
      } catch {
        // 表可能不存在，跳过
      }
    }

    if (lines.length > 0) {
      const content = `${lines.join('\n')}\n`;
      if (this.#wz) {
        const rel = snapshotPath.replace(this.#wz.dataRoot, '').replace(/^\//, '');
        this.#wz.writeFile(this.#wz.data(rel), content);
      } else {
        fs.writeFileSync(snapshotPath, content, 'utf-8');
      }
      this.#logger.info(`[CleanupService] DB snapshot: ${totalRows} rows → ${DB_SNAPSHOT_FILE}`);
    }

    return totalRows;
  }

  /** 清除过期垃圾桶文件夹 */
  #purgeExpiredTrash(): { count: number; freedBytes: number; folders: string[] } {
    const trashRoot = this.#getTrashRoot();
    if (!fs.existsSync(trashRoot)) {
      return { count: 0, freedBytes: 0, folders: [] };
    }

    const now = Date.now();
    const maxAge = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const entries = fs.readdirSync(trashRoot);
    let count = 0;
    let freedBytes = 0;
    const folders: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(trashRoot, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) {
          continue;
        }
        // 从文件夹名解析时间戳（格式: 2026-04-09T14-30-00-000Z）
        const ts = entry.replace(/-(\d{2})-(\d{2})-(\d{3}Z)$/, ':$1:$2.$3');
        const created = new Date(ts).getTime();
        const age = now - (Number.isNaN(created) ? stat.birthtimeMs : created);

        if (age > maxAge) {
          const size = this.#getDirSize(fullPath);
          fs.rmSync(fullPath, { recursive: true, force: true });
          freedBytes += size;
          count++;
          folders.push(entry);
          this.#logger.info(
            `[CleanupService] Purged expired trash: ${entry} (${Math.round(size / 1024)}KB)`
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.#logger.warn(`[CleanupService] Failed to purge trash ${entry}: ${msg}`);
      }
    }

    // 如果垃圾桶根目录为空，也删掉
    try {
      const remaining = fs.readdirSync(trashRoot);
      if (remaining.length === 0) {
        fs.rmdirSync(trashRoot);
      }
    } catch {
      /* ignore */
    }

    return { count, freedBytes, folders };
  }

  /** 递归计算目录大小 (bytes) */
  #getDirSize(dirPath: string): number {
    let size = 0;
    try {
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          size += this.#getDirSize(fullPath);
        } else {
          size += stat.size;
        }
      }
    } catch {
      /* ignore */
    }
    return size;
  }

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
          if (this.#wz) {
            const rel = fullPath.replace(this.#wz.dataRoot, '').replace(/^\//, '');
            this.#wz.remove(this.#wz.data(rel), { recursive: true });
          } else {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              fs.rmSync(fullPath, { recursive: true });
            } else {
              fs.unlinkSync(fullPath);
            }
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
        if (this.#wz) {
          const rel = filePath.replace(this.#wz.dataRoot, '').replace(/^\//, '');
          this.#wz.remove(this.#wz.data(rel));
        } else {
          fs.unlinkSync(filePath);
        }
        return 1;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#logger.warn(`[CleanupService] Failed to delete file ${filePath}: ${msg}`);
    }
    return 0;
  }
}

function resolveSqliteDb(db: unknown): SqliteDb | null {
  if (!db) {
    return null;
  }
  const wrapper = db as DbWrapper;
  if (typeof wrapper.getDb === 'function') {
    return wrapper.getDb();
  }
  return db as SqliteDb;
}
