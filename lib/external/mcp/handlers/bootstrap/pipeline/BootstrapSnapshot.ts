/**
 * BootstrapSnapshot — Bootstrap 快照管理
 *
 * 负责:
 * 1. 保存每次 bootstrap 完成后的文件指纹 (path → hash)
 * 2. 记录每个维度引用了哪些文件
 * 3. 持久化 EpisodicMemory 摘要
 * 4. 提供增量 diff 计算
 *
 * 存储: SQLite bootstrap_snapshots + bootstrap_dim_files 表
 *
 * @module pipeline/BootstrapSnapshot
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { LoggerLike } from '../../types.js';

// ──────────────────────────────────────────────────────────────────
// 本地类型定义
// ──────────────────────────────────────────────────────────────────

/** 最小化 better-sqlite3 Database 接口 */
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
}

/** 最小化 Statement 接口 */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** 所有预编译 SQL 语句 */
interface PreparedStatements {
  insertSnapshot: SqliteStatement;
  insertDimFile: SqliteStatement;
  getLatest: SqliteStatement;
  getById: SqliteStatement;
  listByProject: SqliteStatement;
  getDimFiles: SqliteStatement;
  enforceCapacity: SqliteStatement;
  deleteById: SqliteStatement;
}

/** 快照反序列化结果 */
export interface SnapshotData {
  id: string;
  sessionId: string | null;
  projectRoot: string;
  createdAt: string;
  durationMs: number;
  fileCount: number;
  dimensionCount: number;
  candidateCount: number;
  primaryLang: string | null;
  fileHashes: Record<string, string>;
  dimensionMeta: Record<string, DimensionStatMeta>;
  episodicData: Record<string, unknown> | null;
  isIncremental: boolean;
  parentId: string | null;
  changedFiles: string[];
  affectedDims: string[];
  status: string;
}

/** 文件条目 */
interface SnapshotFile {
  path: string;
  relativePath?: string;
  content?: string;
  targetName?: string;
}

/** save() 参数 */
interface SaveParams {
  sessionId?: string;
  projectRoot: string;
  allFiles: SnapshotFile[];
  dimensionStats?: Record<string, DimensionStatInput>;
  episodicData?: unknown;
  meta?: {
    durationMs?: number;
    candidateCount?: number;
    primaryLang?: string;
    [key: string]: unknown;
  };
  isIncremental?: boolean;
  parentId?: unknown;
  changedFiles?: string[];
  affectedDims?: string[];
}

/** 维度统计输入 */
interface DimensionStatInput {
  candidateCount?: number;
  analysisChars?: number;
  referencedFiles?: number;
  durationMs?: number;
  referencedFilesList?: string[];
  [key: string]: unknown;
}

/** 维度元数据（序列化后） */
interface DimensionStatMeta {
  candidateCount: number;
  analysisChars: number;
  referencedFiles: number;
  durationMs: number;
}

/** Diff 结果 */
export interface DiffResult {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
  changeRatio: number;
}

/** 受影响维度推断结果 */
interface AffectedDimensionResult {
  mode: 'incremental' | 'full';
  dimensions: string[];
  skippedDimensions: string[];
  reason: string;
}

/** db 可能包含 getDb 方法的包装 */
interface DbWrapper {
  getDb?: () => SqliteDb;
}

// ──────────────────────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────────────────────

/** 快照保留数量 (最多保留 N 个历史快照) */
const MAX_SNAPSHOTS = 5;

/** 全量/增量判断阈值: 文件变更超过此比例 → 全量重跑 */
const FULL_REBUILD_THRESHOLD = 0.5;

// ──────────────────────────────────────────────────────────────
// BootstrapSnapshot 类
// ──────────────────────────────────────────────────────────────

export class BootstrapSnapshot {
  #db: SqliteDb;

  #logger: LoggerLike | null;

  #stmts!: PreparedStatements;

  /** @param db better-sqlite3 实例 */
  constructor(db: unknown, { logger }: { logger?: LoggerLike | null } = {}) {
    if (!db) {
      throw new Error('BootstrapSnapshot requires a database instance');
    }
    this.#db =
      typeof (db as DbWrapper)?.getDb === 'function'
        ? (db as DbWrapper).getDb!()
        : (db as SqliteDb);
    this.#logger = logger || null;

    this.#ensureTable();
    this.#prepareStatements();
  }

