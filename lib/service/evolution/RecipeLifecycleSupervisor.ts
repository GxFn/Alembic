/**
 * RecipeLifecycleSupervisor — 统一状态转移管理层
 *
 * 核心职责：
 *   1. Guard 前置检查 — 验证转移是否合法（VALID_TRANSITIONS + 扩展条件）
 *   2. Entry/Exit Actions — 进入/离开状态的固定副作用
 *   3. Event 记录 — 每次转移记录为不可变 TransitionEvent
 *   4. 超时监控 — 中间态超时自动处理
 *   5. 健康摘要 — 全局状态分布与卡死检测
 *
 * 所有状态变更建议通过 Supervisor，目前作为可选增强层存在。
 * 不改变现有 ProposalExecutor/StagingManager 的内部逻辑，
 * 而是在它们之上提供审计、超时检查和健康监控。
 *
 * 触发时机：UiStartupTasks Stage 6（新增）
 *
 * @module service/evolution/RecipeLifecycleSupervisor
 */

import { randomUUID } from 'node:crypto';
import { isValidTransition } from '../../domain/knowledge/Lifecycle.js';
import Logger from '../../infrastructure/logging/Logger.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type {
  LifecycleHealthSummary,
  TimeoutCheckResult,
  TransitionEvent,
  TransitionRequest,
  TransitionResult,
} from '../../types/evolution.js';

/* ────────────────────── Types ────────────────────── */

interface DatabaseLike {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number };
  };
}

/* ────────────────────── Constants ────────────────────── */

/** 中间态超时配置（毫秒） */
const TIMEOUT_MS = {
  evolving: 7 * 24 * 60 * 60 * 1000, // 7 天
  decaying: 30 * 24 * 60 * 60 * 1000, // 30 天
  staging: 7 * 24 * 60 * 60 * 1000, // 7 天（安全兜底，正常由 StagingManager 处理）
  pending: 30 * 24 * 60 * 60 * 1000, // 30 天
} as const;

/** 超时后的目标状态 */
const TIMEOUT_TARGET = {
  evolving: 'active', // 回退到 active（内容不变）
  decaying: 'deprecated', // 长期衰退 → 废弃
  pending: 'deprecated', // 30 天未审核 → 废弃
} as const;

/** 卡死告警阈值（毫秒） */
const STUCK_THRESHOLD_MS = {
  evolving: 3 * 24 * 60 * 60 * 1000, // > 3天
  decaying: 15 * 24 * 60 * 60 * 1000, // > 15天
  staging: 3 * 24 * 60 * 60 * 1000, // > 3天
  pending: 7 * 24 * 60 * 60 * 1000, // > 7天
} as const;

/* ────────────────────── Entry/Exit Action Types ────────────────────── */

/** 进入状态时写入 stats 的元数据键 */
const ENTRY_META_KEYS: Record<string, string> = {
  staging: 'stagingEnteredAt',
  evolving: 'evolvingStartedAt',
  decaying: 'decayStartedAt',
  active: 'activeSince',
};

/* ────────────────────── Class ────────────────────── */

export class RecipeLifecycleSupervisor {
  readonly #db: DatabaseLike;
  readonly #signalBus: SignalBus | null;
  readonly #logger = Logger.getInstance();

  constructor(db: DatabaseLike, options: { signalBus?: SignalBus } = {}) {
    this.#db = db;
    this.#signalBus = options.signalBus ?? null;
  }

  /* ═══════════════════ Core Transition ═══════════════════ */

  /**
   * 执行状态转移 — 统一入口
   *
   * 1. 获取当前状态
   * 2. Guard 检查（合法转移 + 扩展条件）
   * 3. Exit Action（离开旧状态）
   * 4. 更新 lifecycle
   * 5. Entry Action（进入新状态）
   * 6. 记录 TransitionEvent
   * 7. 发射信号
   */
  transition(request: TransitionRequest): TransitionResult {
    const { recipeId, targetState, trigger, evidence, proposalId, operatorId } = request;
    const opId = operatorId ?? 'system';

    // 1. 获取当前状态
    const current = this.#getRecipeState(recipeId);
    if (!current) {
      return {
        success: false,
        fromState: 'unknown',
        toState: targetState,
        error: 'Recipe not found',
      };
    }

    const fromState = current.lifecycle;

    // 2. Guard 检查
    if (!isValidTransition(fromState, targetState)) {
      this.#logger.warn(
        `[Supervisor] Invalid transition: ${recipeId} ${fromState} → ${targetState} (trigger: ${trigger})`
      );
      return {
        success: false,
        fromState,
        toState: targetState,
        error: `Invalid transition: ${fromState} → ${targetState}`,
      };
    }

    // 3. Exit Action
    this.#executeExitAction(recipeId, fromState);

