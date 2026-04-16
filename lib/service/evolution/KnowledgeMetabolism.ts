/**
 * KnowledgeMetabolism — 知识新陈代谢总线
 *
 * 治理总线：编排三种进化策略 (矛盾检测 + 冗余分析 + 衰退检测)
 *
 * 进化系统重构后：
 *   - 衰退检测 → EvolutionGateway.submit({ action: 'deprecate', source: 'metabolism' })
 *   - 矛盾检测 → RecipeWarning (不走 Proposal，仅信号层)
 *   - 冗余分析 → RecipeWarning (不走 Proposal，仅信号层)
 *
 * 入口：
 *   - runFullCycle() — 完整治理周期（日常定时 / 手动触发）
 *   - checkDecay() — 只做衰退扫描
 *   - checkContradictions() — 只做矛盾检测
 *   - checkRedundancy() — 只做冗余分析
 */

import Logger from '../../infrastructure/logging/Logger.js';

import type { ReportStore } from '../../infrastructure/report/ReportStore.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type { ContradictionDetector, ContradictionResult } from './ContradictionDetector.js';
import type { DecayDetector, DecayScoreResult } from './DecayDetector.js';
import type { EvolutionGateway, EvolutionResult } from './EvolutionGateway.js';
import type { RedundancyAnalyzer, RedundancyResult } from './RedundancyAnalyzer.js';

/* ────────────────────── Types ────────────────────── */

/** Metabolism 内部提案类型，仅保留走 Proposal 的 'deprecate' */
export type ProposalType = 'deprecate';

/** 警告类型（不走 Proposal 的发现型信号） */
export type WarningType = 'contradiction' | 'redundancy';

export interface RecipeWarning {
  type: WarningType;
  targetRecipeId: string;
  relatedRecipeIds: string[];
  confidence: number;
  description: string;
  evidence: string[];
  detectedAt: number;
}

export interface EvolutionProposal {
  /** 进化提案类型 */
  type: ProposalType;
  /** 目标 Recipe ID */
  targetRecipeId: string;
  /** 关联 Recipe IDs */
  relatedRecipeIds: string[];
  /** 置信度 0-1 */
  confidence: number;
  /** 触发来源 */
  source: 'decay';
  /** 描述 */
  description: string;
  /** 原始信号证据 */
  evidence: string[];
  /** 创建时间 */
  proposedAt: number;
}

export interface MetabolismReport {
  /** 矛盾检测结果 */
  contradictions: ContradictionResult[];
  /** 冗余分析结果 */
  redundancies: RedundancyResult[];
  /** 衰退评估结果 */
  decayResults: DecayScoreResult[];
  /** 生成的进化提案（仅 deprecate） */
  proposals: EvolutionProposal[];
  /** 警告信号（矛盾 + 冗余，不走 Proposal） */
  warnings: RecipeWarning[];
  /** 统计摘要 */
  summary: {
    totalScanned: number;
    contradictionCount: number;
    redundancyCount: number;
    decayingCount: number;
    proposalCount: number;
    warningCount: number;
  };
}

/* ────────────────────── Class ────────────────────── */

