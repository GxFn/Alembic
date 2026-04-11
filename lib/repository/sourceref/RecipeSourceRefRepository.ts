/**
 * RecipeSourceRefRepository — recipe_source_refs 表 CRUD (Drizzle ORM)
 *
 * Recipe 来源引用桥接表：建立 Recipe ↔ 源码文件的映射关系。
 * 表使用复合主键 (recipe_id, source_path)，没有独立 id 列。
 *
 * 主要消费者：SourceRefReconciler
 */

import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import { recipeSourceRefs } from '../../infrastructure/database/drizzle/schema.js';

/* ═══ 类型定义 ═══ */

export interface RecipeSourceRefEntity {
  recipeId: string;
  sourcePath: string;
  status: string;
  newPath: string | null;
  verifiedAt: number;
}

export interface RecipeSourceRefInsert {
  recipeId: string;
  sourcePath: string;
  status?: string;
  newPath?: string | null;
  verifiedAt: number;
}

/* ═══ Repository 实现 ═══ */

export class RecipeSourceRefRepositoryImpl {
  readonly #drizzle: DrizzleDB;

  constructor(drizzle: DrizzleDB) {
    this.#drizzle = drizzle;
  }

  /* ─── 查询 ─── */

  /** 按 Recipe ID 查询所有关联的源引用 */
  findByRecipeId(recipeId: string): RecipeSourceRefEntity[] {
    return this.#drizzle
      .select()
      .from(recipeSourceRefs)
      .where(eq(recipeSourceRefs.recipeId, recipeId))
      .all() as RecipeSourceRefEntity[];
  }

  /** 按源文件路径查询所有关联的引用 */
  findBySourcePath(sourcePath: string): RecipeSourceRefEntity[] {
    return this.#drizzle
      .select()
      .from(recipeSourceRefs)
      .where(eq(recipeSourceRefs.sourcePath, sourcePath))
      .all() as RecipeSourceRefEntity[];
  }

  /** 按状态查询 */
  findByStatus(status: string): RecipeSourceRefEntity[] {
    return this.#drizzle
      .select()
      .from(recipeSourceRefs)
      .where(eq(recipeSourceRefs.status, status))
      .all() as RecipeSourceRefEntity[];
  }

  /** 查找指定复合键 */
  findOne(recipeId: string, sourcePath: string): RecipeSourceRefEntity | null {
    const row = this.#drizzle
      .select()
      .from(recipeSourceRefs)
      .where(
        and(eq(recipeSourceRefs.recipeId, recipeId), eq(recipeSourceRefs.sourcePath, sourcePath))
      )
      .limit(1)
      .get();
    return (row as RecipeSourceRefEntity) ?? null;
  }

  /** 查询所有 stale 引用 */
  findStale(): RecipeSourceRefEntity[] {
    return this.findByStatus('stale');
  }

  /** 统计条数 */
  count(): number {
    const row = this.#drizzle.select({ cnt: sql<number>`count(*)` }).from(recipeSourceRefs).get();
    return row?.cnt ?? 0;
  }

  /* ─── 写入 ─── */

  /** UPSERT — 插入或更新（按复合主键） */
  upsert(data: RecipeSourceRefInsert): void {
    this.#drizzle
      .insert(recipeSourceRefs)
      .values({
        recipeId: data.recipeId,
        sourcePath: data.sourcePath,
        status: data.status ?? 'active',
        newPath: data.newPath ?? null,
        verifiedAt: data.verifiedAt,
      })
      .onConflictDoUpdate({
        target: [recipeSourceRefs.recipeId, recipeSourceRefs.sourcePath],
        set: {
          status: data.status ?? 'active',
          newPath: data.newPath ?? null,
          verifiedAt: data.verifiedAt,
        },
      })
      .run();
  }

