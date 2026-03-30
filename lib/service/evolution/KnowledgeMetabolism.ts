/**
 * KnowledgeMetabolism — 知识新陈代谢总线
 *
 * 治理总线：编排三种进化策略 (矛盾检测 + 冗余分析 + 衰退检测)
 * 产出 EvolutionProposal，通过 ConfidenceRouter + 状态机 驱动转换。
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
import type {
  ProposalRepository,
  ProposalSource,
  ProposalType as RepoProposalType,
} from '../../repository/evolution/ProposalRepository.js';
import type { ContradictionDetector, ContradictionResult } from './ContradictionDetector.js';
import type { DecayDetector, DecayScoreResult } from './DecayDetector.js';
import type { RedundancyAnalyzer, RedundancyResult } from './RedundancyAnalyzer.js';

/* ────────────────────── Types ────────────────────── */

export type ProposalType = 'merge' | 'enhance' | 'deprecate' | 'contradiction' | 'correction';

export interface EvolutionProposal {
  /** 进化提案类型 */
  type: ProposalType;
  /** 目标 Recipe ID */
  targetRecipeId: string;
  /** 关联 Recipe IDs（合并/矛盾对象） */
  relatedRecipeIds: string[];
  /** 置信度 0-1 */
  confidence: number;
  /** 触发来源 */
  source: 'contradiction' | 'redundancy' | 'decay' | 'enhancement';
  /** 描述 */
  description: string;
  /** 原始信号证据 */
  evidence: string[];
  /** 创建时间 */
  proposedAt: number;
  /** 过期时间 */
  expiresAt: number;
}

export interface MetabolismReport {
  /** 矛盾检测结果 */
  contradictions: ContradictionResult[];
  /** 冗余分析结果 */
  redundancies: RedundancyResult[];
  /** 衰退评估结果 */
  decayResults: DecayScoreResult[];
  /** 生成的进化提案 */
  proposals: EvolutionProposal[];
  /** 统计摘要 */
  summary: {
    totalScanned: number;
    contradictionCount: number;
    redundancyCount: number;
    decayingCount: number;
    proposalCount: number;
  };
}

/* ────────────────────── Constants ────────────────────── */

const PROPOSAL_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

/* ────────────────────── Class ────────────────────── */

