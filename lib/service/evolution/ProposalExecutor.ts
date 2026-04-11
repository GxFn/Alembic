/**
 * ProposalExecutor — 到期自动执行引擎
 *
 * 核心职责：
 *   1. 扫描所有 observing 状态的 Proposal，检查是否到期
 *   2. 到期 → 收集观察期表现数据 → 评估执行判据
 *   3. 通过 → 执行操作（merge/deprecate/enhance/...）
 *   4. 不通过 → 拒绝 Proposal，Recipe 恢复原状态
 *
 * 触发时机：UiStartupTasks Stage 5
 *
 * 安全边界：
 *   - Agent 只做分析，ProposalExecutor 做执行
 *   - merge/enhance 执行后 Recipe → staging（走正常路径）
 *   - contradiction/reorganize 始终等开发者确认（不自动执行）
 *   - 到期无判据 → expired
 */

import Logger from '../../infrastructure/logging/Logger.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type {
  ProposalRecord,
  ProposalRepository,
  ProposalType,
} from '../../repository/evolution/ProposalRepository.js';
import type { KnowledgeEdgeRepositoryImpl } from '../../repository/knowledge/KnowledgeEdgeRepository.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { ContentPatcher } from './ContentPatcher.js';
import type { RecipeLifecycleSupervisor } from './RecipeLifecycleSupervisor.js';

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

/* ────────────────────── Constants ────────────────────── */

/** 高风险类型：需开发者确认，不自动执行 */
const HIGH_RISK_TYPES = new Set<ProposalType>(['contradiction', 'reorganize']);

/** 超过此天数未操作的 pending Proposal 自动过期 */
const PENDING_EXPIRY_DAYS = 14;

/* ────────────────────── Class ────────────────────── */

export class ProposalExecutor {
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;
  readonly #edgeRepo: KnowledgeEdgeRepositoryImpl | null;
  readonly #repo: ProposalRepository;
  readonly #signalBus: SignalBus | null;
  readonly #contentPatcher: ContentPatcher | null;
  readonly #supervisor: RecipeLifecycleSupervisor | null;
  readonly #logger = Logger.getInstance();

  constructor(
    knowledgeRepo: KnowledgeRepositoryImpl,
    repo: ProposalRepository,
    options: {
      signalBus?: SignalBus;
      contentPatcher?: ContentPatcher;
      supervisor?: RecipeLifecycleSupervisor;
      knowledgeEdgeRepo?: KnowledgeEdgeRepositoryImpl;
    } = {}
  ) {
    this.#knowledgeRepo = knowledgeRepo;
    this.#repo = repo;
    this.#edgeRepo = options.knowledgeEdgeRepo ?? null;
    this.#signalBus = options.signalBus ?? null;
    this.#contentPatcher = options.contentPatcher ?? null;
    this.#supervisor = options.supervisor ?? null;
  }

