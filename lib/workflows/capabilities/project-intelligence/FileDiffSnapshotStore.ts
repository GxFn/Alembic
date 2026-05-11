/**
 * FileDiffSnapshotStore — workflow 文件快照管理
 *
 * 负责:
 * 1. 保存每次 workflow 完成后的文件指纹 (path → hash)
 * 2. 记录每个维度引用了哪些文件
 * 3. 持久化 EpisodicMemory 摘要
 * 4. 提供增量 diff 计算
 *
 * 存储: SQLite bootstrap_snapshots + bootstrap_dim_files 表（runtime schema 兼容名）
 * 所有操作使用 Drizzle 类型安全 API。
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDB } from '#infra/database/drizzle/index.js';
import { getDrizzle } from '#infra/database/drizzle/index.js';
import { bootstrapDimFiles, bootstrapSnapshots } from '#infra/database/drizzle/schema.js';
import { computeContentHash } from '#shared/content-hash.js';
import type { LoggerLike } from '#types/workflows.js';

// ──────────────────────────────────────────────────────────────────
// 本地类型定义
// ──────────────────────────────────────────────────────────────────

/** db 可能包含 getDrizzle/getDb 方法的包装 */
interface DbWrapper {
  getDrizzle?: () => DrizzleDB;
  getDb?: () => unknown;
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

export function normalizeSnapshotPath(
  file: { path?: string; relativePath?: string },
  projectRoot: string
): string {
  const rawPath = typeof file.path === 'string' ? file.path : '';
  if (rawPath) {
    const fromPath = isAbsolute(rawPath) ? relative(projectRoot, rawPath) : rawPath;
    if (fromPath && !fromPath.startsWith('..')) {
      return toPosixPath(fromPath);
    }
  }
  return toPosixPath(file.relativePath || rawPath);
}

export interface ReconciledSnapshotHashes {
  hashes: Record<string, string>;
  remapped: Record<string, string>;
  ambiguous: string[];
}

export function reconcileSnapshotHashes(
  snapshotHashes: Record<string, string>,
  currentPaths: Iterable<string>
): ReconciledSnapshotHashes {
  const current = [...currentPaths].map(toPosixPath);
  const currentSet = new Set(current);
  const hashes: Record<string, string> = {};
  const remapped: Record<string, string> = {};
  const ambiguous: string[] = [];

  for (const [rawPath, hash] of Object.entries(snapshotHashes)) {
    const oldPath = toPosixPath(rawPath);
    if (currentSet.has(oldPath)) {
      hashes[oldPath] = hash;
      continue;
    }

    const suffix = `/${oldPath}`;
    const candidates = current.filter((candidate) => candidate.endsWith(suffix));
    if (candidates.length === 1) {
      hashes[candidates[0]] = hash;
      remapped[oldPath] = candidates[0];
      continue;
    }

    hashes[oldPath] = hash;
    if (candidates.length > 1) {
      ambiguous.push(oldPath);
    }
  }

  return { hashes, remapped, ambiguous };
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isSameSnapshotPath(left: string, right: string): boolean {
  const a = toPosixPath(left);
  const b = toPosixPath(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

// ──────────────────────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────────────────────

/** 快照保留数量 (最多保留 N 个历史快照) */
const MAX_SNAPSHOTS = 5;

/** 全量/增量判断阈值: 文件变更超过此比例 → 全量重跑 */
const FULL_REBUILD_THRESHOLD = 0.5;

// Drizzle row type
type SnapshotRow = typeof bootstrapSnapshots.$inferSelect;

// ──────────────────────────────────────────────────────────────
// FileDiffSnapshotStore 类
// ──────────────────────────────────────────────────────────────

export class FileDiffSnapshotStore {
  #drizzle: DrizzleDB;

  #logger: LoggerLike | null;

  /** @param db DatabaseConnection 或 better-sqlite3 实例 */
  constructor(db: unknown, { logger }: { logger?: LoggerLike | null } = {}) {
    if (!db) {
      throw new Error('FileDiffSnapshotStore requires a database instance');
    }
    const wrappedDrizzle = (db as DbWrapper).getDrizzle;
    this.#drizzle = typeof wrappedDrizzle === 'function' ? wrappedDrizzle.call(db) : getDrizzle();
    this.#logger = logger || null;
  }

  // ─── 快照保存 ─────────────────────────────────────────

  /**
   * 保存一次 workflow 完成后的快照
   *
   * @param params.sessionId Workflow 会话 ID
   * @param params.projectRoot 项目根目录
   * @param params.allFiles 扫描到的文件列表
   * @param params.dimensionStats { dimId: { referencedFiles: string[] } }
   * @param [params.episodicData] EpisodicMemory.toJSON()
   * @param [params.meta] { durationMs, candidateCount, primaryLang }
   * @param [params.isIncremental] 是否 file-diff incremental
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
      const rel = normalizeSnapshotPath(f, projectRoot);
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

    // 事务保存（Drizzle 类型安全）
    this.#drizzle.transaction((tx) => {
      // 主记录
      tx.insert(bootstrapSnapshots)
        .values({
          id,
          sessionId: sessionId || null,
          projectRoot,
          createdAt: now,
          durationMs: meta.durationMs || 0,
          fileCount: allFiles.length,
          dimensionCount: Object.keys(dimensionStats || {}).length,
          candidateCount: meta.candidateCount || 0,
          primaryLang: meta.primaryLang || null,
          fileHashes: JSON.stringify(fileHashes),
          dimensionMeta: JSON.stringify(dimensionMeta),
          episodicData: episodicData ? JSON.stringify(episodicData) : null,
          isIncremental: isIncremental ? 1 : 0,
          parentId: parentId as string | null,
          changedFiles: JSON.stringify(changedFiles),
          affectedDims: JSON.stringify(affectedDims),
          status: 'complete',
        })
        .run();

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
          tx.insert(bootstrapDimFiles)
            .values({
              snapshotId: id,
              dimId,
              filePath: rel,
              role: 'referenced',
            })
            .onConflictDoNothing()
            .run();
        }
      }

      // 容量控制: 保留最新 N 个
      this.#enforceCapacity(projectRoot, tx);
    });

    this.#log(
      `Snapshot saved: ${id} (${allFiles.length} files, ${Object.keys(dimensionStats || {}).length} dims)`
    );
    return id;
  }

  // ─── 快照加载 ─────────────────────────────────────────

  /** 清除项目的所有快照 — 用于手动重新冷启动时强制全量 */
  clearProject(projectRoot: string) {
    try {
      const rows = this.#drizzle
        .select({ id: bootstrapSnapshots.id })
        .from(bootstrapSnapshots)
        .where(eq(bootstrapSnapshots.projectRoot, projectRoot))
        .all();

      for (const row of rows) {
        this.#drizzle.delete(bootstrapSnapshots).where(eq(bootstrapSnapshots.id, row.id)).run();
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
    const row = this.#drizzle
      .select()
      .from(bootstrapSnapshots)
      .where(
        and(
          eq(bootstrapSnapshots.projectRoot, projectRoot),
          eq(bootstrapSnapshots.status, 'complete')
        )
      )
      .orderBy(desc(bootstrapSnapshots.createdAt))
      .limit(1)
      .get();

    if (!row) {
      return null;
    }
    return this.#deserialize(row);
  }

  /** 根据 ID 加载快照 */
  getById(id: string): SnapshotData | null {
    const row = this.#drizzle
      .select()
      .from(bootstrapSnapshots)
      .where(eq(bootstrapSnapshots.id, id))
      .get();

    if (!row) {
      return null;
    }
    return this.#deserialize(row);
  }

  /** 获取项目的所有快照 (按时间降序) */
  list(projectRoot: string, limit = 10): SnapshotData[] {
    return this.#drizzle
      .select()
      .from(bootstrapSnapshots)
      .where(eq(bootstrapSnapshots.projectRoot, projectRoot))
      .orderBy(desc(bootstrapSnapshots.createdAt))
      .limit(limit)
      .all()
      .map((r) => this.#deserialize(r));
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
    // 计算当前文件 hash
    const newHashes: Record<string, string> = {};
    for (const f of currentFiles) {
      const rel = normalizeSnapshotPath(f, projectRoot);
      newHashes[rel] = this.#computeContentHash(f.content || '');
    }

    const reconciled = reconcileSnapshotHashes(snapshot.fileHashes || {}, Object.keys(newHashes));
    const oldHashes = reconciled.hashes;
    const remappedCount = Object.keys(reconciled.remapped).length;
    if (remappedCount > 0) {
      this.#log(`Reconciled ${remappedCount} legacy snapshot paths with current scan paths`);
    }
    if (reconciled.ambiguous.length > 0) {
      this.#log(
        `Skipped ${reconciled.ambiguous.length} ambiguous legacy snapshot path remaps`,
        'warn'
      );
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
    // 变更超过 50% → 全量
    if (diff.changeRatio > FULL_REBUILD_THRESHOLD) {
      return {
        mode: 'full',
        dimensions: allDimIds,
        skippedDimensions: [],
        reason: `变更比例 ${(diff.changeRatio * 100).toFixed(0)}% 超过阈值 (${(FULL_REBUILD_THRESHOLD * 100).toFixed(0)}%)，建议全量冷启动`,
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
        const matchesChangedFile =
          files.has(changedFile) ||
          [...files].some((file) => isSameSnapshotPath(file, changedFile));
        if (matchesChangedFile) {
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
    const rows = this.#drizzle
      .select({
        dimId: bootstrapDimFiles.dimId,
        filePath: bootstrapDimFiles.filePath,
      })
      .from(bootstrapDimFiles)
      .where(eq(bootstrapDimFiles.snapshotId, snapshotId))
      .all();

    const map: Record<string, Set<string>> = {};
    for (const row of rows) {
      if (!map[row.dimId]) {
        map[row.dimId] = new Set();
      }
      map[row.dimId].add(toPosixPath(row.filePath));
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
    return computeContentHash(content);
  }

  #readFileContent(filePath: string): string {
    try {
      return readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  #enforceCapacity(projectRoot: string, db: DrizzleDB = this.#drizzle) {
    try {
      db.delete(bootstrapSnapshots)
        .where(
          sql`${bootstrapSnapshots.projectRoot} = ${projectRoot}
          AND ${bootstrapSnapshots.id} NOT IN (
            SELECT ${bootstrapSnapshots.id} FROM ${bootstrapSnapshots}
            WHERE ${bootstrapSnapshots.projectRoot} = ${projectRoot}
            ORDER BY ${bootstrapSnapshots.createdAt} DESC
            LIMIT ${MAX_SNAPSHOTS}
          )`
        )
        .run();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#log(`Capacity enforcement failed: ${msg}`, 'warn');
    }
  }

  #deserialize(row: SnapshotRow): SnapshotData {
    return {
      id: row.id,
      sessionId: row.sessionId ?? null,
      projectRoot: row.projectRoot,
      createdAt: row.createdAt,
      durationMs: row.durationMs ?? 0,
      fileCount: row.fileCount ?? 0,
      dimensionCount: row.dimensionCount ?? 0,
      candidateCount: row.candidateCount ?? 0,
      primaryLang: row.primaryLang ?? null,
      fileHashes: this.#safeParseJSON(row.fileHashes, {} as Record<string, string>),
      dimensionMeta: this.#safeParseJSON(
        row.dimensionMeta,
        {} as Record<string, DimensionStatMeta>
      ),
      episodicData: this.#safeParseJSON(row.episodicData, null as Record<string, unknown> | null),
      isIncremental: !!row.isIncremental,
      parentId: row.parentId ?? null,
      changedFiles: this.#safeParseJSON(row.changedFiles, [] as string[]),
      affectedDims: this.#safeParseJSON(row.affectedDims, [] as string[]),
      status: row.status ?? 'complete',
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
    this.#logger?.[level]?.(`[FileDiffSnapshotStore] ${msg}`);
  }
}

export default FileDiffSnapshotStore;
