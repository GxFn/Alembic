/**
 * EvolutionGateway — 统一进化决策入口
 *
 * 所有进化决策（Agent 工具、MCP handler、RelevanceAuditor）最终都汇聚到这里。
 * 三种进化方向：update | deprecate | valid
 *
 * 设计意图：
 *   - 消除 Agent tools / MCP handler / Metabolism 各自独立的 Proposal 创建逻辑
 *   - 统一 observation window 策略（按风险等级，由 EvolutionPolicy 集中管理）
 *   - deprecate 路径按来源区分：Agent 高置信 → 立即执行；规则引擎 → 观察窗口
 *   - lifecycle 变更通过 LifecycleStateMachine 唯一路径，Guard 拒绝 → 降级为 Proposal
 *
 * @module service/evolution/EvolutionGateway
 */

import { EvolutionPolicy } from '../../domain/evolution/EvolutionPolicy.js';
import Logger from '../../infrastructure/logging/Logger.js';
import type {
  ProposalRepository,
  ProposalSource,
} from '../../repository/evolution/ProposalRepository.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { LifecycleStateMachine } from './LifecycleStateMachine.js';

/* ────────────────────── Types ────────────────────── */

/** Recipe 进化的三种且仅有三种方向 */
export type EvolutionAction = 'update' | 'deprecate' | 'valid';

/** 风险等级，决定观察窗口时长 */
export type RiskTier = 'low' | 'medium' | 'high';

/** 提交给 Gateway 的进化决策 */
export interface EvolutionDecision {
  recipeId: string;
  action: EvolutionAction;
  source: ProposalSource;
  confidence: number;
  description?: string;
  evidence?: Record<string, unknown>[];
  reason?: string;
  /** supersede 场景：被替代 Recipe 的 ID */
  replacedByRecipeId?: string;
}

/** Gateway 处理结果 */
export interface EvolutionResult {
  recipeId: string;
  action: EvolutionAction;
  outcome:
    | 'proposal-created'
    | 'proposal-upgraded'
    | 'immediately-executed'
    | 'verified'
    | 'skipped'
    | 'error';
  proposalId?: string;
  error?: string;
}

/* ────────────────────── Class ────────────────────── */

export class EvolutionGateway {
  readonly #proposalRepo: ProposalRepository;
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;
  readonly #lifecycle: LifecycleStateMachine;
  readonly #logger = Logger.getInstance();

  constructor(
    proposalRepo: ProposalRepository,
    lifecycle: LifecycleStateMachine,
    knowledgeRepo: KnowledgeRepositoryImpl
  ) {
    this.#proposalRepo = proposalRepo;
    this.#lifecycle = lifecycle;
    this.#knowledgeRepo = knowledgeRepo;
  }

  /**
   * 统一提交进化决策
   */
  async submit(decision: EvolutionDecision): Promise<EvolutionResult> {
    const { recipeId, action } = decision;

    // 前置检查：Recipe 是否存在
    const entry = await this.#knowledgeRepo.findById(recipeId);
    if (!entry) {
      return { recipeId, action, outcome: 'error', error: 'Recipe not found' };
    }

    switch (action) {
      case 'valid':
        return this.#handleValid(decision, entry);

      case 'update':
        return this.#createProposal(decision);

      case 'deprecate':
        return this.#handleDeprecate(decision);

      default:
        return { recipeId, action, outcome: 'error', error: `Unknown action: ${action}` };
    }
  }

  /**
   * 批量提交进化决策
   */
  async submitBatch(decisions: EvolutionDecision[]): Promise<EvolutionResult[]> {
    const results: EvolutionResult[] = [];
    for (const decision of decisions) {
      results.push(await this.submit(decision));
    }
    return results;
  }

  /* ═══════════════════ Handlers ═══════════════════ */

