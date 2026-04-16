/**
 * EvolutionGateway — 统一进化决策入口
 *
 * 所有进化决策（Agent 工具、MCP handler、KnowledgeMetabolism）最终都汇聚到这里。
 * 三种进化方向：update | deprecate | valid
 *
 * 设计意图：
 *   - 消除 Agent tools / MCP handler / Metabolism 各自独立的 Proposal 创建逻辑
 *   - 统一 observation window 策略（按风险等级，而非按旧 ProposalType 分）
 *   - deprecate 路径按来源区分：Agent 高置信 → 立即执行；规则引擎 → 观察窗口
 *
 * @module service/evolution/EvolutionGateway
 */

import Logger from '../../infrastructure/logging/Logger.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type {
  ProposalRecord,
  ProposalRepository,
  ProposalSource,
} from '../../repository/evolution/ProposalRepository.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { RecipeLifecycleSupervisor } from './RecipeLifecycleSupervisor.js';

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
  outcome: 'proposal-created' | 'immediately-executed' | 'verified' | 'skipped' | 'error';
  proposalId?: string;
  error?: string;
}

/* ────────────────────── Constants ────────────────────── */

const OBSERVATION_WINDOWS: Record<RiskTier, number> = {
  low: 24 * 60 * 60 * 1000, // 24h — 高置信度 update
  medium: 72 * 60 * 60 * 1000, // 72h — 普通置信度 update
  high: 7 * 24 * 60 * 60 * 1000, // 7d — deprecate（规则引擎来源）
};

/* ────────────────────── Class ────────────────────── */

export class EvolutionGateway {
  readonly #proposalRepo: ProposalRepository;
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;
  readonly #supervisor: RecipeLifecycleSupervisor | null;
  readonly #signalBus: SignalBus | null;
  readonly #logger = Logger.getInstance();

  constructor(
    proposalRepo: ProposalRepository,
    knowledgeRepo: KnowledgeRepositoryImpl,
    options?: {
      supervisor?: RecipeLifecycleSupervisor;
      signalBus?: SignalBus;
    }
  ) {
    this.#proposalRepo = proposalRepo;
    this.#knowledgeRepo = knowledgeRepo;
    this.#supervisor = options?.supervisor ?? null;
    this.#signalBus = options?.signalBus ?? null;
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
        return this.#handleUpdate(decision);

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
    // 刷新 lastVerifiedAt
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

  #handleUpdate(decision: EvolutionDecision): EvolutionResult {
    const tier = resolveRiskTier(decision);
    const now = Date.now();
    const expiresAt = now + OBSERVATION_WINDOWS[tier];

    const proposal = this.#proposalRepo.create({
      type: 'update',
      targetRecipeId: decision.recipeId,
      relatedRecipeIds: decision.replacedByRecipeId ? [decision.replacedByRecipeId] : [],
      confidence: Math.max(0, Math.min(1, decision.confidence)),
      source: decision.source,
      description: decision.description ?? '',
      evidence: decision.evidence ?? [],
      expiresAt,
    });

    if (!proposal) {
      return {
        recipeId: decision.recipeId,
        action: 'update',
        outcome: 'skipped',
        error: 'Duplicate proposal or creation failed',
      };
    }

    this.#emitSignal('proposals-created', decision.recipeId, proposal);
    this.#logger.info(
      `[EvolutionGateway] update proposal created: ${proposal.id} (tier=${tier}, expires=${new Date(expiresAt).toISOString()})`
    );

    return {
      recipeId: decision.recipeId,
      action: 'update',
      outcome: 'proposal-created',
      proposalId: proposal.id,
    };
  }

  async #handleDeprecate(decision: EvolutionDecision): Promise<EvolutionResult> {
    // Agent 高置信度（ide-agent/decay-scan + confidence ≥ 0.8）→ 立即执行
    if (decision.source !== 'metabolism' && decision.confidence >= 0.8) {
      return this.#immediateDeprecate(decision);
    }

    // 规则引擎 / 低置信度 → 创建 proposal with 7d 观察窗口
    const now = Date.now();
    const expiresAt = now + OBSERVATION_WINDOWS.high;

    const proposal = this.#proposalRepo.create({
      type: 'deprecate',
      targetRecipeId: decision.recipeId,
      relatedRecipeIds: decision.replacedByRecipeId ? [decision.replacedByRecipeId] : [],
      confidence: Math.max(0, Math.min(1, decision.confidence)),
      source: decision.source,
      description: decision.description ?? decision.reason ?? '',
      evidence: decision.evidence ?? [],
      expiresAt,
    });

    if (!proposal) {
      return {
        recipeId: decision.recipeId,
        action: 'deprecate',
        outcome: 'skipped',
        error: 'Duplicate proposal or creation failed',
      };
    }

    this.#emitSignal('proposals-created', decision.recipeId, proposal);
    this.#logger.info(
      `[EvolutionGateway] deprecate proposal created: ${proposal.id} (7d observation)`
    );

    return {
      recipeId: decision.recipeId,
      action: 'deprecate',
      outcome: 'proposal-created',
      proposalId: proposal.id,
    };
  }

  async #immediateDeprecate(decision: EvolutionDecision): Promise<EvolutionResult> {
    const reason = decision.reason ?? decision.description ?? 'Agent confirmed deprecation';

    try {
      if (this.#supervisor) {
        const result = await this.#supervisor.transition({
          recipeId: decision.recipeId,
          targetState: 'deprecated',
          trigger: 'evolution-gateway',
          evidence: { reason },
          operatorId: decision.source,
        });

        if (!result.success) {
          // Supervisor 拒绝 → 降级直接更新
          await this.#knowledgeRepo.updateLifecycle(decision.recipeId, 'deprecated');
        }
      } else {
        await this.#knowledgeRepo.updateLifecycle(decision.recipeId, 'deprecated');
      }

      // 解决关联的 deprecate proposals
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

  #emitSignal(event: string, recipeId: string, proposal: ProposalRecord): void {
    if (!this.#signalBus) {
      return;
    }
    this.#signalBus.send('lifecycle', 'EvolutionGateway', proposal.confidence, {
      target: recipeId,
      metadata: {
        event,
        proposalId: proposal.id,
        proposalType: proposal.type,
        source: proposal.source,
      },
    });
  }
}

/* ────────────────────── Util ────────────────────── */

export function resolveRiskTier(decision: {
  action: EvolutionAction;
  confidence: number;
}): RiskTier {
  if (decision.action === 'deprecate') {
    return 'high';
  }
  if (decision.action === 'update' && decision.confidence >= 0.8) {
    return 'low';
  }
  return 'medium';
}
