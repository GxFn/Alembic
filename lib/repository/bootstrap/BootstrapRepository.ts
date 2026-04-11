/**
 * BootstrapRepository — Bootstrap 快照的仓储实现
 *
 * 从 BootstrapSnapshot 提取的数据操作，
 * 使用 Drizzle 类型安全 API 操作 bootstrap_snapshots + bootstrap_dim_files 表。
 */

import { and, count, desc, eq, sql } from 'drizzle-orm';
import {
  bootstrapDimFiles,
  bootstrapSnapshots,
} from '../../infrastructure/database/drizzle/schema.js';
import { RepositoryBase } from '../base/RepositoryBase.js';

/* ═══ 类型定义 ═══ */

export interface BootstrapSnapshotEntity {
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

export interface DimensionStatMeta {
  candidateCount: number;
  analysisChars: number;
  referencedFiles: number;
  durationMs: number;
}

export interface BootstrapSnapshotInsert {
  id: string;
  sessionId?: string | null;
  projectRoot: string;
  createdAt: string;
  durationMs?: number;
  fileCount?: number;
  dimensionCount?: number;
  candidateCount?: number;
  primaryLang?: string | null;
  fileHashes: Record<string, string>;
  dimensionMeta: Record<string, DimensionStatMeta>;
  episodicData?: unknown | null;
  isIncremental?: boolean;
  parentId?: string | null;
  changedFiles?: string[];
  affectedDims?: string[];
  status?: string;
}

export interface DimFileInsert {
  snapshotId: string;
  dimId: string;
  filePath: string;
  role?: string;
}

export interface DimFileEntry {
  dimId: string;
  filePath: string;
}

/* ═══ Repository 实现 ═══ */

export class BootstrapRepositoryImpl extends RepositoryBase<
  typeof bootstrapSnapshots,
  BootstrapSnapshotEntity
> {
  /** 默认快照保留数量 */
  static readonly MAX_SNAPSHOTS = 5;

  constructor(
    drizzle: ConstructorParameters<
      typeof RepositoryBase<typeof bootstrapSnapshots, BootstrapSnapshotEntity>
    >[0]
  ) {
    super(drizzle, bootstrapSnapshots);
  }

  /* ─── CRUD ─── */

  async findById(id: string): Promise<BootstrapSnapshotEntity | null> {
    const rows = this.drizzle.select().from(this.table).where(eq(this.table.id, id)).limit(1).all();
    return rows.length > 0 ? this.#mapRow(rows[0]) : null;
  }

  async create(data: BootstrapSnapshotInsert): Promise<BootstrapSnapshotEntity> {
    this.drizzle
      .insert(this.table)
      .values({
        id: data.id,
        sessionId: data.sessionId ?? null,
        projectRoot: data.projectRoot,
        createdAt: data.createdAt,
        durationMs: data.durationMs ?? 0,
        fileCount: data.fileCount ?? 0,
        dimensionCount: data.dimensionCount ?? 0,
        candidateCount: data.candidateCount ?? 0,
        primaryLang: data.primaryLang ?? null,
        fileHashes: JSON.stringify(data.fileHashes),
        dimensionMeta: JSON.stringify(data.dimensionMeta),
        episodicData: data.episodicData ? JSON.stringify(data.episodicData) : null,
        isIncremental: data.isIncremental ? 1 : 0,
        parentId: data.parentId ?? null,
        changedFiles: JSON.stringify(data.changedFiles ?? []),
        affectedDims: JSON.stringify(data.affectedDims ?? []),
        status: data.status ?? 'complete',
      })
      .run();

    return (await this.findById(data.id))!;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.drizzle.delete(this.table).where(eq(this.table.id, id)).run();
    return result.changes > 0;
  }

  /* ─── 快照查询 ─── */

  /** 获取项目最新完成的快照 */
  async getLatest(projectRoot: string): Promise<BootstrapSnapshotEntity | null> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(and(eq(this.table.projectRoot, projectRoot), eq(this.table.status, 'complete')))
      .orderBy(desc(this.table.createdAt))
      .limit(1)
      .all();
    return rows.length > 0 ? this.#mapRow(rows[0]) : null;
  }