  #handleValid(
    decision: EvolutionDecision,
    entry: { id: string; stats?: unknown }
  ): EvolutionResult {
    try {
      const stats = (typeof entry.stats === 'object' ? entry.stats : {}) as Record<string, unknown>;
      stats.lastVerifiedAt = Date.now();
      void this.#knowledgeRepo.updateStats(decision.recipeId, stats);
    } catch (err: unknown) {
      this.#logger.warn(
        `[EvolutionGateway] Failed to update lastVerifiedAt for ${decision.recipeId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return { recipeId: decision.recipeId, action: 'valid', outcome: 'verified' };
  }

  async #handleDeprecate(decision: EvolutionDecision): Promise<EvolutionResult> {
    if (
      EvolutionPolicy.shouldImmediateExecute(decision.action, decision.confidence, decision.source)
    ) {
      return this.#immediateDeprecate(decision);
    }

    return this.#createProposal(decision);
  }

  async #immediateDeprecate(decision: EvolutionDecision): Promise<EvolutionResult> {
    const reason = decision.reason ?? decision.description ?? 'Agent confirmed deprecation';

    try {
      const result = await this.#lifecycle.transition({
        recipeId: decision.recipeId,
        targetState: 'deprecated',
        trigger: 'evolution-gateway',
        evidence: { reason },
        operatorId: decision.source,
      });

      if (!result.success) {
        // Guard 拒绝 → 降级为创建 Proposal（让人类审查）
        return this.#createProposal(decision);
      }

      this.#resolveExistingDeprecateProposals(decision.recipeId, reason, decision.source);

      this.#logger.info(
        `[EvolutionGateway] immediately deprecated: ${decision.recipeId} (source=${decision.source})`
      );

      return {
        recipeId: decision.recipeId,
        action: 'deprecate',
        outcome: 'immediately-executed',
      };
    } catch (err: unknown) {
      return {
        recipeId: decision.recipeId,
        action: 'deprecate',
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /* ═══════════════════ Proposal Creation ═══════════════════ */

  #createProposal(decision: EvolutionDecision): EvolutionResult {
    const action = decision.action as 'update' | 'deprecate';

    const proposal = this.#proposalRepo.create({
      type: action,
      targetRecipeId: decision.recipeId,
      relatedRecipeIds: decision.replacedByRecipeId ? [decision.replacedByRecipeId] : [],
      confidence: Math.max(0, Math.min(1, decision.confidence)),
      source: decision.source,
      description: decision.description ?? decision.reason ?? '',
      evidence: decision.evidence ?? [],
      expiresAt: 0, // 信号驱动：不再依赖时间过期，由 ProposalExecutor 按信号评估
    });

    if (!proposal) {
      // Dedup 触发 — 尝试升级已有 Proposal 的 evidence
      return this.#tryUpgradeExistingProposal(decision);
    }

    this.#logger.info(
      `[EvolutionGateway] ${action} proposal created: ${proposal.id} (signal-driven, no expiry)`
    );

    return {
      recipeId: decision.recipeId,
      action: decision.action,
      outcome: 'proposal-created',
      proposalId: proposal.id,
    };
  }

  /**
   * Dedup 后尝试升级已有 Proposal 的 evidence。
   *
   * 典型场景：FileChangeHandler 先创建了仅含检测元数据的 update Proposal（无 suggestedChanges），
   * 之后 Agent 增量扫描产出了带 suggestedChanges 的更丰富 evidence。
   * 此时将新 evidence 追加到已有 Proposal，确保 ContentPatcher 能正常消费。
   */
  #tryUpgradeExistingProposal(decision: EvolutionDecision): EvolutionResult {
    const newEvidence = decision.evidence ?? [];
    if (newEvidence.length === 0) {
      return {
        recipeId: decision.recipeId,
        action: decision.action,
        outcome: 'skipped',
        error: 'Duplicate proposal or creation failed',
      };
    }

    try {
      const existing = this.#proposalRepo.findByTarget(decision.recipeId);
      const match = existing.find((p) => p.type === (decision.action as 'update' | 'deprecate'));

      if (!match) {
        return {
          recipeId: decision.recipeId,
          action: decision.action,
          outcome: 'skipped',
          error: 'Duplicate proposal or creation failed',
        };
      }

      // 检查新 evidence 是否比已有的更有价值（含 suggestedChanges）
      const newHasChanges = newEvidence.some(
        (e) => typeof (e as Record<string, unknown>).suggestedChanges === 'string'
      );
      const existingHasChanges = match.evidence.some(
        (e) => typeof (e as Record<string, unknown>).suggestedChanges === 'string'
      );

      if (newHasChanges && !existingHasChanges) {
        // 追加 Agent 的 evidence（保留原始检测记录）
        const merged = [...match.evidence, ...newEvidence];
        this.#proposalRepo.updateEvidence(match.id, merged);

        this.#logger.info(
          `[EvolutionGateway] Upgraded evidence for existing proposal ${match.id} (source=${decision.source})`
        );

        return {
          recipeId: decision.recipeId,
          action: decision.action,
          outcome: 'proposal-upgraded',
          proposalId: match.id,
        };
      }

      return {
        recipeId: decision.recipeId,
        action: decision.action,
        outcome: 'skipped',
        error: 'Duplicate proposal (evidence not richer)',
      };
    } catch (err: unknown) {
      this.#logger.warn(
        `[EvolutionGateway] Failed to upgrade existing proposal: ${err instanceof Error ? err.message : String(err)}`
      );
      return {
        recipeId: decision.recipeId,
        action: decision.action,
        outcome: 'skipped',
        error: 'Duplicate proposal or creation failed',
      };
    }
  }

  /* ═══════════════════ Helpers ═══════════════════ */

  #resolveExistingDeprecateProposals(recipeId: string, reason: string, resolvedBy: string): void {
    try {
      const existing = this.#proposalRepo.findByTarget(recipeId);
      for (const p of existing) {
        if (p.type === 'deprecate') {
          this.#proposalRepo.markExecuted(p.id, `Gateway: ${reason}`, resolvedBy);
        }
      }
    } catch (err: unknown) {
      this.#logger.warn(
        `[EvolutionGateway] Failed to resolve existing deprecate proposals for ${recipeId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
