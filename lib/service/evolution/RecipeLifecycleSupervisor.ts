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
import type { LifecycleEventRepository } from '../../repository/evolution/LifecycleEventRepository.js';
import type { ProposalRepository } from '../../repository/evolution/ProposalRepository.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type {
  LifecycleHealthSummary,
  TimeoutCheckResult,
  TransitionEvent,
  TransitionRequest,
  TransitionResult,
} from '../../types/evolution.js';

/* ────────────────────── Types ────────────────────── */

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
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;
  readonly #proposalRepo: ProposalRepository | null;
  readonly #lifecycleEventRepo: LifecycleEventRepository | null;
  readonly #signalBus: SignalBus | null;
  readonly #logger = Logger.getInstance();

  constructor(
    knowledgeRepo: KnowledgeRepositoryImpl,
    options: {
      signalBus?: SignalBus;
      lifecycleEventRepo?: LifecycleEventRepository;
      proposalRepo?: ProposalRepository;
    } = {}
  ) {
    this.#knowledgeRepo = knowledgeRepo;
    this.#proposalRepo = options.proposalRepo ?? null;
    this.#lifecycleEventRepo = options.lifecycleEventRepo ?? null;
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
  async transition(request: TransitionRequest): Promise<TransitionResult> {
    const { recipeId, targetState, trigger, evidence, proposalId, operatorId } = request;
    const opId = operatorId ?? 'system';

    // 1. 获取当前状态
    const current = await this.#getRecipeState(recipeId);
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
    await this.#executeExitAction(recipeId, fromState);

    // 4. 更新 lifecycle
    const now = Date.now();
    await this.#knowledgeRepo.updateLifecycle(recipeId, targetState);

    // 5. Entry Action
    await this.#executeEntryAction(recipeId, targetState, now, proposalId);

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
  async checkTimeouts(): Promise<TimeoutCheckResult> {
    const result: TimeoutCheckResult = { timedOut: [], checked: 0 };
    const now = Date.now();

    for (const [state, timeoutMs] of Object.entries(TIMEOUT_MS)) {
      if (!(state in TIMEOUT_TARGET)) {
        continue;
      }

      const targetState = TIMEOUT_TARGET[state as keyof typeof TIMEOUT_TARGET];
      const entries = await this.#knowledgeRepo.findAllByLifecycles([state]);

      result.checked += entries.length;

      for (const entry of entries) {
        const stats = (entry.stats ?? {}) as unknown as Record<string, unknown>;
        const entryKey = ENTRY_META_KEYS[state];
        const enteredAt = (entryKey ? stats[entryKey] : null) as number | null;

        const stateAge = enteredAt ? now - enteredAt : await this.#getRecipeAge(entry.id, now);
        if (stateAge > timeoutMs) {
          const transitionResult = await this.transition({
            recipeId: entry.id,
            targetState,
            trigger: 'timeout-recovery',
            evidence: {
              reason: `${state} timeout after ${Math.round(stateAge / (24 * 60 * 60 * 1000))}d`,
            },
          });

          if (transitionResult.success) {
            result.timedOut.push({
              recipeId: entry.id,
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
      if (!this.#lifecycleEventRepo) {
        return [];
      }
      return this.#lifecycleEventRepo.getHistory(recipeId, limit);
    } catch {
      // 表可能不存在（migration 未运行）
      return [];
    }
  }

  /**
   * 获取全局状态健康摘要
   */
  async getHealthSummary(): Promise<LifecycleHealthSummary> {
    const now = Date.now();

    const stateDistribution = await this.#getStateDistribution();

    const intermediateStates = {
      stuckEvolving: await this.#getStuckInfo('evolving', STUCK_THRESHOLD_MS.evolving, now),
      stuckDecaying: await this.#getStuckInfo('decaying', STUCK_THRESHOLD_MS.decaying, now),
      stuckStaging: await this.#getStuckInfo('staging', STUCK_THRESHOLD_MS.staging, now),
      stuckPending: await this.#getStuckInfo('pending', STUCK_THRESHOLD_MS.pending, now),
    };

    // 最近转移统计
    const recentTransitions = this.#getRecentTransitionStats(now);

    // Proposal 指标
    const proposalMetrics = this.#getProposalMetrics();

    return { stateDistribution, intermediateStates, recentTransitions, proposalMetrics };
  }

  /* ═══════════════════ Entry/Exit Actions ═══════════════════ */

  async #executeEntryAction(
    recipeId: string,
    state: string,
    now: number,
    proposalId?: string | null
  ): Promise<void> {
    const metaKey = ENTRY_META_KEYS[state];
    if (!metaKey) {
      return;
    }

    const entry = await this.#knowledgeRepo.findById(recipeId);
    const stats = (entry?.stats ?? {}) as unknown as Record<string, unknown>;
    stats[metaKey] = now;

    if (state === 'evolving' && proposalId) {
      stats.evolvingProposalId = proposalId;
    }
    if (state === 'active') {
      delete stats.evolvingStartedAt;
      delete stats.evolvingProposalId;
      delete stats.decayStartedAt;
    }
    if (state === 'deprecated') {
      stats.deprecatedAt = now;
    }

    await this.#knowledgeRepo.update(recipeId, { stats } as unknown as Record<string, unknown>);
  }

  async #executeExitAction(recipeId: string, state: string): Promise<void> {
    if (state === 'active') {
      const entry = await this.#knowledgeRepo.findById(recipeId);
      const stats = (entry?.stats ?? {}) as unknown as Record<string, unknown>;
      stats.lastActiveAt = Date.now();
      await this.#knowledgeRepo.update(recipeId, { stats } as unknown as Record<string, unknown>);
    }
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
      if (!this.#lifecycleEventRepo) {
        this.#logger.warn(
          `[Supervisor] No lifecycleEventRepo available, cannot record transition event`
        );
        return event;
      }
      this.#lifecycleEventRepo.record({
        id,
        recipeId: params.recipeId,
        fromState: params.fromState,
        toState: params.toState,
        trigger: params.trigger,
        operatorId: params.operatorId,
        evidence: params.evidence,
        proposalId: params.proposalId,
        createdAt: params.createdAt,
      });
    } catch {
      // lifecycle_transition_events 表可能不存在（降级容忍）
      this.#logger.warn(`[Supervisor] Failed to record transition event (table may not exist)`);
    }

    return event;
  }

  /* ═══════════════════ Health Queries ═══════════════════ */

  async #getStateDistribution(): Promise<Record<string, number>> {
    const dist: Record<string, number> = {
      pending: 0,
      staging: 0,
      active: 0,
      evolving: 0,
      decaying: 0,
      deprecated: 0,
    };

    try {
      const grouped = await this.#knowledgeRepo.countGroupByLifecycle();
      for (const [lifecycle, cnt] of Object.entries(grouped)) {
        dist[lifecycle] = cnt;
      }
    } catch {
      // fallback
    }

    return dist;
  }

  async #getStuckInfo(
    state: string,
    thresholdMs: number,
    now: number
  ): Promise<{ count: number; oldestAge: number }> {
    try {
      const entries = await this.#knowledgeRepo.findAllByLifecycles([state]);

      let count = 0;
      let oldestAge = 0;

      for (const entry of entries) {
        const stats = (entry.stats ?? {}) as unknown as Record<string, unknown>;
        const metaKey = ENTRY_META_KEYS[state];
        const enteredAt = (metaKey ? stats[metaKey] : null) as number | null;
        const age = enteredAt ? now - enteredAt : now - (entry.updatedAt || now);

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
      if (!this.#lifecycleEventRepo) {
        return { last24h: 0, last7d: 0, topTriggers: [] };
      }

      const last24hCount = this.#lifecycleEventRepo.countSince(now - 24 * 60 * 60 * 1000);
      const last7dCount = this.#lifecycleEventRepo.countSince(now - 7 * 24 * 60 * 60 * 1000);
      const topTriggers = this.#lifecycleEventRepo.topTriggersSince(
        now - 7 * 24 * 60 * 60 * 1000,
        5
      );

      return { last24h: last24hCount, last7d: last7dCount, topTriggers };
    } catch {
      return { last24h: 0, last7d: 0, topTriggers: [] };
    }
  }

  #getProposalMetrics(): LifecycleHealthSummary['proposalMetrics'] {
    try {
      const statusMap = this.#proposalRepo
        ? this.#proposalRepo.stats()
        : ({} as Record<string, number>);

      const pending = statusMap.pending ?? 0;
      const observing = statusMap.observing ?? 0;
      const executed = statusMap.executed ?? 0;
      const rejected = statusMap.rejected ?? 0;
      const expired = statusMap.expired ?? 0;
      const total = executed + rejected + expired;

      let contentPatchRate = 0;
      try {
        if (this.#lifecycleEventRepo) {
          const patchCount = this.#lifecycleEventRepo.countByTrigger('content-patch-complete');
          const execCount = this.#lifecycleEventRepo.countByTriggers([
            'proposal-execution',
            'proposal-attach',
          ]);
          contentPatchRate = execCount > 0 ? patchCount / execCount : 0;
        }
      } catch {
        // table may not exist yet
      }

      return {
        pendingCount: pending,
        observingCount: observing,
        executionRate: total > 0 ? executed / total : 0,
        avgObservationDays: 0,
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

  async #getRecipeState(recipeId: string): Promise<{ lifecycle: string } | null> {
    const entry = await this.#knowledgeRepo.findById(recipeId);
    return entry ? { lifecycle: entry.lifecycle } : null;
  }

  async #getRecipeAge(recipeId: string, now: number): Promise<number> {
    const entry = await this.#knowledgeRepo.findById(recipeId);
    return entry ? now - (entry.updatedAt || now) : 0;
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
