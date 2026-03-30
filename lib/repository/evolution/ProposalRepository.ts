/**
 * ProposalRepository — evolution_proposals 表 CRUD
 *
 * 操作 evolution_proposals 表，存储进化提案（merge/supersede/enhance/deprecate/
 * reorganize/contradiction/correction）。
 *
 * 设计要求：
 *   - 去重：同 target + 同 type 不允许多个 observing 状态的 Proposal
 *   - Rate Limit：同一 target 不允许同时存在多个相同类型的 observing Proposal
 *   - JSON 字段（evidence/related_recipe_ids）序列化/反序列化
 */

import { randomBytes } from 'node:crypto';

/* ────────────────────── Types ────────────────────── */

interface DatabaseLike {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number };
  };
}

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

/* ────────────────────── Class ────────────────────── */

export class ProposalRepository {
  readonly #db: DatabaseLike;

  constructor(db: DatabaseLike) {
    this.#db = db;
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

    this.#db
      .prepare(
        `INSERT INTO evolution_proposals
         (id, type, target_recipe_id, related_recipe_ids, confidence, source, description, evidence, status, proposed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.type,
        record.targetRecipeId,
        JSON.stringify(record.relatedRecipeIds),
        record.confidence,
        record.source,
        record.description,
        JSON.stringify(record.evidence),
        record.status,
        record.proposedAt,
        record.expiresAt
      );

    return record;
  }

  /* ═══════════════════ Read ═══════════════════ */

  /** 按 ID 查询 */
  findById(id: string): ProposalRecord | null {
    const row = this.#db.prepare(`SELECT * FROM evolution_proposals WHERE id = ?`).get(id);
    return row ? ProposalRepository.#mapRow(row) : null;
  }

  /** 按条件查询 */
  find(filter: ProposalFilter = {}): ProposalRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.status) {
      if (Array.isArray(filter.status)) {
        const placeholders = filter.status.map(() => '?').join(', ');
        conditions.push(`status IN (${placeholders})`);
        params.push(...filter.status);
      } else {
        conditions.push('status = ?');
        params.push(filter.status);
      }
    }

    if (filter.type) {
      conditions.push('type = ?');
      params.push(filter.type);
    }

    if (filter.targetRecipeId) {
      conditions.push('target_recipe_id = ?');
      params.push(filter.targetRecipeId);
    }

    if (filter.source) {
      conditions.push('source = ?');
      params.push(filter.source);
    }

    if (filter.expiredBefore) {
      conditions.push('expires_at <= ?');
      params.push(filter.expiredBefore);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM evolution_proposals ${where} ORDER BY proposed_at DESC`)
      .all(...params);

    return rows.map(ProposalRepository.#mapRow);
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
    const result = this.#db
      .prepare(
        `UPDATE evolution_proposals SET status = 'observing', expires_at = ? WHERE id = ? AND status = 'pending'`
      )
      .run(expiresAt, id);
    return result.changes > 0;
  }

  /** 标记 Proposal 为已执行 */
  markExecuted(id: string, resolution: string, resolvedBy = 'auto'): boolean {
    const result = this.#db
      .prepare(
        `UPDATE evolution_proposals SET status = 'executed', resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ? AND status = 'observing'`
      )
      .run(Date.now(), resolvedBy, resolution, id);
    return result.changes > 0;
  }

  /** 标记 Proposal 为已拒绝 */
  markRejected(id: string, resolution: string, resolvedBy = 'auto'): boolean {
    const result = this.#db
      .prepare(
        `UPDATE evolution_proposals SET status = 'rejected', resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ? AND status IN ('pending', 'observing')`
      )
      .run(Date.now(), resolvedBy, resolution, id);
    return result.changes > 0;
  }

  /** 标记 Proposal 为过期 */
  markExpired(id: string): boolean {
    const result = this.#db
      .prepare(
        `UPDATE evolution_proposals SET status = 'expired', resolved_at = ? WHERE id = ? AND status IN ('pending', 'observing')`
      )
      .run(Date.now(), id);
    return result.changes > 0;
  }

  /** 更新 evidence（用于追加观察期指标快照） */
  updateEvidence(id: string, evidence: Record<string, unknown>[]): boolean {
    const result = this.#db
      .prepare(`UPDATE evolution_proposals SET evidence = ? WHERE id = ?`)
      .run(JSON.stringify(evidence), id);
    return result.changes > 0;
  }

  /* ═══════════════════ Stats ═══════════════════ */

  /** 统计各状态的 Proposal 数量 */
  stats(): Record<ProposalStatus, number> {
    const rows = this.#db
      .prepare(`SELECT status, COUNT(*) as count FROM evolution_proposals GROUP BY status`)
      .all() as { status: string; count: number }[];

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
    const row = this.#db
      .prepare(
        `SELECT 1 FROM evolution_proposals WHERE target_recipe_id = ? AND type = ? AND status IN ('pending', 'observing') LIMIT 1`
      )
      .get(targetRecipeId, type);
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

  /** DB 行 → ProposalRecord */
  static #mapRow(row: Record<string, unknown>): ProposalRecord {
    return {
      id: row.id as string,
      type: row.type as ProposalType,
      targetRecipeId: row.target_recipe_id as string,
      relatedRecipeIds: safeJsonParse(row.related_recipe_ids as string, []),
      confidence: row.confidence as number,
      source: row.source as ProposalSource,
      description: row.description as string,
      evidence: safeJsonParse(row.evidence as string, []),
      status: row.status as ProposalStatus,
      proposedAt: row.proposed_at as number,
      expiresAt: row.expires_at as number,
      resolvedAt: (row.resolved_at as number) ?? null,
      resolvedBy: (row.resolved_by as string) ?? null,
      resolution: (row.resolution as string) ?? null,
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