export class KnowledgeMetabolism {
  #contradictionDetector: ContradictionDetector;
  #redundancyAnalyzer: RedundancyAnalyzer;
  #decayDetector: DecayDetector;
  #signalBus: SignalBus | null;
  #reportStore: ReportStore | null;
  #proposalRepo: ProposalRepository | null;
  #logger = Logger.getInstance();
  #pendingTriggers: unknown[] = [];
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    contradictionDetector: ContradictionDetector;
    redundancyAnalyzer: RedundancyAnalyzer;
    decayDetector: DecayDetector;
    signalBus?: SignalBus;
    reportStore?: ReportStore;
    proposalRepository?: ProposalRepository;
  }) {
    this.#contradictionDetector = options.contradictionDetector;
    this.#redundancyAnalyzer = options.redundancyAnalyzer;
    this.#decayDetector = options.decayDetector;
    this.#signalBus = options.signalBus ?? null;
    this.#reportStore = options.reportStore ?? null;
    this.#proposalRepo = options.proposalRepository ?? null;

    // Phase 2: 订阅告警型信号，触发代谢周期
    if (this.#signalBus) {
      this.#signalBus.subscribe('decay|quality|anomaly', (signal) => {
        this.#pendingTriggers.push(signal);
        this.#scheduleMetabolism();
      });
    }
  }

  #scheduleMetabolism(): void {
    if (this.#debounceTimer) {
      return;
    }
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      if (this.#pendingTriggers.length > 0) {
        this.runFullCycle();
        this.#pendingTriggers = [];
      }
    }, 30_000);
  }

  /**
   * 执行完整治理周期
   */
  runFullCycle(): MetabolismReport {
    this.#logger.info('KnowledgeMetabolism: starting full governance cycle');

    // 1. 衰退检测
    const decayResults = this.#decayDetector.scanAll();

    // 2. 矛盾检测
    const contradictions = this.#contradictionDetector.detectAll();

    // 3. 冗余分析
    const redundancies = this.#redundancyAnalyzer.analyzeAll();

    // 4. 生成进化提案
    const proposals: EvolutionProposal[] = [
      ...this.#proposalsFromContradictions(contradictions),
      ...this.#proposalsFromRedundancies(redundancies),
      ...this.#proposalsFromDecay(decayResults),
    ];

    // 5. 持久化提案到 evolution_proposals 表
    let persistedCount = 0;
    if (this.#proposalRepo && proposals.length > 0) {
      for (const p of proposals) {
        const sourceMap: Record<string, ProposalSource> = {
          contradiction: 'metabolism',
          redundancy: 'metabolism',
          decay: 'decay-scan',
          enhancement: 'metabolism',
        };
        const record = this.#proposalRepo.create({
          type: p.type as RepoProposalType,
          targetRecipeId: p.targetRecipeId,
          relatedRecipeIds: p.relatedRecipeIds,
          confidence: p.confidence,
          source: sourceMap[p.source] ?? 'metabolism',
          description: p.description,
          evidence: p.evidence.map((e) => ({ detail: e })),
        });
        if (record) {
          persistedCount++;
        }
      }
    }

    // 6. 写入治理报告（降级：同时写 ReportStore）
    if (this.#reportStore && proposals.length > 0) {
      void this.#reportStore.write({
        category: 'governance',
        type: 'metabolism_cycle',
        producer: 'KnowledgeMetabolism',
        data: {
          proposalCount: proposals.length,
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
      summary: {
        totalScanned: decayResults.length,
        contradictionCount: contradictions.length,
        redundancyCount: redundancies.length,
        decayingCount: decayResults.filter((d) => d.level !== 'healthy' && d.level !== 'watch')
          .length,
        proposalCount: proposals.length,
      },
    };

    this.#logger.info(
      `KnowledgeMetabolism: cycle complete — ${report.summary.proposalCount} proposals generated`
    );

    return report;
  }

  /**
   * 只执行衰退扫描
   */
  checkDecay(): DecayScoreResult[] {
    return this.#decayDetector.scanAll();
  }

  /**
   * 只执行矛盾检测
   */
  checkContradictions(): ContradictionResult[] {
    return this.#contradictionDetector.detectAll();
  }

  /**
   * 只执行冗余分析
   */
  checkRedundancy(): RedundancyResult[] {
    return this.#redundancyAnalyzer.analyzeAll();
  }

  /* ── Proposal Generation ── */

  #proposalsFromContradictions(results: ContradictionResult[]): EvolutionProposal[] {
    const now = Date.now();
    return results.map((r) => ({
      type: r.type === 'hard' ? ('contradiction' as const) : ('correction' as const),
      targetRecipeId: r.recipeA,
      relatedRecipeIds: [r.recipeB],
      confidence: r.confidence,
      source: 'contradiction' as const,
      description: `${r.type === 'hard' ? 'Hard' : 'Soft'} contradiction detected between recipes`,
      evidence: r.evidence,
      proposedAt: now,
      expiresAt: now + PROPOSAL_TTL,
    }));
  }

  #proposalsFromRedundancies(results: RedundancyResult[]): EvolutionProposal[] {
    const now = Date.now();
    return results.map((r) => ({
      type: 'merge' as const,
      targetRecipeId: r.recipeA,
      relatedRecipeIds: [r.recipeB],
      confidence: r.similarity,
      source: 'redundancy' as const,
      description: `Redundant content detected (similarity: ${(r.similarity * 100).toFixed(0)}%)`,
      evidence: Object.entries(r.dimensions)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}: ${(v * 100).toFixed(0)}%`),
      proposedAt: now,
      expiresAt: now + PROPOSAL_TTL,
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
        expiresAt: now + PROPOSAL_TTL,
      }));
  }
}
