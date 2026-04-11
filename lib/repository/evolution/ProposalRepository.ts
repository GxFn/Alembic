/**
 * ProposalRepository — evolution_proposals 表 CRUD (Drizzle ORM)
 *
 * 操作 evolution_proposals 表，存储进化提案（merge/supersede/enhance/deprecate/
 * reorganize/contradiction/correction）。
 *
 * 设计要求：
 *   - 去重：同 target + 同 type 不允许多个 observing 状态的 Proposal
 *   - Rate Limit：同一 target 不允许同时存在多个相同类型的 observing Proposal
 *   - JSON 字段（evidence/related_recipe_ids）序列化/反序列化
 *
 * Drizzle 迁移策略 (Phase 5a)：
 *   - 全部 raw SQL → Drizzle 类型安全 API
 *   - 构造器接收 DrizzleDB（不再需要 raw Database）
 */

import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, inArray, lte } from 'drizzle-orm';
import type { DrizzleDB } from '../../infrastructure/database/drizzle/index.js';
import { evolutionProposals } from '../../infrastructure/database/drizzle/schema.js';

/* ────────────────────── Types ────────────────────── */

/** Proposal 类型 — 统一标准 */
export type ProposalType =
  | 'merge'
  | 'supersede'
  | 'enhance'
  | 'deprecate'
  | 'reorganize'
  | 'contradiction'
  | 'correction';

/** Proposal 来源 */
export type ProposalSource = 'ide-agent' | 'metabolism' | 'decay-scan';

/** Proposal 状态 */
export type ProposalStatus = 'pending' | 'observing' | 'executed' | 'rejected' | 'expired';

/** evolution_proposals 行对象 */
export interface ProposalRecord {
  id: string;
  type: ProposalType;
  targetRecipeId: string;
  relatedRecipeIds: string[];
  confidence: number;
  source: ProposalSource;
  description: string;
  evidence: Record<string, unknown>[];
  status: ProposalStatus;
  proposedAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
  resolution: string | null;
}

/** 创建 Proposal 输入 */
export interface CreateProposalInput {
  type: ProposalType;
  targetRecipeId: string;
  relatedRecipeIds?: string[];
  confidence: number;
  source: ProposalSource;
  description: string;
  evidence?: Record<string, unknown>[];
  status?: ProposalStatus;
  expiresAt?: number;
}

/** 查询过滤器 */
export interface ProposalFilter {
  status?: ProposalStatus | ProposalStatus[];
  type?: ProposalType;
  targetRecipeId?: string;
  source?: ProposalSource;
  expiredBefore?: number;
}

/* ────────────────────── Constants ────────────────────── */

/** 默认观察窗口：7 天 */
const DEFAULT_OBSERVATION_WINDOW = 7 * 24 * 60 * 60 * 1000;

/** 各 Proposal 类型的默认观察窗口（ms） */
const OBSERVATION_WINDOWS: Record<ProposalType, number> = {
  enhance: 48 * 60 * 60 * 1000, // 48h
  correction: 24 * 60 * 60 * 1000, // 24h
  merge: 72 * 60 * 60 * 1000, // 72h
  supersede: 72 * 60 * 60 * 1000, // 72h
  deprecate: 7 * 24 * 60 * 60 * 1000, // 7d
  contradiction: 7 * 24 * 60 * 60 * 1000, // 7d
  reorganize: 7 * 24 * 60 * 60 * 1000, // 7d
};

/** 自动进入观察状态的置信度阈值 */
const AUTO_OBSERVE_THRESHOLDS: Record<ProposalType, number> = {
  enhance: 0.7,
  correction: 0.7,
  merge: 0.75,
  supersede: 0.8,
  deprecate: 0.0, // decayScore ≤ 40 即可
  contradiction: Infinity, // 需开发者确认
  reorganize: Infinity, // 需开发者确认
};

/* ────────────────────── Drizzle row type ────────────────────── */

type ProposalRow = typeof evolutionProposals.$inferSelect;

/* ────────────────────── Class ────────────────────── */

export class ProposalRepository {
  readonly #drizzle: DrizzleDB;

  constructor(drizzle: DrizzleDB) {
    this.#drizzle = drizzle;
  }

  /* ═══════════════════ Create ═══════════════════ */