export class KnowledgeMetabolism {
  #contradictionDetector: ContradictionDetector;
  #redundancyAnalyzer: RedundancyAnalyzer;
  #decayDetector: DecayDetector;
  #signalBus: SignalBus | null;
  #reportStore: ReportStore | null;
  #gateway: EvolutionGateway | null;
  #warningRepo: import('../../repository/evolution/WarningRepository.js').WarningRepository | null;
  #logger = Logger.getInstance();
  #pendingTriggers: unknown[] = [];
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  constructor(options: {
    contradictionDetector: ContradictionDetector;
    redundancyAnalyzer: RedundancyAnalyzer;
    decayDetector: DecayDetector;
    signalBus?: SignalBus;
    reportStore?: ReportStore;
    evolutionGateway?: EvolutionGateway;
    warningRepository?: import('../../repository/evolution/WarningRepository.js').WarningRepository;
  }) {
    this.#contradictionDetector = options.contradictionDetector;
    this.#redundancyAnalyzer = options.redundancyAnalyzer;
    this.#decayDetector = options.decayDetector;
    this.#signalBus = options.signalBus ?? null;
    this.#reportStore = options.reportStore ?? null;
    this.#gateway = options.evolutionGateway ?? null;
    this.#warningRepo = options.warningRepository ?? null;

    // Phase 2: 订阅告警型信号，触发代谢周期
    if (this.#signalBus) {
      this.#signalBus.subscribe('decay|quality|anomaly', (signal) => {
        this.#pendingTriggers.push(signal);
        this.#scheduleMetabolism();
      });
    }
  }

  #scheduleMetabolism(): void {
    // 当前正在执行周期时，忽略信号（防止自身产出的信号导致无限循环）
    if (this.#running) {
      return;
    }
    if (this.#debounceTimer) {
      return;
    }
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      if (this.#pendingTriggers.length > 0 && !this.#running) {
        void this.runFullCycle();
        this.#pendingTriggers = [];
      }
    }, 30_000);
  }

  /**
   * 执行完整治理周期
   */
  async runFullCycle(): Promise<MetabolismReport> {
    if (this.#running) {
      this.#logger.warn('KnowledgeMetabolism: cycle already in progress, skipping');
      return {
        contradictions: [],
        redundancies: [],
        decayResults: [],
        proposals: [],
        warnings: [],
        summary: {
          totalScanned: 0,
          contradictionCount: 0,
          redundancyCount: 0,
          decayingCount: 0,
          proposalCount: 0,
          warningCount: 0,
        },
      };
    }

    this.#running = true;
    // 清除执行期间积累的信号，避免周期结束后立刻再次触发
    this.#pendingTriggers = [];

    try {
      this.#logger.info('KnowledgeMetabolism: starting full governance cycle');

      // 1. 衰退检测
      const decayResults = await this.#decayDetector.scanAll();

      // 2. 矛盾检测
      const contradictions = await this.#contradictionDetector.detectAll();

      // 3. 冗余分析
      const redundancies = await this.#redundancyAnalyzer.analyzeAll();

      // 4. 生成进化提案（仅衰退走 Proposal）
      const proposals: EvolutionProposal[] = this.#proposalsFromDecay(decayResults);

      // 5. 生成警告信号（矛盾 + 冗余，不走 Proposal）
      const warnings: RecipeWarning[] = [
        ...this.#warningsFromContradictions(contradictions),
        ...this.#warningsFromRedundancies(redundancies),
      ];

      // 6. 通过 EvolutionGateway 提交 deprecate 提案
      let persistedCount = 0;
      const gatewayResults: EvolutionResult[] = [];
      if (this.#gateway && proposals.length > 0) {
        for (const p of proposals) {
          const result = await this.#gateway.submit({
            recipeId: p.targetRecipeId,
            action: 'deprecate',
            source: 'metabolism',
            confidence: p.confidence,
            description: p.description,
            evidence: p.evidence.map((e) => ({ detail: e })),
          });
          gatewayResults.push(result);
          if (result.outcome === 'proposal-created' || result.outcome === 'immediately-executed') {
            persistedCount++;
          }
        }
      }

      // 7. 持久化 warnings 到 DB（去重 upsert）
      if (this.#warningRepo && warnings.length > 0) {
        try {
          this.#warningRepo.upsertBatch(
            warnings.map((w) => ({
              type: w.type,
              targetRecipeId: w.targetRecipeId,
              relatedRecipeIds: w.relatedRecipeIds,
              confidence: w.confidence,
              description: w.description,
              evidence: w.evidence,
            }))
          );
          this.#logger.info(`KnowledgeMetabolism: persisted ${warnings.length} warnings to DB`);
        } catch (err: unknown) {
          this.#logger.warn(
            `KnowledgeMetabolism: failed to persist warnings: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // 8. 写入治理报告
      if (this.#reportStore && (proposals.length > 0 || warnings.length > 0)) {
        void this.#reportStore.write({
          category: 'governance',
          type: 'metabolism_cycle',
          producer: 'KnowledgeMetabolism',
          data: {
            proposalCount: proposals.length,
            warningCount: warnings.length,
            persistedCount,
            contradictionCount: contradictions.length,
            redundancyCount: redundancies.length,
            decayingCount: decayResults.filter((d) => d.level !== 'healthy' && d.level !== 'watch')
              .length,
          },
          timestamp: Date.now(),
        });
      }

      const report: MetabolismReport = {
        contradictions,
        redundancies,
        decayResults,
        proposals,
        warnings,
        summary: {
          totalScanned: decayResults.length,
          contradictionCount: contradictions.length,
          redundancyCount: redundancies.length,
          decayingCount: decayResults.filter((d) => d.level !== 'healthy' && d.level !== 'watch')
            .length,
          proposalCount: proposals.length,
          warningCount: warnings.length,
        },
      };

      this.#logger.info(
        `KnowledgeMetabolism: cycle complete — ${report.summary.proposalCount} proposals, ${report.summary.warningCount} warnings`
      );

      return report;
    } finally {
      this.#running = false;
      // 清除周期期间积累的信号，防止自身产出的信号立即触发下一轮
      this.#pendingTriggers = [];
    }
  }

  /**
   * 只执行衰退扫描
   */
  async checkDecay(): Promise<DecayScoreResult[]> {
    return await this.#decayDetector.scanAll();
  }

  /**
   * 只执行矛盾检测
   */
  async checkContradictions(): Promise<ContradictionResult[]> {
    return await this.#contradictionDetector.detectAll();
  }

  /**
   * 只执行冗余分析
   */
  async checkRedundancy(): Promise<RedundancyResult[]> {
    return await this.#redundancyAnalyzer.analyzeAll();
  }

  /* ── Warning & Proposal Generation ── */

  #warningsFromContradictions(results: ContradictionResult[]): RecipeWarning[] {
    const now = Date.now();
    return results.map((r) => ({
      type: 'contradiction' as const,
      targetRecipeId: r.recipeA,
      relatedRecipeIds: [r.recipeB],
      confidence: r.confidence,
      description: `${r.type === 'hard' ? 'Hard' : 'Soft'} contradiction detected between recipes`,
      evidence: r.evidence,
      detectedAt: now,
    }));
  }

  #warningsFromRedundancies(results: RedundancyResult[]): RecipeWarning[] {
    const now = Date.now();
    return results.map((r) => ({
      type: 'redundancy' as const,
      targetRecipeId: r.recipeA,
      relatedRecipeIds: [r.recipeB],
      confidence: r.similarity,
      description: `Redundant content detected (similarity: ${(r.similarity * 100).toFixed(0)}%)`,
      evidence: Object.entries(r.dimensions)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}: ${(v * 100).toFixed(0)}%`),
      detectedAt: now,
    }));
  }

  #proposalsFromDecay(results: DecayScoreResult[]): EvolutionProposal[] {
    const now = Date.now();
    return results
      .filter((r) => r.level === 'decaying' || r.level === 'severe' || r.level === 'dead')
      .map((r) => ({
        type: 'deprecate' as const,
        targetRecipeId: r.recipeId,
        relatedRecipeIds: [],
        confidence: Math.max(0.4, 1 - r.decayScore / 100),
        source: 'decay' as const,
        description: `Decay detected: score=${r.decayScore}, level=${r.level}`,
        evidence: r.signals.map((s) => `${s.strategy}: ${s.detail}`),
        proposedAt: now,
      }));
  }
}
