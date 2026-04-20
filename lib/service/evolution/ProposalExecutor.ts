/**
 * ProposalExecutor — 信号驱动的提案执行引擎
 *
 * 核心职责：
 *   1. 订阅 SignalBus（guard / search / decay / quality），当关联 Recipe 有活跃 Proposal 时触发评估
 *   2. 评估 → 通过 EvolutionPolicy 判定（纯函数）
 *   3. 通过 → 编排执行（update → ContentPatcher / deprecate → LifecycleStateMachine）
 *   4. 不通过 → 继续等待下一个信号
 *
 * 设计原则：
 *   - 从时间驱动转为信号驱动：不再依赖 expiresAt + 定时轮询，而是每个相关信号到达即评估
 *   - 决策逻辑全部委托给 EvolutionPolicy（纯函数）
 *   - 状态转移全部通过 LifecycleStateMachine（唯一权威）
 *   - lifecycle signal 由 StateMachine 内部自动发射
 *   - 所有依赖必需（non-nullable），消除降级路径
 *
 * @module service/evolution/ProposalExecutor
 */

import { EvolutionPolicy } from '../../domain/evolution/EvolutionPolicy.js';
import Logger from '../../infrastructure/logging/Logger.js';
import type { Signal, SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type {
  ProposalRecord,
  ProposalRepository,
  ProposalType,
} from '../../repository/evolution/ProposalRepository.js';
import type { KnowledgeEdgeRepositoryImpl } from '../../repository/knowledge/KnowledgeEdgeRepository.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { ContentPatcher } from './ContentPatcher.js';
import type { LifecycleStateMachine } from './LifecycleStateMachine.js';

/* ────────────────────── Types ────────────────────── */

export interface ProposalExecutionResult {
  executed: { id: string; type: ProposalType; targetRecipeId: string }[];
  rejected: { id: string; type: ProposalType; reason: string }[];
  expired: { id: string; type: ProposalType }[];
  skipped: { id: string; type: ProposalType; reason: string }[];
}

interface RecipeMetrics {
  guardHits: number;
  searchHits: number;
  hitsLast30d: number;
  decayScore: number;
  ruleFalsePositiveRate: number;
  quality: number;
}

/** 触发评估的信号类型 */
const TRIGGER_SIGNAL_TYPES = new Set(['guard', 'search', 'decay', 'quality', 'usage', 'lifecycle']);

/* ────────────────────── Class ────────────────────── */

export class ProposalExecutor {
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;
  readonly #repo: ProposalRepository;
  readonly #lifecycle: LifecycleStateMachine;
  readonly #contentPatcher: ContentPatcher;
  readonly #edgeRepo: KnowledgeEdgeRepositoryImpl;
  readonly #logger = Logger.getInstance();
  #unsubscribe: (() => void) | null = null;

  constructor(
    knowledgeRepo: KnowledgeRepositoryImpl,
    repo: ProposalRepository,
    lifecycle: LifecycleStateMachine,
    contentPatcher: ContentPatcher,
    edgeRepo: KnowledgeEdgeRepositoryImpl
  ) {
    this.#knowledgeRepo = knowledgeRepo;
    this.#repo = repo;
    this.#lifecycle = lifecycle;
    this.#contentPatcher = contentPatcher;
    this.#edgeRepo = edgeRepo;
  }

  /* ═══════════════════ Signal Subscription ═══════════════════ */

  /**
   * 订阅 SignalBus，当信号到达时自动评估关联 Proposal。
   * 调用方负责在关闭时调用 unsubscribe()。
   */
  subscribeToSignals(signalBus: SignalBus): void {
    if (this.#unsubscribe) {
      return; // 幂等
    }

    this.#unsubscribe = signalBus.subscribe(
      'guard|search|decay|quality|usage|lifecycle',
      (signal: Signal) => {
        if (!signal.target) {
          return;
        }
        void this.#onSignal(signal);
      }
    );

    this.#logger.info(
      '[ProposalExecutor] Subscribed to SignalBus for signal-driven proposal evaluation'
    );
  }

  /**
   * 取消信号订阅
   */
  unsubscribe(): void {
    if (this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = null;
    }
  }

  /**
   * 信号到达时：查找该 Recipe 的活跃 Proposal → 评估是否满足执行条件
   */
  async #onSignal(signal: Signal): Promise<void> {
    if (!TRIGGER_SIGNAL_TYPES.has(signal.type)) {
      return;
    }

    const recipeId = signal.target;
    if (!recipeId) {
      return;
    }

    try {
      // 查找该 Recipe 的 observing Proposals
      const proposals = this.#repo.findByTarget(recipeId);
      const activeProposals = proposals.filter((p) => p.status === 'observing');

      if (activeProposals.length === 0) {
        return;
      }

      for (const proposal of activeProposals) {
        await this.#evaluateOnSignal(proposal, signal);
      }
    } catch (err: unknown) {
      this.#logger.warn(
        `[ProposalExecutor] onSignal error for ${recipeId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * 信号触发的单个 Proposal 评估
   *
   * §9.1 增强：source_modified + direct/pattern 信号对 deprecate 提案视为恢复证据。
   */
  async #evaluateOnSignal(proposal: ProposalRecord, signal: Signal): Promise<void> {
    const metrics = await this.#collectRecipeMetrics(proposal.targetRecipeId);

    // §9.1: source_modified + direct/pattern → 源文件仍在被积极编辑/其核心模式被修改
    const isActivelyModified =
      signal.metadata?.reason === 'source_modified' &&
      (signal.metadata?.impactLevel === 'direct' || signal.metadata?.impactLevel === 'pattern');

    switch (proposal.type) {
      case 'update': {
        const verdict = EvolutionPolicy.evaluateUpdate(metrics);
        if (verdict.pass) {
          const result = this.#emptyResult();
          await this.#executeUpdate(proposal, metrics, result);
          if (result.executed.length > 0) {
            this.#logger.info(
              `[ProposalExecutor] Signal-driven update executed: ${proposal.id} (signal=${signal.type})`
            );
          }
        }
        // 不满足条件 → 静默等待下一个信号
        break;
      }
      case 'deprecate': {
        // §9.1: 源文件被直接修改或核心模式被编辑 → Recipe 仍在被使用，拒绝废弃
        if (isActivelyModified) {
          this.#repo.markRejected(
            proposal.id,
            `Source file actively modified (impact=${signal.metadata?.impactLevel}, path=${signal.metadata?.modifiedPath ?? 'unknown'}), recipe likely still relevant`
          );
          this.#logger.info(
            `[ProposalExecutor] Deprecate rejected — source actively modified: ${proposal.id} (impact=${signal.metadata?.impactLevel}, path=${signal.metadata?.modifiedPath})`
          );
          break;
        }

        const snapshot = this.#extractSnapshot(proposal);
        const verdict = EvolutionPolicy.evaluateDeprecate(
          metrics.decayScore,
          snapshot?.decayScore ?? metrics.decayScore
        );
        if (verdict.action !== 'reject') {
          const result = this.#emptyResult();
          await this.#executeDeprecate(proposal, metrics, snapshot, result);
          if (result.executed.length > 0) {
            this.#logger.info(
              `[ProposalExecutor] Signal-driven deprecate executed: ${proposal.id} (signal=${signal.type})`
            );
          }
        }
        // reject (recovered) → 立即拒绝
        else if (verdict.reason.includes('recovered')) {
          this.#repo.markRejected(proposal.id, verdict.reason);
          this.#logger.info(
            `[ProposalExecutor] Signal-driven deprecate rejected (recovered): ${proposal.id}`
          );
        }
        break;
      }
    }
  }

  /**
   * 手动执行单个 Proposal（Dashboard 按钮触发）
   */
  async executeOne(id: string): Promise<ProposalExecutionResult> {
    const result: ProposalExecutionResult = {
      executed: [],
      rejected: [],
      expired: [],
      skipped: [],
    };

    const proposal = this.#repo.findById(id);
    if (!proposal) {
      result.skipped.push({ id, type: 'update', reason: 'not found' });
      return result;
    }

    if (proposal.status !== 'pending' && proposal.status !== 'observing') {
      result.skipped.push({
        id,
        type: proposal.type,
        reason: `invalid status: ${proposal.status}`,
      });
      return result;
    }

    if (proposal.status === 'pending') {
      const ok = this.#repo.startObserving(id);
      if (!ok) {
        result.skipped.push({ id, type: proposal.type, reason: 'failed to start observing' });
        return result;
      }
    }

    await this.#processExpiredProposal(proposal, result);

    if (result.executed.length > 0 || result.rejected.length > 0) {
      this.#logger.info(
        `[ProposalExecutor] executeOne(${id}): ` +
          `executed=${result.executed.length}, rejected=${result.rejected.length}`
      );
    }

    return result;
  }

  /**
   * 启动时一次性清理 — 清理过期 Pending、对长期 Observing 做兜底评估
   *
   * 不再被定时调用，仅在 Dashboard 启动时 / CLI evolve-check 时调用。
   * 主要流程已由 subscribeToSignals() 接管。
   */
  async checkAndExecute(): Promise<ProposalExecutionResult> {
    const result: ProposalExecutionResult = {
      executed: [],
      rejected: [],
      expired: [],
      skipped: [],
    };

    // 兜底：对长期处于 observing 但信号始终未满足的 Proposal 做一次评估
    const observing = this.#repo.find({ status: 'observing' });
    for (const proposal of observing) {
      await this.#processExpiredProposal(proposal, result);
    }

    this.#expireOldPending(result);

    if (result.executed.length > 0 || result.rejected.length > 0 || result.expired.length > 0) {
      this.#logger.info(
        `[ProposalExecutor] checkAndExecute complete: ` +
          `executed=${result.executed.length}, rejected=${result.rejected.length}, expired=${result.expired.length}`
      );
    }

    return result;
  }

  /* ═══════════════════ Internal ═══════════════════ */

  async #processExpiredProposal(
    proposal: ProposalRecord,
    result: ProposalExecutionResult
  ): Promise<void> {
    const metrics = await this.#collectRecipeMetrics(proposal.targetRecipeId);
    const snapshot = this.#extractSnapshot(proposal);

    switch (proposal.type) {
      case 'update':
        await this.#executeUpdate(proposal, metrics, result);
        break;
      case 'deprecate':
        await this.#executeDeprecate(proposal, metrics, snapshot, result);
        break;
      default:
        result.skipped.push({
          id: proposal.id,
          type: proposal.type,
          reason: `unhandled type: ${proposal.type}`,
        });
    }
  }

  /* ── update ── */

  async #executeUpdate(
    proposal: ProposalRecord,
    metrics: RecipeMetrics,
    result: ProposalExecutionResult
  ): Promise<void> {
    const verdict = EvolutionPolicy.evaluateUpdate(metrics);

    if (!verdict.pass) {
      this.#repo.markRejected(proposal.id, verdict.reason);
      result.rejected.push({
        id: proposal.id,
        type: proposal.type,
        reason: verdict.reason,
      });
      return;
    }

    // evolving → patch → staging/active
    const evolveResult = await this.#lifecycle.transition({
      recipeId: proposal.targetRecipeId,
      targetState: 'evolving',
      trigger: 'proposal-attach',
      proposalId: proposal.id,
      operatorId: 'system',
    });

    if (!evolveResult.success) {
      this.#repo.markRejected(proposal.id, `transition failed: ${evolveResult.error}`);
      result.rejected.push({
        id: proposal.id,
        type: proposal.type,
        reason: evolveResult.error ?? 'transition to evolving failed',
      });
      return;
    }

    try {
      const patchResult = await this.#tryApplyPatch(proposal, 'agent-suggestion');
      const nextState = patchResult?.success ? 'staging' : 'active';

      const nextResult = await this.#lifecycle.transition({
        recipeId: proposal.targetRecipeId,
        targetState: nextState,
        trigger: 'content-patch-complete',
        proposalId: proposal.id,
        operatorId: 'system',
      });

      if (!nextResult.success) {
        this.#repo.markRejected(
          proposal.id,
          `transition to ${nextState} failed: ${nextResult.error}`
        );
        result.rejected.push({
          id: proposal.id,
          type: proposal.type,
          reason: nextResult.error ?? `transition to ${nextState} failed`,
        });
        return;
      }

      const resolution = patchResult?.success
        ? `patched=[${patchResult.fieldsPatched.join(',')}]`
        : 'patch skipped, reverted to active';
      this.#repo.markExecuted(proposal.id, resolution);
      result.executed.push({
        id: proposal.id,
        type: proposal.type,
        targetRecipeId: proposal.targetRecipeId,
      });
    } catch (err: unknown) {
      this.#logger.warn(
        `[ProposalExecutor] #executeUpdate failed for ${proposal.targetRecipeId}: ${err instanceof Error ? err.message : String(err)}`
      );
      // Try to revert to active if stuck in evolving
      await this.#lifecycle.transition({
        recipeId: proposal.targetRecipeId,
        targetState: 'active',
        trigger: 'timeout-recovery',
        operatorId: 'system',
      });
      this.#repo.markRejected(
        proposal.id,
        `execution error: ${err instanceof Error ? err.message : String(err)}`
      );
      result.rejected.push({
        id: proposal.id,
        type: proposal.type,
        reason: `execution error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /* ── deprecate ── */

  async #executeDeprecate(
    proposal: ProposalRecord,
    metrics: RecipeMetrics,
    snapshot: RecipeMetrics | null,
    result: ProposalExecutionResult
  ): Promise<void> {
    const verdict = EvolutionPolicy.evaluateDeprecate(
      metrics.decayScore,
      snapshot?.decayScore ?? metrics.decayScore
    );

    if (verdict.action === 'reject') {
      this.#repo.markRejected(proposal.id, verdict.reason);
      result.rejected.push({
        id: proposal.id,
        type: proposal.type,
        reason: verdict.reason,
      });
      return;
    }

    const transResult = await this.#lifecycle.transition({
      recipeId: proposal.targetRecipeId,
      targetState: verdict.action, // 'deprecated' | 'decaying'
      trigger: 'proposal-execution',
      proposalId: proposal.id,
      operatorId: 'system',
    });

    if (!transResult.success) {
      this.#repo.markRejected(proposal.id, `transition failed: ${transResult.error}`);
      result.rejected.push({
        id: proposal.id,
        type: proposal.type,
        reason: transResult.error ?? 'transition failed',
      });
      return;
    }

    this.#repo.markExecuted(proposal.id, verdict.reason);
    result.executed.push({
      id: proposal.id,
      type: proposal.type,
      targetRecipeId: proposal.targetRecipeId,
    });

    // supersede edge
    const replacedBy = proposal.relatedRecipeIds[0];
    if (replacedBy) {
      await this.#createDeprecatedByEdge(replacedBy, proposal.targetRecipeId);
    }
  }

  /* ── expired pending cleanup ── */

  #expireOldPending(result: ProposalExecutionResult): void {
    const now = Date.now();
    const oldPending = this.#repo.find({ status: 'pending' });

    for (const proposal of oldPending) {
      if (EvolutionPolicy.shouldExpirePending(proposal.proposedAt, now)) {
        this.#repo.markExpired(proposal.id);
        result.expired.push({
          id: proposal.id,
          type: proposal.type,
        });
      }
    }
  }

  /* ═══════════════════ DB Helpers ═══════════════════ */

  #emptyResult(): ProposalExecutionResult {
    return { executed: [], rejected: [], expired: [], skipped: [] };
  }

  async #collectRecipeMetrics(recipeId: string): Promise<RecipeMetrics> {
    const entry = await this.#knowledgeRepo.findById(recipeId);

    if (!entry) {
      return {
        guardHits: 0,
        searchHits: 0,
        hitsLast30d: 0,
        decayScore: 0,
        ruleFalsePositiveRate: 0,
        quality: 0,
      };
    }

    const stats = (entry.stats ?? {}) as unknown as Record<string, unknown>;
    const quality = (entry.quality ?? {}) as unknown as Record<string, unknown>;

    return {
      guardHits: (stats.guardHits as number) ?? 0,
      searchHits: (stats.searchHits as number) ?? 0,
      hitsLast30d: (stats.hitsLast30d as number) ?? 0,
      decayScore: (stats.decayScore as number) ?? 50,
      ruleFalsePositiveRate: (stats.ruleFalsePositiveRate as number) ?? 0,
      quality: (quality.overall as number) ?? 0,
    };
  }

  #extractSnapshot(proposal: ProposalRecord): RecipeMetrics | null {
    for (const ev of proposal.evidence) {
      if (ev.snapshotAt && ev.metrics) {
        const m = ev.metrics as unknown as Record<string, unknown>;
        return {
          guardHits: (m.guardHits as number) ?? 0,
          searchHits: (m.searchHits as number) ?? 0,
          hitsLast30d: (m.hitsLast30d as number) ?? 0,
          decayScore: (m.decayScore as number) ?? 50,
          ruleFalsePositiveRate: (m.ruleFalsePositiveRate as number) ?? 0,
          quality: ((m.quality as unknown as Record<string, unknown>)?.overall as number) ?? 0,
        };
      }
    }
    return null;
  }

  async #tryApplyPatch(
    proposal: ProposalRecord,
    patchSource: 'agent-suggestion' | 'correction' | 'merge'
  ): Promise<import('../../types/evolution.js').ContentPatchResult | null> {
    try {
      return await this.#contentPatcher.applyProposal(proposal, patchSource);
    } catch (err: unknown) {
      this.#logger.warn(
        `[ProposalExecutor] ContentPatcher failed for proposal ${proposal.id}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  async #createDeprecatedByEdge(newRecipeId: string, oldRecipeId: string): Promise<void> {
    try {
      await this.#edgeRepo.upsertEdge({
        fromId: newRecipeId,
        fromType: 'recipe',
        toId: oldRecipeId,
        toType: 'recipe',
        relation: 'deprecated_by',
        weight: 1.0,
      });
    } catch {
      // knowledge_edges 表可能不存在（降级容忍）
    }
  }
}