  /**
   * 创建 Proposal 并写入 DB。
   *
   * - 自动生成 ID（ep-{timestamp}-{random}）
   * - 自动设定 expiresAt（按 type 默认窗口）
   * - 自动判断 status（低风险 + 高置信度 → observing，否则 pending）
   * - 去重：同 target + 同 type 已有 pending/observing 时拒绝创建
   */
  create(input: CreateProposalInput): ProposalRecord | null {
    const now = Date.now();

    // 去重检查
    if (this.#hasDuplicate(input.targetRecipeId, input.type)) {
      return null;
    }

    const id = ProposalRepository.#generateId(now);
    const expiresAt =
      input.expiresAt ?? now + (OBSERVATION_WINDOWS[input.type] ?? DEFAULT_OBSERVATION_WINDOW);
    const status = input.status ?? this.#resolveInitialStatus(input.type, input.confidence);

    const record: ProposalRecord = {
      id,
      type: input.type,
      targetRecipeId: input.targetRecipeId,
      relatedRecipeIds: input.relatedRecipeIds ?? [],
      confidence: input.confidence,
      source: input.source,
      description: input.description,
      evidence: input.evidence ?? [],
      status,
      proposedAt: now,
      expiresAt,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    };

    this.#drizzle
      .insert(evolutionProposals)
      .values({
        id: record.id,
        type: record.type,
        targetRecipeId: record.targetRecipeId,
        relatedRecipeIds: JSON.stringify(record.relatedRecipeIds),
        confidence: record.confidence,
        source: record.source,
        description: record.description,
        evidence: JSON.stringify(record.evidence),
        status: record.status,
        proposedAt: record.proposedAt,
        expiresAt: record.expiresAt,
      })
      .run();

    return record;
  }

  /* ═══════════════════ Read ═══════════════════ */

  /** 按 ID 查询 */
  findById(id: string): ProposalRecord | null {
    const row = this.#drizzle
      .select()
      .from(evolutionProposals)
      .where(eq(evolutionProposals.id, id))
      .limit(1)
      .get();
    return row ? ProposalRepository.#mapRow(row) : null;
  }