    // 4. 更新 lifecycle
    const now = Date.now();
    this.#db
      .prepare(`UPDATE knowledge_entries SET lifecycle = ?, updatedAt = ? WHERE id = ?`)
      .run(targetState, now, recipeId);

    // 5. Entry Action
    this.#executeEntryAction(recipeId, targetState, now, proposalId);

    // 6. 记录 TransitionEvent
    const event = this.#recordEvent({
      recipeId,
      fromState,
      toState: targetState,
      trigger,
      evidence: evidence ?? null,
      proposalId: proposalId ?? null,
      operatorId: opId,
      createdAt: now,
    });

    // 7. 发射信号
    this.#emitSignal(recipeId, fromState, targetState, trigger);

    this.#logger.info(
      `[Supervisor] ${recipeId}: ${fromState} → ${targetState} (trigger: ${trigger})`
    );

    return { success: true, fromState, toState: targetState, event };
  }

  /* ═══════════════════ Timeout Check ═══════════════════ */

  /**
   * 检查中间态超时 + 自动处理
   *
   * 处理范围:
   *   - evolving > 7d → active（回退）
   *   - decaying > 30d → deprecated
   */
  checkTimeouts(): TimeoutCheckResult {
    const result: TimeoutCheckResult = { timedOut: [], checked: 0 };
    const now = Date.now();

    for (const [state, timeoutMs] of Object.entries(TIMEOUT_MS)) {
      if (!(state in TIMEOUT_TARGET)) {
        continue;
      }

      const targetState = TIMEOUT_TARGET[state as keyof typeof TIMEOUT_TARGET];
      const rows = this.#db
        .prepare(`SELECT id, stats FROM knowledge_entries WHERE lifecycle = ?`)
        .all(state) as { id: string; stats: string }[];

      result.checked += rows.length;

      for (const row of rows) {
        const stats = safeJsonParse<Record<string, unknown>>(row.stats, {});
        const entryKey = ENTRY_META_KEYS[state];
        const enteredAt = (entryKey ? stats[entryKey] : null) as number | null;

        // 用 updatedAt 作为 fallback
        const stateAge = enteredAt ? now - enteredAt : this.#getRecipeAge(row.id, now);
        if (stateAge > timeoutMs) {
          const transitionResult = this.transition({
            recipeId: row.id,
            targetState,
            trigger: 'timeout-recovery',
            evidence: {
              reason: `${state} timeout after ${Math.round(stateAge / (24 * 60 * 60 * 1000))}d`,
            },
          });

          if (transitionResult.success) {
            result.timedOut.push({
              recipeId: row.id,
              fromState: state,
              toState: targetState,
              age: stateAge,
            });
          }
        }
      }
    }

    if (result.timedOut.length > 0) {
      this.#logger.info(
        `[Supervisor] Timeout check: ${result.timedOut.length} recipes timed out (checked: ${result.checked})`
      );
    }

    return result;
  }

  /* ═══════════════════ Query ═══════════════════ */

  /**
   * 查询 Recipe 的转移历史
   */
  getTransitionHistory(recipeId: string, limit = 50): TransitionEvent[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT id, recipe_id, from_state, to_state, trigger, operator_id,
                  evidence_json, proposal_id, created_at
           FROM lifecycle_transition_events
           WHERE recipe_id = ?
           ORDER BY created_at DESC
           LIMIT ?`
        )
        .all(recipeId, limit) as Record<string, unknown>[];

      return rows.map((row) => this.#rowToEvent(row));
    } catch {
      // 表可能不存在（migration 未运行）
      return [];
    }
  }

  /**
   * 获取全局状态健康摘要
   */
  getHealthSummary(): LifecycleHealthSummary {
    const now = Date.now();

    // 状态分布
    const stateDistribution = this.#getStateDistribution();

    // 中间态卡死检测
    const intermediateStates = {
      stuckEvolving: this.#getStuckInfo('evolving', STUCK_THRESHOLD_MS.evolving, now),
      stuckDecaying: this.#getStuckInfo('decaying', STUCK_THRESHOLD_MS.decaying, now),
      stuckStaging: this.#getStuckInfo('staging', STUCK_THRESHOLD_MS.staging, now),
      stuckPending: this.#getStuckInfo('pending', STUCK_THRESHOLD_MS.pending, now),
    };

    // 最近转移统计
    const recentTransitions = this.#getRecentTransitionStats(now);

    // Proposal 指标
    const proposalMetrics = this.#getProposalMetrics();

    return { stateDistribution, intermediateStates, recentTransitions, proposalMetrics };
  }

  /* ═══════════════════ Entry/Exit Actions ═══════════════════ */

  #executeEntryAction(
    recipeId: string,
    state: string,
    now: number,
    proposalId?: string | null
  ): void {
    const metaKey = ENTRY_META_KEYS[state];
    if (!metaKey) {
      return;
    }

    const statsRow = this.#db
      .prepare(`SELECT stats FROM knowledge_entries WHERE id = ?`)
      .get(recipeId) as { stats: string } | undefined;

    const stats = safeJsonParse<Record<string, unknown>>(statsRow?.stats, {});
    stats[metaKey] = now;

    if (state === 'evolving' && proposalId) {
      stats.evolvingProposalId = proposalId;
    }
    if (state === 'active') {
      // 清除中间态元数据
      delete stats.evolvingStartedAt;
      delete stats.evolvingProposalId;
      delete stats.decayStartedAt;
    }
    if (state === 'deprecated') {
      stats.deprecatedAt = now;
    }

    this.#db
      .prepare(`UPDATE knowledge_entries SET stats = ? WHERE id = ?`)
      .run(JSON.stringify(stats), recipeId);
  }

  #executeExitAction(recipeId: string, state: string): void {
    if (state === 'active') {
      // 记录 lastActiveAt
      const statsRow = this.#db
        .prepare(`SELECT stats FROM knowledge_entries WHERE id = ?`)
        .get(recipeId) as { stats: string } | undefined;
      const stats = safeJsonParse<Record<string, unknown>>(statsRow?.stats, {});
      stats.lastActiveAt = Date.now();
      this.#db
        .prepare(`UPDATE knowledge_entries SET stats = ? WHERE id = ?`)
        .run(JSON.stringify(stats), recipeId);
    }
    // staging exit: 清除 staging 元数据（由 StagingManager 自行处理）
  }

  /* ═══════════════════ Event Recording ═══════════════════ */

  #recordEvent(params: {
    recipeId: string;
    fromState: string;
    toState: string;
    trigger: string;
    evidence: import('../../types/evolution.js').TransitionEvidence | null;
    proposalId: string | null;
    operatorId: string;
    createdAt: number;
  }): TransitionEvent {
    const id = randomUUID();
    const event: TransitionEvent = {
      id,
      recipeId: params.recipeId,
      fromState: params.fromState,
      toState: params.toState,
      trigger: params.trigger as TransitionEvent['trigger'],
      evidence: params.evidence,
      proposalId: params.proposalId,
      operatorId: params.operatorId,
      createdAt: params.createdAt,
    };

    try {
      this.#db
        .prepare(
          `INSERT INTO lifecycle_transition_events
           (id, recipe_id, from_state, to_state, trigger, operator_id, evidence_json, proposal_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          params.recipeId,
          params.fromState,
          params.toState,
          params.trigger,
          params.operatorId,
          params.evidence ? JSON.stringify(params.evidence) : null,
          params.proposalId,
          params.createdAt
        );
    } catch {
      // lifecycle_transition_events 表可能不存在（降级容忍）
      this.#logger.warn(`[Supervisor] Failed to record transition event (table may not exist)`);
    }

    return event;
  }

  /* ═══════════════════ Health Queries ═══════════════════ */

  #getStateDistribution(): Record<string, number> {
    const dist: Record<string, number> = {
      pending: 0,
      staging: 0,
      active: 0,
      evolving: 0,
      decaying: 0,
      deprecated: 0,
    };

    try {
      const rows = this.#db
        .prepare(`SELECT lifecycle, COUNT(*) as cnt FROM knowledge_entries GROUP BY lifecycle`)
        .all() as { lifecycle: string; cnt: number }[];

      for (const row of rows) {
        dist[row.lifecycle] = row.cnt;
      }
    } catch {
      // fallback
    }

    return dist;
  }

  #getStuckInfo(
    state: string,
    thresholdMs: number,
    now: number
  ): { count: number; oldestAge: number } {
    try {
      const rows = this.#db
        .prepare(`SELECT id, stats, updatedAt FROM knowledge_entries WHERE lifecycle = ?`)
        .all(state) as { id: string; stats: string; updatedAt: number }[];

      let count = 0;
      let oldestAge = 0;

      for (const row of rows) {
        const stats = safeJsonParse<Record<string, unknown>>(row.stats, {});
        const metaKey = ENTRY_META_KEYS[state];
        const enteredAt = (metaKey ? stats[metaKey] : null) as number | null;
        const age = enteredAt ? now - enteredAt : now - (row.updatedAt || now);

        if (age > thresholdMs) {
          count++;
          if (age > oldestAge) {
            oldestAge = age;
          }
        }
      }

      return { count, oldestAge };
    } catch {
      return { count: 0, oldestAge: 0 };
    }
  }

  #getRecentTransitionStats(now: number): {
    last24h: number;
    last7d: number;
    topTriggers: { trigger: string; count: number }[];
  } {
    try {
      const last24hCount =
        (
          this.#db
            .prepare(`SELECT COUNT(*) as cnt FROM lifecycle_transition_events WHERE created_at > ?`)
            .get(now - 24 * 60 * 60 * 1000) as { cnt: number } | undefined
        )?.cnt ?? 0;

      const last7dCount =
        (
          this.#db
            .prepare(`SELECT COUNT(*) as cnt FROM lifecycle_transition_events WHERE created_at > ?`)
            .get(now - 7 * 24 * 60 * 60 * 1000) as { cnt: number } | undefined
        )?.cnt ?? 0;

      const triggerRows = this.#db
        .prepare(
          `SELECT trigger, COUNT(*) as cnt
           FROM lifecycle_transition_events
           WHERE created_at > ?
           GROUP BY trigger
           ORDER BY cnt DESC
           LIMIT 5`
        )
        .all(now - 7 * 24 * 60 * 60 * 1000) as { trigger: string; cnt: number }[];

      return {
        last24h: last24hCount,
        last7d: last7dCount,
        topTriggers: triggerRows.map((r) => ({ trigger: r.trigger, count: r.cnt })),
      };
    } catch {
      return { last24h: 0, last7d: 0, topTriggers: [] };
    }
  }

  #getProposalMetrics(): LifecycleHealthSummary['proposalMetrics'] {
    try {
      const statusCounts = this.#db
        .prepare(`SELECT status, COUNT(*) as cnt FROM evolution_proposals GROUP BY status`)
        .all() as { status: string; cnt: number }[];

      const map: Record<string, number> = {};
      for (const row of statusCounts) {
        map[row.status] = row.cnt;
      }

      const pending = map.pending ?? 0;
      const observing = map.observing ?? 0;
      const executed = map.executed ?? 0;
      const rejected = map.rejected ?? 0;
      const expired = map.expired ?? 0;
      const total = executed + rejected + expired;

      // contentPatchRate: 有 patch 的事件 / 总 proposal-execution 事件
      let contentPatchRate = 0;
      try {
        const patchEvents = this.#db
          .prepare(
            `SELECT COUNT(*) as cnt FROM lifecycle_transition_events
             WHERE trigger = 'content-patch-complete'`
          )
          .get() as { cnt: number } | undefined;
        const execEvents = this.#db
          .prepare(
            `SELECT COUNT(*) as cnt FROM lifecycle_transition_events
             WHERE trigger = 'proposal-execution' OR trigger = 'proposal-attach'`
          )
          .get() as { cnt: number } | undefined;
        const patchCount = patchEvents?.cnt ?? 0;
        const execCount = execEvents?.cnt ?? 0;
        contentPatchRate = execCount > 0 ? patchCount / execCount : 0;
      } catch {
        // table may not exist yet
      }

      return {
        pendingCount: pending,
        observingCount: observing,
        executionRate: total > 0 ? executed / total : 0,
        avgObservationDays: 0, // TODO: calculate from resolved proposals
        contentPatchRate,
      };
    } catch {
      return {
        pendingCount: 0,
        observingCount: 0,
        executionRate: 0,
        avgObservationDays: 0,
        contentPatchRate: 0,
      };
    }
  }

  /* ═══════════════════ DB Helpers ═══════════════════ */

  #getRecipeState(recipeId: string): { lifecycle: string } | null {
    const row = this.#db
      .prepare(`SELECT lifecycle FROM knowledge_entries WHERE id = ?`)
      .get(recipeId) as { lifecycle: string } | undefined;
    return row ?? null;
  }

  #getRecipeAge(recipeId: string, now: number): number {
    const row = this.#db
      .prepare(`SELECT updatedAt FROM knowledge_entries WHERE id = ?`)
      .get(recipeId) as { updatedAt: number } | undefined;
    return row ? now - row.updatedAt : 0;
  }

  #rowToEvent(row: Record<string, unknown>): TransitionEvent {
    return {
      id: row.id as string,
      recipeId: row.recipe_id as string,
      fromState: row.from_state as string,
      toState: row.to_state as string,
      trigger: row.trigger as TransitionEvent['trigger'],
      evidence: row.evidence_json ? safeJsonParse(row.evidence_json as string, null) : null,
      proposalId: (row.proposal_id as string) ?? null,
      operatorId: row.operator_id as string,
      createdAt: row.created_at as number,
    };
  }

  /* ═══════════════════ Signal ═══════════════════ */

  #emitSignal(recipeId: string, fromState: string, toState: string, trigger: string): void {
    if (!this.#signalBus) {
      return;
    }
    this.#signalBus.send('lifecycle', 'RecipeLifecycleSupervisor', 0.5, {
      target: recipeId,
      metadata: {
        fromState,
        toState,
        trigger,
      },
    });
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
