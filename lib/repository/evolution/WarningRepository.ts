/**
 * WarningRepository — recipe_warnings 表 CRUD (Drizzle ORM)
 *
 * 持久化 KnowledgeMetabolism 产出的 RecipeWarning（contradiction / redundancy）。
 * 支持去重（同 target + type + related 组合仅保留最新）、按状态查询、批量解决。
 */

import crypto from 'node:crypto';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import { recipeWarnings } from '../../infrastructure/database/drizzle/schema.js';
import Logger from '../../infrastructure/logging/Logger.js';

/* ────────────────────── Types ────────────────────── */

export type WarningType = 'contradiction' | 'redundancy';
export type WarningStatus = 'open' | 'resolved' | 'dismissed';

export interface WarningRecord {
  id: string;
  type: WarningType;
  targetRecipeId: string;
  relatedRecipeIds: string[];
  confidence: number;
  description: string;
  evidence: string[];
  status: WarningStatus;
  detectedAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
  resolution: string | null;
}

export interface CreateWarningInput {
  type: WarningType;
  targetRecipeId: string;
  relatedRecipeIds: string[];
  confidence: number;
  description: string;
  evidence: string[];
}

export interface WarningFilter {
  type?: WarningType;
  status?: WarningStatus | WarningStatus[];
  targetRecipeId?: string;
}

/* ────────────────────── Class ────────────────────── */

export class WarningRepository {
  readonly #drizzle: DrizzleDB;
  readonly #logger = Logger.getInstance();

  constructor(drizzle: DrizzleDB) {
    this.#drizzle = drizzle;
  }

  /* ═══════════════════ Write ═══════════════════ */