  /** 按条件查询 */
  find(filter: ProposalFilter = {}): ProposalRecord[] {
    const conditions = [];

    if (filter.status) {
      if (Array.isArray(filter.status)) {
        conditions.push(inArray(evolutionProposals.status, filter.status));
      } else {
        conditions.push(eq(evolutionProposals.status, filter.status));
      }
    }

    if (filter.type) {
      conditions.push(eq(evolutionProposals.type, filter.type));
    }

    if (filter.targetRecipeId) {
      conditions.push(eq(evolutionProposals.targetRecipeId, filter.targetRecipeId));
    }

    if (filter.source) {
      conditions.push(eq(evolutionProposals.source, filter.source));
    }

    if (filter.expiredBefore) {
      conditions.push(lte(evolutionProposals.expiresAt, filter.expiredBefore));
    }

    const condition = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = this.#drizzle
      .select()
      .from(evolutionProposals)
      .where(condition)
      .orderBy(desc(evolutionProposals.proposedAt))
      .all();

    return rows.map((r) => ProposalRepository.#mapRow(r));
  }

  /** 查询已到期的 observing 状态 Proposal */
  findExpiredObserving(): ProposalRecord[] {
    return this.find({
      status: 'observing',
      expiredBefore: Date.now(),
    });
  }

  /** 查询所有未完成的 Proposal（pending + observing） */
  findActive(): ProposalRecord[] {
    return this.find({
      status: ['pending', 'observing'],
    });
  }

  /** 按 target Recipe ID 查询活跃 Proposal */
  findByTarget(targetRecipeId: string): ProposalRecord[] {
    return this.find({
      targetRecipeId,
      status: ['pending', 'observing'],
    });
  }

  /* ═══════════════════ Update ═══════════════════ */

  /** 将 Proposal 状态转为 observing */
  startObserving(id: string): boolean {
    const now = Date.now();
    const proposal = this.findById(id);
    if (!proposal || proposal.status !== 'pending') {
      return false;
    }

    const expiresAt = now + (OBSERVATION_WINDOWS[proposal.type] ?? DEFAULT_OBSERVATION_WINDOW);
    const result = this.#drizzle
      .update(evolutionProposals)
      .set({ status: 'observing', expiresAt })
      .where(and(eq(evolutionProposals.id, id), eq(evolutionProposals.status, 'pending')))
      .run();
    return result.changes > 0;
  }

  /** 标记 Proposal 为已执行 */
  markExecuted(id: string, resolution: string, resolvedBy = 'auto'): boolean {
    const result = this.#drizzle
      .update(evolutionProposals)
      .set({
        status: 'executed',
        resolvedAt: Date.now(),
        resolvedBy,
        resolution,
      })
      .where(and(eq(evolutionProposals.id, id), eq(evolutionProposals.status, 'observing')))
      .run();
    return result.changes > 0;
  }

  /** 标记 Proposal 为已拒绝 */
  markRejected(id: string, resolution: string, resolvedBy = 'auto'): boolean {
    const result = this.#drizzle
      .update(evolutionProposals)
      .set({
        status: 'rejected',
        resolvedAt: Date.now(),
        resolvedBy,
        resolution,
      })
      .where(
        and(
          eq(evolutionProposals.id, id),
          inArray(evolutionProposals.status, ['pending', 'observing'])
        )
      )
      .run();
    return result.changes > 0;
  }

  /** 标记 Proposal 为过期 */
  markExpired(id: string): boolean {
    const result = this.#drizzle
      .update(evolutionProposals)
      .set({
        status: 'expired',
        resolvedAt: Date.now(),
      })
      .where(
        and(
          eq(evolutionProposals.id, id),
          inArray(evolutionProposals.status, ['pending', 'observing'])
        )
      )
      .run();
    return result.changes > 0;
  }

  /** 更新 evidence（用于追加观察期指标快照） */
  updateEvidence(id: string, evidence: Record<string, unknown>[]): boolean {
    const result = this.#drizzle
      .update(evolutionProposals)
      .set({ evidence: JSON.stringify(evidence) })
      .where(eq(evolutionProposals.id, id))
      .run();
    return result.changes > 0;
  }

  /* ═══════════════════ Delete ═══════════════════ */

  /** 按 target Recipe ID 删除所有 Proposal（用于知识删除时清理关联提案） */
  deleteByTargetRecipeId(targetRecipeId: string): number {
    const result = this.#drizzle
      .delete(evolutionProposals)
      .where(eq(evolutionProposals.targetRecipeId, targetRecipeId))
      .run();
    return result.changes;
  }

  /* ═══════════════════ Stats ═══════════════════ */

  /** 统计各状态的 Proposal 数量 */
  stats(): Record<ProposalStatus, number> {
    const rows = this.#drizzle
      .select({
        status: evolutionProposals.status,
        count: count(),
      })
      .from(evolutionProposals)
      .groupBy(evolutionProposals.status)
      .all();

    const result: Record<string, number> = {
      pending: 0,
      observing: 0,
      executed: 0,
      rejected: 0,
      expired: 0,
    };
    for (const row of rows) {
      result[row.status] = row.count;
    }
    return result as Record<ProposalStatus, number>;
  }

  /* ═══════════════════ Private ═══════════════════ */

  /** 去重检查：同 target + 同 type 是否已有 pending/observing Proposal */
  #hasDuplicate(targetRecipeId: string, type: ProposalType): boolean {
    const row = this.#drizzle
      .select({ id: evolutionProposals.id })
      .from(evolutionProposals)
      .where(
        and(
          eq(evolutionProposals.targetRecipeId, targetRecipeId),
          eq(evolutionProposals.type, type),
          inArray(evolutionProposals.status, ['pending', 'observing'])
        )
      )
      .limit(1)
      .get();
    return row !== undefined;
  }

  /** 根据 type + confidence 判断初始状态 */
  #resolveInitialStatus(type: ProposalType, confidence: number): ProposalStatus {
    const threshold = AUTO_OBSERVE_THRESHOLDS[type];
    return confidence >= threshold ? 'observing' : 'pending';
  }

  /** 生成 Proposal ID */
  static #generateId(timestamp: number): string {
    const rand = randomBytes(4).toString('hex');
    return `ep-${timestamp}-${rand}`;
  }

  /** Drizzle Row → ProposalRecord */
  static #mapRow(row: ProposalRow): ProposalRecord {
    return {
      id: row.id,
      type: row.type as ProposalType,
      targetRecipeId: row.targetRecipeId,
      relatedRecipeIds: safeJsonParse(row.relatedRecipeIds, []),
      confidence: row.confidence,
      source: row.source as ProposalSource,
      description: row.description ?? '',
      evidence: safeJsonParse(row.evidence, []),
      status: row.status as ProposalStatus,
      proposedAt: row.proposedAt,
      expiresAt: row.expiresAt,
      resolvedAt: row.resolvedAt ?? null,
      resolvedBy: row.resolvedBy ?? null,
      resolution: row.resolution ?? null,
    };
  }
}

/* ────────────────────── Util ────────────────────── */

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) {
    return fallback;
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