  /** 更新状态 */
  updateStatus(recipeId: string, sourcePath: string, status: string, newPath?: string): boolean {
    const set: Record<string, unknown> = { status };
    if (newPath !== undefined) {
      set.newPath = newPath;
    }
    const result = this.#drizzle
      .update(recipeSourceRefs)
      .set(set)
      .where(
        and(eq(recipeSourceRefs.recipeId, recipeId), eq(recipeSourceRefs.sourcePath, sourcePath))
      )
      .run();
    return result.changes > 0;
  }

  /* ─── 删除 ─── */

  /** 按 Recipe ID 删除所有关联引用 */
  deleteByRecipeId(recipeId: string): number {
    const result = this.#drizzle
      .delete(recipeSourceRefs)
      .where(eq(recipeSourceRefs.recipeId, recipeId))
      .run();
    return result.changes;
  }

  /** 删除指定复合键 */
  deleteOne(recipeId: string, sourcePath: string): boolean {
    const result = this.#drizzle
      .delete(recipeSourceRefs)
      .where(
        and(eq(recipeSourceRefs.recipeId, recipeId), eq(recipeSourceRefs.sourcePath, sourcePath))
      )
      .run();
    return result.changes > 0;
  }

  /** 检查表是否可访问（SourceRefReconciler 使用） */
  isAccessible(): boolean {
    try {
      this.#drizzle
        .select({ recipeId: recipeSourceRefs.recipeId })
        .from(recipeSourceRefs)
        .limit(1)
        .get();
      return true;
    } catch {
      return false;
    }
  }

  /** Stale counts grouped by recipe (for SourceRefReconciler signal emission) */
  getStaleCountsByRecipe(): Array<{ recipeId: string; staleCount: number; totalCount: number }> {
    const rows = this.#drizzle
      .select({
        recipeId: recipeSourceRefs.recipeId,
        staleCount: sql<number>`count(*)`,
        totalCount: sql<number>`(SELECT count(*) FROM recipe_source_refs r2 WHERE r2.recipe_id = ${recipeSourceRefs.recipeId})`,
      })
      .from(recipeSourceRefs)
      .where(eq(recipeSourceRefs.status, 'stale'))
      .groupBy(recipeSourceRefs.recipeId)
      .all();
    return rows.map((r) => ({
      recipeId: r.recipeId,
      staleCount: Number(r.staleCount),
      totalCount: Number(r.totalCount),
    }));
  }

  /** Find all entries with status='renamed' and non-null new_path */
  findRenamed(): RecipeSourceRefEntity[] {
    return this.#drizzle
      .select()
      .from(recipeSourceRefs)
      .where(and(eq(recipeSourceRefs.status, 'renamed'), isNotNull(recipeSourceRefs.newPath)))
      .all() as RecipeSourceRefEntity[];
  }

  /** Replace source path (updates composite key column) — used by SourceRefReconciler.applyRepairs */
  replaceSourcePath(
    recipeId: string,
    oldSourcePath: string,
    newSourcePath: string,
    verifiedAt: number
  ): void {
    this.#drizzle
      .update(recipeSourceRefs)
      .set({
        sourcePath: newSourcePath,
        status: 'active',
        newPath: null,
        verifiedAt,
      })
      .where(
        and(eq(recipeSourceRefs.recipeId, recipeId), eq(recipeSourceRefs.sourcePath, oldSourcePath))
      )
      .run();
  }

  /** 查询多个 Recipe 的非 stale 来源引用（SearchEngine _supplementDetails 用） */
  findActiveByRecipeIds(ids: string[]) {
    if (ids.length === 0) {
      return [];
    }
    return this.#drizzle
      .select({
        recipeId: recipeSourceRefs.recipeId,
        sourcePath: recipeSourceRefs.sourcePath,
        status: recipeSourceRefs.status,
        newPath: recipeSourceRefs.newPath,
      })
      .from(recipeSourceRefs)
      .where(and(inArray(recipeSourceRefs.recipeId, ids), ne(recipeSourceRefs.status, 'stale')))
      .all();
  }
}