  /**
   * 创建或更新 warning（同 target + type + related 组合去重）。
   * 如果已存在同类型 open warning，更新 confidence/description/evidence/detectedAt。
   */
  upsert(input: CreateWarningInput): WarningRecord {
    // 去重键：type + targetRecipeId + relatedRecipeIds（排序后）
    const relatedKey = [...input.relatedRecipeIds].sort().join(',');
    const existing = this.#drizzle
      .select()
      .from(recipeWarnings)
      .where(
        and(
          eq(recipeWarnings.type, input.type),
          eq(recipeWarnings.targetRecipeId, input.targetRecipeId),
          eq(recipeWarnings.relatedRecipeIds, JSON.stringify([...input.relatedRecipeIds].sort())),
          eq(recipeWarnings.status, 'open')
        )
      )
      .limit(1)
      .get();

    if (existing) {
      // 更新已有 warning
      this.#drizzle
        .update(recipeWarnings)
        .set({
          confidence: input.confidence,
          description: input.description,
          evidence: JSON.stringify(input.evidence),
          detectedAt: Date.now(),
        })
        .where(eq(recipeWarnings.id, existing.id))
        .run();

      return this.#mapRow({
        ...existing,
        ...input,
        relatedRecipeIds: JSON.stringify([...input.relatedRecipeIds].sort()),
        evidence: JSON.stringify(input.evidence),
        detectedAt: Date.now(),
      });
    }

    // 新建 warning
    const id = `rw_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();

    this.#drizzle
      .insert(recipeWarnings)
      .values({
        id,
        type: input.type,
        targetRecipeId: input.targetRecipeId,
        relatedRecipeIds: JSON.stringify([...input.relatedRecipeIds].sort()),
        confidence: input.confidence,
        description: input.description,
        evidence: JSON.stringify(input.evidence),
        status: 'open',
        detectedAt: now,
      })
      .run();

    return {
      id,
      type: input.type,
      targetRecipeId: input.targetRecipeId,
      relatedRecipeIds: [...input.relatedRecipeIds].sort(),
      confidence: input.confidence,
      description: input.description,
      evidence: input.evidence,
      status: 'open',
      detectedAt: now,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    };
  }

  /** 批量 upsert warnings */
  upsertBatch(inputs: CreateWarningInput[]): WarningRecord[] {
    return inputs.map((input) => this.upsert(input));
  }

  /** 解决一个 warning */
  resolve(id: string, resolution: string, resolvedBy = 'system'): boolean {
    const result = this.#drizzle
      .update(recipeWarnings)
      .set({
        status: 'resolved',
        resolvedAt: Date.now(),
        resolvedBy,
        resolution,
      })
      .where(and(eq(recipeWarnings.id, id), eq(recipeWarnings.status, 'open')))
      .run();

    return result.changes > 0;
  }

  /** 忽略一个 warning */
  dismiss(id: string, reason: string, dismissedBy = 'user'): boolean {
    const result = this.#drizzle
      .update(recipeWarnings)
      .set({
        status: 'dismissed',
        resolvedAt: Date.now(),
        resolvedBy: dismissedBy,
        resolution: reason,
      })
      .where(and(eq(recipeWarnings.id, id), eq(recipeWarnings.status, 'open')))
      .run();

    return result.changes > 0;
  }

  /** 按 targetRecipeId 自动解决关联的 open warnings */
  resolveByTarget(targetRecipeId: string, resolution: string, resolvedBy = 'system'): number {
    const result = this.#drizzle
      .update(recipeWarnings)
      .set({
        status: 'resolved',
        resolvedAt: Date.now(),
        resolvedBy,
        resolution,
      })
      .where(
        and(eq(recipeWarnings.targetRecipeId, targetRecipeId), eq(recipeWarnings.status, 'open'))
      )
      .run();

    return result.changes;
  }

  /* ═══════════════════ Read ═══════════════════ */

  findById(id: string): WarningRecord | null {
    const row = this.#drizzle
      .select()
      .from(recipeWarnings)
      .where(eq(recipeWarnings.id, id))
      .limit(1)
      .get();

    return row ? this.#mapRow(row) : null;
  }

  find(filter: WarningFilter = {}, limit = 100): WarningRecord[] {
    const conditions = [];

    if (filter.type) {
      conditions.push(eq(recipeWarnings.type, filter.type));
    }
    if (filter.status) {
      if (Array.isArray(filter.status)) {
        conditions.push(inArray(recipeWarnings.status, filter.status));
      } else {
        conditions.push(eq(recipeWarnings.status, filter.status));
      }
    }
    if (filter.targetRecipeId) {
      conditions.push(eq(recipeWarnings.targetRecipeId, filter.targetRecipeId));
    }

    const query = this.#drizzle
      .select()
      .from(recipeWarnings)
      .orderBy(desc(recipeWarnings.detectedAt))
      .limit(limit);

    const rows = conditions.length > 0 ? query.where(and(...conditions)).all() : query.all();

    return rows.map((r) => this.#mapRow(r));
  }

  /** 统计 open warnings 数量 */
  countOpen(): { total: number; contradictions: number; redundancies: number } {
    const rows = this.#drizzle
      .select({
        type: recipeWarnings.type,
        cnt: count(),
      })
      .from(recipeWarnings)
      .where(eq(recipeWarnings.status, 'open'))
      .groupBy(recipeWarnings.type)
      .all();

    let contradictions = 0;
    let redundancies = 0;
    for (const r of rows) {
      if (r.type === 'contradiction') {
        contradictions = r.cnt;
      }
      if (r.type === 'redundancy') {
        redundancies = r.cnt;
      }
    }

    return { total: contradictions + redundancies, contradictions, redundancies };
  }

  /** 获取指定 Recipe 的 open warnings */
  findByTarget(targetRecipeId: string): WarningRecord[] {
    return this.find({ targetRecipeId, status: 'open' });
  }

  /* ═══════════════════ Internal ═══════════════════ */

  #mapRow(row: typeof recipeWarnings.$inferSelect): WarningRecord {
    return {
      id: row.id,
      type: row.type as WarningType,
      targetRecipeId: row.targetRecipeId,
      relatedRecipeIds: WarningRepository.#parseJson(row.relatedRecipeIds, []),
      confidence: row.confidence,
      description: row.description,
      evidence: WarningRepository.#parseJson(row.evidence, []),
      status: row.status as WarningStatus,
      detectedAt: row.detectedAt,
      resolvedAt: row.resolvedAt ?? null,
      resolvedBy: row.resolvedBy ?? null,
      resolution: row.resolution ?? null,
    };
  }

  static #parseJson<T>(value: string | null | undefined, fallback: T): T {
    if (!value) {
      return fallback;
    }
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
}