  /**
   * 定期调用（UiStartupTasks Stage 5）
   *
   * 扫描所有到期 Proposal → 评估 → 执行/拒绝/过期
   */
  async checkAndExecute(): Promise<ProposalExecutionResult> {
    const result: ProposalExecutionResult = {
      executed: [],
      rejected: [],
      expired: [],
      skipped: [],
    };

    // 1. 处理到期的 observing Proposal
    const expiredObserving = this.#repo.findExpiredObserving();
    for (const proposal of expiredObserving) {
      if (HIGH_RISK_TYPES.has(proposal.type)) {
        // 高风险类型跳过自动执行
        result.skipped.push({
          id: proposal.id,
          type: proposal.type,
          reason: 'high-risk type requires developer confirmation',
        });
        continue;
      }

      await this.#processExpiredProposal(proposal, result);
    }

    // 2. 清理超期未操作的 pending Proposal
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
      case 'merge':
      case 'enhance':
        await this.#executeMergeOrEnhance(proposal, metrics, snapshot, result);
        break;
      case 'supersede':
        await this.#executeSupersede(proposal, metrics, snapshot, result);
        break;
      case 'deprecate':
        await this.#executeDeprecate(proposal, metrics, snapshot, result);
        break;
      case 'correction':
        await this.#executeCorrection(proposal, metrics, result);
        break;
      default:
        result.skipped.push({
          id: proposal.id,
          type: proposal.type,
          reason: `unhandled type: ${proposal.type}`,
        });
    }
  }

  /* ── merge / enhance ── */

  async #executeMergeOrEnhance(
    proposal: ProposalRecord,
    metrics: RecipeMetrics,
    snapshot: RecipeMetrics | null,
    result: ProposalExecutionResult
  ): Promise<void> {
    // 执行判据：
    //   - 目标 Recipe 在观察期内无 FP rate 异常飙升
    //   - 目标 Recipe 在观察期内仍有使用
    const fpOk = metrics.ruleFalsePositiveRate < 0.4;
    const hasUsage = metrics.guardHits > 0 || metrics.searchHits > 0;

    if (fpOk && hasUsage) {
      // 通过 → evolving → ContentPatcher → staging（重走 Grace Period）
      await this.#transitionRecipe(
        proposal.targetRecipeId,
        'evolving',
        'proposal-attach',
        proposal.id
      );
      const patchResult = await this.#tryApplyPatch(proposal, 'agent-suggestion');

      if (patchResult?.skipped || (!patchResult?.success && patchResult !== null)) {
        await this.#transitionRecipe(
          proposal.targetRecipeId,
          'active',
          'content-patch-complete',
          proposal.id
        );
        const skipInfo = patchResult?.skipReason ? `: ${patchResult.skipReason}` : '';
        this.#repo.markExecuted(proposal.id, `观察期合格但 patch 未生效${skipInfo}, 回退 active`);
      } else {
        await this.#transitionRecipe(
          proposal.targetRecipeId,
          'staging',
          'content-patch-complete',
          proposal.id
        );
        const patchInfo = patchResult?.success
          ? `, patched=[${patchResult.fieldsPatched.join(',')}]`
          : '';
        this.#repo.markExecuted(
          proposal.id,
          `观察期表现合格: FP=${(metrics.ruleFalsePositiveRate * 100).toFixed(0)}%, hits=${metrics.guardHits + metrics.searchHits}${patchInfo}`
        );
      }
      result.executed.push({
        id: proposal.id,
        type: proposal.type,
        targetRecipeId: proposal.targetRecipeId,
      });
      this.#emitSignal(proposal, 'executed');
    } else {
      // 不通过 → Recipe 恢复原状态
      await this.#restoreRecipe(proposal.targetRecipeId);
      this.#repo.markRejected(
        proposal.id,
        `观察期表现不达标: FP=${(metrics.ruleFalsePositiveRate * 100).toFixed(0)}%, hasUsage=${hasUsage}`
      );
      result.rejected.push({
        id: proposal.id,
        type: proposal.type,
        reason: fpOk ? 'no usage during observation' : 'FP rate too high',
      });
      this.#emitSignal(proposal, 'rejected');
    }
  }

  /* ── supersede ── */

  async #executeSupersede(
    proposal: ProposalRecord,
    metrics: RecipeMetrics,
    snapshot: RecipeMetrics | null,
    result: ProposalExecutionResult
  ): Promise<void> {
    // 新 Recipe 必须已到达 active
    const newRecipeId = proposal.relatedRecipeIds[0];
    if (!newRecipeId) {
      this.#repo.markRejected(proposal.id, 'no related new recipe specified');
      result.rejected.push({
        id: proposal.id,
        type: proposal.type,
        reason: 'no related new recipe',
      });
      return;
    }

    const newRecipe = await this.#getRecipeLifecycle(newRecipeId);
    if (newRecipe?.lifecycle !== 'active') {
      // 新 Recipe 尚未 active → 跳过，等下次检查
      result.skipped.push({
        id: proposal.id,
        type: proposal.type,
        reason: `new recipe ${newRecipeId} not yet active (lifecycle: ${newRecipe?.lifecycle ?? 'unknown'})`,
      });
      return;
    }

    // 对比新旧 Recipe 的使用数据
    const newMetrics = await this.#collectRecipeMetrics(newRecipeId);
    const oldUsage = metrics.guardHits + metrics.searchHits;
    const newUsage = newMetrics.guardHits + newMetrics.searchHits;

    if (newUsage >= oldUsage * 0.5 || oldUsage === 0) {
      // 新 Recipe 表现足够 → 旧 Recipe → decaying，建立 deprecated_by
      await this.#transitionRecipe(
        proposal.targetRecipeId,
        'decaying',
        'proposal-execution',
        proposal.id
      );
      await this.#createDeprecatedByEdge(newRecipeId, proposal.targetRecipeId);
      this.#repo.markExecuted(
        proposal.id,
        `supersede executed: new usage=${newUsage}, old usage=${oldUsage}`
      );
      result.executed.push({
        id: proposal.id,
        type: proposal.type,
        targetRecipeId: proposal.targetRecipeId,
      });
      this.#emitSignal(proposal, 'executed');
    } else {
      // 新 Recipe 表现不足 → 拒绝
      await this.#restoreRecipe(proposal.targetRecipeId);
      this.#repo.markRejected(
        proposal.id,
        `new recipe usage (${newUsage}) < 50% of old (${oldUsage})`
      );
      result.rejected.push({
        id: proposal.id,
        type: proposal.type,
        reason: 'new recipe insufficient usage',
      });
      this.#emitSignal(proposal, 'rejected');
    }
  }

  /* ── deprecate ── */

  async #executeDeprecate(
    proposal: ProposalRecord,
    metrics: RecipeMetrics,
    snapshot: RecipeMetrics | null,
    result: ProposalExecutionResult
  ): Promise<void> {
    const currentDecay = metrics.decayScore;
    const snapshotDecay = snapshot?.decayScore ?? currentDecay;

    // 观察期内 decayScore 有回升 → 拒绝
    if (currentDecay > snapshotDecay + 10) {
      await this.#restoreRecipe(proposal.targetRecipeId);
      this.#repo.markRejected(
        proposal.id,
        `decayScore recovered: ${snapshotDecay} → ${currentDecay}`
      );
      result.rejected.push({
        id: proposal.id,
        type: proposal.type,
        reason: 'decay score recovered during observation',
      });
      this.#emitSignal(proposal, 'rejected');
      return;
    }

    // 无回升 → 根据 decayScore 决定操作
    if (currentDecay <= 19) {
      // 死亡 → 直接 deprecated
      await this.#transitionRecipe(
        proposal.targetRecipeId,
        'deprecated',
        'proposal-execution',
        proposal.id
      );
      this.#repo.markExecuted(proposal.id, `deprecated (dead): decayScore=${currentDecay}`);
    } else if (currentDecay <= 40) {
      // 严重 → decaying
      await this.#transitionRecipe(
        proposal.targetRecipeId,
        'decaying',
        'proposal-execution',
        proposal.id
      );
      this.#repo.markExecuted(proposal.id, `decaying (severe): decayScore=${currentDecay}`);
    } else {
      // 衰退减缓 → 拒绝
      await this.#restoreRecipe(proposal.targetRecipeId);
      this.#repo.markRejected(
        proposal.id,
        `decayScore above threshold (${currentDecay}), not critical enough`
      );
      result.rejected.push({
        id: proposal.id,
        type: proposal.type,
        reason: `decayScore (${currentDecay}) not critical`,
      });
      this.#emitSignal(proposal, 'rejected');
      return;
    }

    result.executed.push({
      id: proposal.id,
      type: proposal.type,
      targetRecipeId: proposal.targetRecipeId,
    });
    this.#emitSignal(proposal, 'executed');
  }

  /* ── correction ── */

  async #executeCorrection(
    proposal: ProposalRecord,
    metrics: RecipeMetrics,
    result: ProposalExecutionResult
  ): Promise<void> {
    // correction 低风险，到期直接执行（Recipe → evolving → patch → staging 重新审核）
    const hasUsage = metrics.guardHits > 0 || metrics.searchHits > 0;
    if (hasUsage) {
      await this.#transitionRecipe(
        proposal.targetRecipeId,
        'evolving',
        'proposal-attach',
        proposal.id
      );
      const patchResult = await this.#tryApplyPatch(proposal, 'correction');

      if (patchResult?.skipped || (!patchResult?.success && patchResult !== null)) {
        await this.#transitionRecipe(
          proposal.targetRecipeId,
          'active',
          'content-patch-complete',
          proposal.id
        );
        const skipInfo = patchResult?.skipReason ? `: ${patchResult.skipReason}` : '';
        this.#repo.markExecuted(proposal.id, `correction patch 未生效${skipInfo}, 回退 active`);
      } else {
        await this.#transitionRecipe(
          proposal.targetRecipeId,
          'staging',
          'content-patch-complete',
          proposal.id
        );
        const patchInfo = patchResult?.success
          ? `, patched=[${patchResult.fieldsPatched.join(',')}]`
          : '';
        this.#repo.markExecuted(
          proposal.id,
          `correction applied, recipe → evolving → staging for re-review${patchInfo}`
        );
      }
      result.executed.push({
        id: proposal.id,
        type: proposal.type,
        targetRecipeId: proposal.targetRecipeId,
      });
      this.#emitSignal(proposal, 'executed');
    } else {
      this.#repo.markRejected(proposal.id, 'no usage during observation, correction unnecessary');
      result.rejected.push({
        id: proposal.id,
        type: proposal.type,
        reason: 'no usage',
      });
      this.#emitSignal(proposal, 'rejected');
    }
  }

  /* ── expired pending cleanup ── */

  #expireOldPending(result: ProposalExecutionResult): void {
    const cutoff = Date.now() - PENDING_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    const oldPending = this.#repo.find({
      status: 'pending',
      expiredBefore: cutoff,
    });

    for (const proposal of oldPending) {
      this.#repo.markExpired(proposal.id);
      result.expired.push({
        id: proposal.id,
        type: proposal.type,
      });
    }
  }

  /* ═══════════════════ DB Helpers ═══════════════════ */

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

  async #getRecipeLifecycle(recipeId: string): Promise<{ lifecycle: string } | null> {
    const entry = await this.#knowledgeRepo.findById(recipeId);
    return entry ? { lifecycle: entry.lifecycle } : null;
  }

  async #transitionRecipe(
    recipeId: string,
    newLifecycle: string,
    trigger:
      | 'proposal-execution'
      | 'proposal-attach'
      | 'content-patch-complete'
      | 'timeout-recovery' = 'proposal-execution',
    proposalId?: string
  ): Promise<void> {
    if (this.#supervisor) {
      const result = await this.#supervisor.transition({
        recipeId,
        targetState: newLifecycle,
        trigger,
        proposalId,
        operatorId: 'system',
      });
      if (!result.success) {
        this.#logger.warn(
          `[ProposalExecutor] Supervisor rejected transition ${recipeId} → ${newLifecycle}: ${result.error}`
        );
        await this.#knowledgeRepo.updateLifecycle(recipeId, newLifecycle);
      }
    } else {
      await this.#knowledgeRepo.updateLifecycle(recipeId, newLifecycle);
    }
  }

  async #restoreRecipe(recipeId: string): Promise<void> {
    const current = await this.#getRecipeLifecycle(recipeId);
    if (current && (current.lifecycle === 'evolving' || current.lifecycle === 'decaying')) {
      await this.#transitionRecipe(recipeId, 'active');
    }
  }

  /**
   * 尝试通过 ContentPatcher 应用 Proposal 中的 suggestedChanges
   * 降级容忍：无 ContentPatcher 或 patch 失败时返回 null/skipped，不阻塞状态转移
   */
  async #tryApplyPatch(
    proposal: ProposalRecord,
    patchSource: 'agent-suggestion' | 'correction' | 'merge'
  ): Promise<import('../../types/evolution.js').ContentPatchResult | null> {
    if (!this.#contentPatcher) {
      return null;
    }
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
      if (this.#edgeRepo) {
        await this.#edgeRepo.upsertEdge({
          fromId: newRecipeId,
          fromType: 'recipe',
          toId: oldRecipeId,
          toType: 'recipe',
          relation: 'deprecated_by',
          weight: 1.0,
        });
      }
    } catch {
      // knowledge_edges 表可能不存在（降级容忍）
    }
  }

  /* ═══════════════════ Signal ═══════════════════ */

  #emitSignal(proposal: ProposalRecord, action: 'executed' | 'rejected'): void {
    if (!this.#signalBus) {
      return;
    }
    this.#signalBus.send('lifecycle', 'ProposalExecutor', proposal.confidence, {
      target: proposal.targetRecipeId,
      metadata: {
        proposalId: proposal.id,
        proposalType: proposal.type,
        action,
        source: proposal.source,
      },
    });
  }
}

/* ────────────────────── Util ────────────────────── */

function _safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) {
    return fallback;
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