  // ─── 快照保存 ─────────────────────────────────────────

  /**
   * 保存一次 bootstrap 完成后的快照
   *
   * @param params.sessionId Bootstrap 会话 ID
   * @param params.projectRoot 项目根目录
   * @param params.allFiles 扫描到的文件列表
   * @param params.dimensionStats { dimId: { referencedFiles: string[] } }
   * @param [params.episodicData] EpisodicMemory.toJSON()
   * @param [params.meta] { durationMs, candidateCount, primaryLang }
   * @param [params.isIncremental] 是否增量 bootstrap
   * @param [params.parentId] 增量时的父快照 ID
   * @param [params.changedFiles] 增量时的变更文件
   * @param [params.affectedDims] 增量时受影响的维度
   * @returns 快照 ID
   */
  save(params: SaveParams): string {
    const {
      sessionId,
      projectRoot,
      allFiles,
      dimensionStats,
      episodicData,
      meta = {},
      isIncremental = false,
      parentId = null,
      changedFiles = [],
      affectedDims = [],
    } = params;

    const id = `snap_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
    const now = new Date().toISOString();

    // 计算文件指纹
    const fileHashes: Record<string, string> = {};
    for (const f of allFiles) {
      const rel = f.relativePath || relative(projectRoot, f.path);
      fileHashes[rel] = this.#computeContentHash(f.content || this.#readFileContent(f.path));
    }

    // 构建维度-文件映射
    const dimensionMeta: Record<string, DimensionStatMeta> = {};
    for (const [dimId, stat] of Object.entries(dimensionStats || {}) as [
      string,
      DimensionStatInput,
    ][]) {
      dimensionMeta[dimId] = {
        candidateCount: stat.candidateCount || 0,
        analysisChars: stat.analysisChars || 0,
        referencedFiles: stat.referencedFiles || 0,
        durationMs: stat.durationMs || 0,
      };
    }

    // 事务保存
    const saveTransaction = this.#db.transaction(() => {
      // 主记录
      this.#stmts.insertSnapshot.run({
        id,
        session_id: sessionId || null,
        project_root: projectRoot,
        created_at: now,
        duration_ms: meta.durationMs || 0,
        file_count: allFiles.length,
        dimension_count: Object.keys(dimensionStats || {}).length,
        candidate_count: meta.candidateCount || 0,
        primary_lang: meta.primaryLang || null,
        file_hashes: JSON.stringify(fileHashes),
        dimension_meta: JSON.stringify(dimensionMeta),
        episodic_data: episodicData ? JSON.stringify(episodicData) : null,
        is_incremental: isIncremental ? 1 : 0,
        parent_id: parentId,
        changed_files: JSON.stringify(changedFiles),
        affected_dims: JSON.stringify(affectedDims),
        status: 'complete',
      });

      // 维度-文件关联
      for (const [dimId, stat] of Object.entries(dimensionStats || {}) as [
        string,
        DimensionStatInput,
      ][]) {
        const refFiles = stat.referencedFilesList || [];
        for (const filePath of refFiles) {
          const rel =
            typeof filePath === 'string'
              ? filePath.startsWith('/')
                ? relative(projectRoot, filePath)
                : filePath
              : filePath;
          this.#stmts.insertDimFile.run({
            snapshot_id: id,
            dim_id: dimId,
            file_path: rel,
            role: 'referenced',
          });
        }
      }

      // 容量控制: 保留最新 N 个
      this.#enforceCapacity(projectRoot);
    });

    saveTransaction();

    this.#log(
      `Snapshot saved: ${id} (${allFiles.length} files, ${Object.keys(dimensionStats || {}).length} dims)`
    );
    return id;
  }

  // ─── 快照加载 ─────────────────────────────────────────

  /** 清除项目的所有快照 — 用于手动重新冷启动时强制全量 */
  clearProject(projectRoot: string) {
    try {
      const rows = this.#stmts.listByProject.all(projectRoot, 9999) as { id: string }[];
      for (const row of rows) {
        this.#stmts.deleteById.run(row.id);
      }
      this.#log(`Cleared ${rows.length} snapshots for project`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#log(`clearProject failed: ${msg}`, 'warn');
    }
  }

  /**
   * 加载最新的快照
   *
   * @returns 快照数据
   */
  getLatest(projectRoot: string): SnapshotData | null {
    const row = this.#stmts.getLatest.get(projectRoot);
    if (!row) {
      return null;
    }
    return this.#deserialize(row);
  }

  /** 根据 ID 加载快照 */
  getById(id: string): SnapshotData | null {
    const row = this.#stmts.getById.get(id);
    if (!row) {
      return null;
    }
    return this.#deserialize(row);
  }

  /** 获取项目的所有快照 (按时间降序) */
  list(projectRoot: string, limit = 10): SnapshotData[] {
    return this.#stmts.listByProject
      .all(projectRoot, limit)
      .map((r: Record<string, unknown>) => this.#deserialize(r));
  }

  // ─── 增量 Diff 计算 ──────────────────────────────────

  /**
   * 计算当前文件与快照的 diff
   *
   * @param snapshot getLatest() 返回的快照
   * @param currentFiles 当前文件列表
   * @returns }
   */
  computeDiff(
    snapshot: SnapshotData,
    currentFiles: SnapshotFile[],
    projectRoot: string
  ): DiffResult {
    const oldHashes = snapshot.fileHashes || {};

    // 计算当前文件 hash
    const newHashes: Record<string, string> = {};
    for (const f of currentFiles) {
      const rel = f.relativePath || relative(projectRoot, f.path);
      newHashes[rel] = this.#computeContentHash(f.content || '');
    }

    const added: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];

    // 对比新文件
    for (const [relPath, hash] of Object.entries(newHashes)) {
      if (!(relPath in oldHashes)) {
        added.push(relPath);
      } else if (oldHashes[relPath] !== hash) {
        modified.push(relPath);
      } else {
        unchanged.push(relPath);
      }
    }

    // 已删除的文件
    const deleted = Object.keys(oldHashes).filter((p) => !(p in newHashes));

    const totalFiles = Object.keys(newHashes).length || 1;
    const changedCount = added.length + modified.length + deleted.length;
    const changeRatio = changedCount / totalFiles;

    return { added, modified, deleted, unchanged, changeRatio };
  }

  // ─── 受影响维度推断 ──────────────────────────────────

  /**
   * 根据文件变更推断受影响的维度
   *
   * 策略:
   * 1. 查找变更文件被哪些维度引用 → 直接受影响
   * 2. 新增文件按文件类型推断可能相关的维度
   * 3. 如果变更比例超过阈值 → 建议全量
   *
   * @param snapshot 上次快照
   * @param diff
   * @param allDimIds 所有可用维度 ID
   * @returns }
   */
  inferAffectedDimensions(
    snapshot: SnapshotData,
    diff: DiffResult,
    allDimIds: string[]
  ): AffectedDimensionResult {
    const changeRatio =
      (diff.added.length + diff.modified.length + diff.deleted.length) /
      (diff.added.length +
        diff.modified.length +
        diff.deleted.length +
        (diff.unchanged?.length || 0) || 1);

    // 变更超过 50% → 全量
    if (changeRatio > FULL_REBUILD_THRESHOLD) {
      return {
        mode: 'full',
        dimensions: allDimIds,
        skippedDimensions: [],
        reason: `变更比例 ${(changeRatio * 100).toFixed(0)}% 超过阈值 (${(FULL_REBUILD_THRESHOLD * 100).toFixed(0)}%)，建议全量冷启动`,
      };
    }

    // 没有变更 → 跳过所有
    if (diff.added.length === 0 && diff.modified.length === 0 && diff.deleted.length === 0) {
      return {
        mode: 'incremental',
        dimensions: [],
        skippedDimensions: allDimIds,
        reason: '无文件变更，所有维度使用历史结果',
      };
    }

    const affected = new Set();
    const changedFiles = [...diff.added, ...diff.modified, ...diff.deleted];

    // 1. 从快照的 dimensionMeta 推断 — 查找维度引用了哪些变更文件
    const dimFileMap = this.#getDimFileMap(snapshot.id);
    for (const [dimId, files] of Object.entries(dimFileMap) as [string, Set<string>][]) {
      for (const changedFile of changedFiles) {
        if (files.has(changedFile)) {
          affected.add(dimId);
          break;
        }
      }
    }

    // 2. 新增文件: 按文件类型推断
    for (const addedFile of diff.added) {
      const inferredDims = this.#inferDimsByFileType(addedFile);
      for (const dim of inferredDims) {
        affected.add(dim);
      }
    }

    // 3. 删除文件: 引用了已删除文件的维度需要更新
    // (已在步骤 1 中处理)

    // 4. 始终包含 project-profile (它是全局概览)
    if (changedFiles.length > 0) {
      affected.add('project-profile');
    }

    const dimensions = allDimIds.filter((d: string) => affected.has(d));
    const skippedDimensions = allDimIds.filter((d: string) => !affected.has(d));

    return {
      mode: 'incremental',
      dimensions,
      skippedDimensions,
      reason: `${changedFiles.length} 个文件变更影响 ${dimensions.length}/${allDimIds.length} 个维度`,
    };
  }

  // ─── 维度-文件映射查询 ──────────────────────────────

  /** 获取某个快照中每个维度引用的文件集合 */
  #getDimFileMap(snapshotId: string): Record<string, Set<string>> {
    const rows = this.#stmts.getDimFiles.all(snapshotId) as { dim_id: string; file_path: string }[];
    const map: Record<string, Set<string>> = {};
    for (const row of rows) {
      if (!map[row.dim_id]) {
        map[row.dim_id] = new Set();
      }
      map[row.dim_id].add(row.file_path);
    }
    return map;
  }

  /** 根据文件扩展名推断可能相关的维度 */
  #inferDimsByFileType(filePath: string): string[] {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const name = filePath.split('/').pop()?.toLowerCase() || '';

    const dims: string[] = [];

    // ObjC 文件 → objc-deep-scan
    if (['m', 'mm', 'h'].includes(ext)) {
      dims.push('objc-deep-scan');
    }

    // Category 文件
    if (name.includes('+') || name.includes('category')) {
      dims.push('category-scan');
    }

    // Swift 相关
    if (ext === 'swift') {
      dims.push('code-standard', 'architecture');
    }

    // TS/JS 相关
    if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(ext)) {
      dims.push('module-export-scan', 'code-standard', 'architecture');
    }

    // Python 相关
    if (ext === 'py') {
      dims.push('python-package-scan', 'code-standard', 'architecture');
    }

    // Java/Kotlin 相关
    if (['java', 'kt', 'kts'].includes(ext)) {
      dims.push('jvm-annotation-scan', 'code-standard', 'architecture');
    }

    // 配置文件
    if (
      ['json', 'yaml', 'yml', 'plist', 'xcconfig', 'toml', 'properties', 'gradle'].includes(ext)
    ) {
      dims.push('project-profile');
    }

    // 通用: 代码文件都可能影响 code-pattern 和 best-practice
    if (
      [
        'm',
        'mm',
        'h',
        'swift',
        'js',
        'jsx',
        'ts',
        'tsx',
        'mjs',
        'cjs',
        'py',
        'java',
        'kt',
        'kts',
        'go',
        'rs',
        'rb',
      ].includes(ext)
    ) {
      dims.push('code-pattern', 'best-practice');
    }

    // 数据流相关
    if (
      name.includes('manager') ||
      name.includes('service') ||
      name.includes('event') ||
      name.includes('notification') ||
      name.includes('delegate')
    ) {
      dims.push('event-and-data-flow');
    }

    return [...new Set(dims)];
  }

  // ─── 内部方法 ─────────────────────────────────────────

  #computeContentHash(content: string): string {
    return createHash('sha256')
      .update(content || '')
      .digest('hex')
      .substring(0, 16);
  }

  #readFileContent(filePath: string): string {
    try {
      return readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  #enforceCapacity(projectRoot: string) {
    try {
      this.#stmts.enforceCapacity.run(projectRoot, projectRoot, MAX_SNAPSHOTS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#log(`Capacity enforcement failed: ${msg}`, 'warn');
    }
  }

  #deserialize(row: Record<string, unknown>): SnapshotData {
    return {
      id: row.id as string,
      sessionId: (row.session_id as string) ?? null,
      projectRoot: row.project_root as string,
      createdAt: row.created_at as string,
      durationMs: row.duration_ms as number,
      fileCount: row.file_count as number,
      dimensionCount: row.dimension_count as number,
      candidateCount: row.candidate_count as number,
      primaryLang: (row.primary_lang as string) ?? null,
      fileHashes: this.#safeParseJSON(row.file_hashes, {} as Record<string, string>),
      dimensionMeta: this.#safeParseJSON(
        row.dimension_meta,
        {} as Record<string, DimensionStatMeta>
      ),
      episodicData: this.#safeParseJSON(row.episodic_data, null as Record<string, unknown> | null),
      isIncremental: !!row.is_incremental,
      parentId: (row.parent_id as string) ?? null,
      changedFiles: this.#safeParseJSON(row.changed_files, [] as string[]),
      affectedDims: this.#safeParseJSON(row.affected_dims, [] as string[]),
      status: row.status as string,
    };
  }

  #safeParseJSON<T>(str: unknown, fallback: T): T {
    try {
      return str ? JSON.parse(str as string) : fallback;
    } catch {
      return fallback;
    }
  }

  #log(msg: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info') {
    if (this.#logger && this.#logger[level]) {
      this.#logger[level]!(`[BootstrapSnapshot] ${msg}`);
    }
  }

  // ─── 初始化 ───────────────────────────────────────────

  #ensureTable() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS bootstrap_snapshots (
        id               TEXT PRIMARY KEY,
        session_id       TEXT,
        project_root     TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        duration_ms      INTEGER DEFAULT 0,
        file_count       INTEGER DEFAULT 0,
        dimension_count  INTEGER DEFAULT 0,
        candidate_count  INTEGER DEFAULT 0,
        primary_lang     TEXT,
        file_hashes      TEXT NOT NULL DEFAULT '{}',
        dimension_meta   TEXT NOT NULL DEFAULT '{}',
        episodic_data    TEXT,
        is_incremental   INTEGER DEFAULT 0,
        parent_id        TEXT,
        changed_files    TEXT DEFAULT '[]',
        affected_dims    TEXT DEFAULT '[]',
        status           TEXT DEFAULT 'complete'
      );

      CREATE TABLE IF NOT EXISTS bootstrap_dim_files (
        snapshot_id      TEXT NOT NULL,
        dim_id           TEXT NOT NULL,
        file_path        TEXT NOT NULL,
        role             TEXT DEFAULT 'referenced',
        PRIMARY KEY (snapshot_id, dim_id, file_path),
        FOREIGN KEY (snapshot_id) REFERENCES bootstrap_snapshots(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_project
        ON bootstrap_snapshots(project_root, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dim_files_file
        ON bootstrap_dim_files(file_path);
    `);
  }

  #prepareStatements() {
    this.#stmts = {
      insertSnapshot: this.#db.prepare(`
        INSERT INTO bootstrap_snapshots
          (id, session_id, project_root, created_at, duration_ms,
           file_count, dimension_count, candidate_count, primary_lang,
           file_hashes, dimension_meta, episodic_data,
           is_incremental, parent_id, changed_files, affected_dims, status)
        VALUES
          (@id, @session_id, @project_root, @created_at, @duration_ms,
           @file_count, @dimension_count, @candidate_count, @primary_lang,
           @file_hashes, @dimension_meta, @episodic_data,
           @is_incremental, @parent_id, @changed_files, @affected_dims, @status)
      `),

      insertDimFile: this.#db.prepare(`
        INSERT OR IGNORE INTO bootstrap_dim_files (snapshot_id, dim_id, file_path, role)
        VALUES (@snapshot_id, @dim_id, @file_path, @role)
      `),

      getLatest: this.#db.prepare(`
        SELECT * FROM bootstrap_snapshots
        WHERE project_root = ? AND status = 'complete'
        ORDER BY created_at DESC
        LIMIT 1
      `),

      getById: this.#db.prepare(`
        SELECT * FROM bootstrap_snapshots WHERE id = ?
      `),

      listByProject: this.#db.prepare(`
        SELECT * FROM bootstrap_snapshots
        WHERE project_root = ?
        ORDER BY created_at DESC
        LIMIT ?
      `),

      getDimFiles: this.#db.prepare(`
        SELECT dim_id, file_path FROM bootstrap_dim_files
        WHERE snapshot_id = ?
      `),

      enforceCapacity: this.#db.prepare(`
        DELETE FROM bootstrap_snapshots
        WHERE project_root = ?
        AND id NOT IN (
          SELECT id FROM bootstrap_snapshots
          WHERE project_root = ?
          ORDER BY created_at DESC
          LIMIT ?
        )
      `),

      deleteById: this.#db.prepare(`
        DELETE FROM bootstrap_snapshots WHERE id = ?
      `),
    };
  }
}

export default BootstrapSnapshot;