  /** 获取项目的快照列表 (按时间降序) */
  async listByProject(projectRoot: string, limit = 10): Promise<BootstrapSnapshotEntity[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(eq(this.table.projectRoot, projectRoot))
      .orderBy(desc(this.table.createdAt))
      .limit(limit)
      .all();
    return rows.map((r) => this.#mapRow(r));
  }

  /* ─── 维度-文件关联 ─── */

  /** 批量插入维度-文件关联 (INSERT OR IGNORE) */
  async saveDimFiles(entries: DimFileInsert[]): Promise<number> {
    if (entries.length === 0) {
      return 0;
    }

    let inserted = 0;
    this.transaction((tx) => {
      for (const entry of entries) {
        tx.insert(bootstrapDimFiles)
          .values({
            snapshotId: entry.snapshotId,
            dimId: entry.dimId,
            filePath: entry.filePath,
            role: entry.role ?? 'referenced',
          })
          .onConflictDoNothing()
          .run();
        inserted++;
      }
    });

    return inserted;
  }

  /** 获取快照的维度-文件关联 */
  async getDimFiles(snapshotId: string): Promise<DimFileEntry[]> {
    const rows = this.drizzle
      .select({
        dimId: bootstrapDimFiles.dimId,
        filePath: bootstrapDimFiles.filePath,
      })
      .from(bootstrapDimFiles)
      .where(eq(bootstrapDimFiles.snapshotId, snapshotId))
      .all();
    return rows;
  }

  /** 获取快照中每个维度引用的文件集合 */
  async getDimFileMap(snapshotId: string): Promise<Record<string, Set<string>>> {
    const entries = await this.getDimFiles(snapshotId);
    const map: Record<string, Set<string>> = {};
    for (const row of entries) {
      if (!map[row.dimId]) {
        map[row.dimId] = new Set();
      }
      map[row.dimId].add(row.filePath);
    }
    return map;
  }

  /* ─── 容量控制 ─── */

  /** 保留项目最新 N 个快照，删除旧的 */
  async enforceCapacity(
    projectRoot: string,
    maxSnapshots = BootstrapRepositoryImpl.MAX_SNAPSHOTS
  ): Promise<number> {
    const result = this.drizzle
      .delete(this.table)
      .where(
        and(
          eq(this.table.projectRoot, projectRoot),
          sql`${this.table.id} NOT IN (
            SELECT ${this.table.id} FROM ${this.table}
            WHERE ${this.table.projectRoot} = ${projectRoot}
            ORDER BY ${this.table.createdAt} DESC
            LIMIT ${maxSnapshots}
          )`
        )
      )
      .run();
    return result.changes;
  }

  /** 清除项目的所有快照 */
  async clearProject(projectRoot: string): Promise<number> {
    const snapshots = await this.listByProject(projectRoot, 9999);
    let deleted = 0;
    for (const snap of snapshots) {
      if (await this.delete(snap.id)) {
        deleted++;
      }
    }
    return deleted;
  }

  /* ─── 事务保存 ─── */

  /**
   * 事务保存快照 + 维度-文件关联 + 容量控制
   * 替代 BootstrapSnapshot.save() 中的事务逻辑
   */
  async saveWithDimFiles(
    snapshot: BootstrapSnapshotInsert,
    dimFiles: DimFileInsert[]
  ): Promise<BootstrapSnapshotEntity> {
    this.transaction((tx) => {
      // 主记录
      tx.insert(this.table)
        .values({
          id: snapshot.id,
          sessionId: snapshot.sessionId ?? null,
          projectRoot: snapshot.projectRoot,
          createdAt: snapshot.createdAt,
          durationMs: snapshot.durationMs ?? 0,
          fileCount: snapshot.fileCount ?? 0,
          dimensionCount: snapshot.dimensionCount ?? 0,
          candidateCount: snapshot.candidateCount ?? 0,
          primaryLang: snapshot.primaryLang ?? null,
          fileHashes: JSON.stringify(snapshot.fileHashes),
          dimensionMeta: JSON.stringify(snapshot.dimensionMeta),
          episodicData: snapshot.episodicData ? JSON.stringify(snapshot.episodicData) : null,
          isIncremental: snapshot.isIncremental ? 1 : 0,
          parentId: snapshot.parentId ?? null,
          changedFiles: JSON.stringify(snapshot.changedFiles ?? []),
          affectedDims: JSON.stringify(snapshot.affectedDims ?? []),
          status: snapshot.status ?? 'complete',
        })
        .run();

      // 维度-文件关联
      for (const df of dimFiles) {
        tx.insert(bootstrapDimFiles)
          .values({
            snapshotId: df.snapshotId,
            dimId: df.dimId,
            filePath: df.filePath,
            role: df.role ?? 'referenced',
          })
          .onConflictDoNothing()
          .run();
      }

      // 容量控制
      tx.delete(this.table)
        .where(
          and(
            eq(this.table.projectRoot, snapshot.projectRoot),
            sql`${this.table.id} NOT IN (
              SELECT ${this.table.id} FROM ${this.table}
              WHERE ${this.table.projectRoot} = ${snapshot.projectRoot}
              ORDER BY ${this.table.createdAt} DESC
              LIMIT ${BootstrapRepositoryImpl.MAX_SNAPSHOTS}
            )`
          )
        )
        .run();
    });

    return (await this.findById(snapshot.id))!;
  }

  /** 获取项目最新的主语言 (Panorama 域用于维度/角色检测) */
  async getLatestPrimaryLang(projectRoot: string): Promise<string | null> {
    const rows = this.drizzle
      .select({ primaryLang: this.table.primaryLang })
      .from(this.table)
      .where(eq(this.table.projectRoot, projectRoot))
      .orderBy(desc(this.table.createdAt))
      .limit(1)
      .all();
    return rows.length > 0 ? (rows[0].primaryLang ?? null) : null;
  }

  /** 获取快照总数 */
  async getSnapshotCount(projectRoot?: string): Promise<number> {
    const condition = projectRoot ? eq(this.table.projectRoot, projectRoot) : undefined;
    const [row] = this.drizzle.select({ cnt: count() }).from(this.table).where(condition).all();
    return row?.cnt ?? 0;
  }

  /* ─── 内部辅助 ─── */

  #mapRow(row: typeof bootstrapSnapshots.$inferSelect): BootstrapSnapshotEntity {
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
      fileHashes: safeParseJSON(row.fileHashes, {} as Record<string, string>),
      dimensionMeta: safeParseJSON(row.dimensionMeta, {} as Record<string, DimensionStatMeta>),
      episodicData: safeParseJSON(row.episodicData, null as Record<string, unknown> | null),
      isIncremental: !!row.isIncremental,
      parentId: row.parentId ?? null,
      changedFiles: safeParseJSON(row.changedFiles, [] as string[]),
      affectedDims: safeParseJSON(row.affectedDims, [] as string[]),
      status: row.status ?? 'complete',
    };
  }
}

function safeParseJSON<T>(str: string | null | undefined, fallback: T): T {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch {
    return fallback;
  }
}
