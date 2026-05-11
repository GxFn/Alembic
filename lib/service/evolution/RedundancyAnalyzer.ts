/**
 * RedundancyAnalyzer — 多维冗余检测
 *
 * 从 CandidateAggregator 的标题 Jaccard 扩展到四维内容级相似度：
 *   维度 1: title Jaccard ≥ 0.7
 *   维度 2: doClause + dontClause 文本相似度 ≥ 0.6
 *   维度 3: coreCode 去空白后字符级相似度 ≥ 0.8
 *   维度 4: guard regex 完全相同
 *
 * 综合: weighted_sum(0.2*d1 + 0.3*d2 + 0.3*d3 + 0.2*d4) ≥ 0.65
 */

import { type RecipeLike, RecipeSimilarity } from '../../domain/evolution/RecipeSimilarity.js';
import { CONSUMABLE_LIFECYCLES } from '../../domain/knowledge/Lifecycle.js';
import Logger from '../../infrastructure/logging/Logger.js';
import type { ReportStore } from '../../infrastructure/report/ReportStore.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';

/* ────────────────────── Types ────────────────────── */

export interface RedundancyResult {
  recipeA: string;
  recipeB: string;
  similarity: number;
  dimensions: {
    title: number;
    clause: number;
    code: number;
    content: number;
    guard: number;
  };
}

interface RecipeForRedundancy {
  id: string;
  title: string;
  doClause: string | null;
  dontClause: string | null;
  coreCode: string | null;
  guardPattern: string | null;
  content: {
    markdown?: string;
    pattern?: string;
    steps?: Array<{ code?: string }>;
  } | null;
}

/* ────────────────────── Constants ────────────────────── */

const WEIGHTS = { title: 0.15, clause: 0.25, code: 0.15, content: 0.3, guard: 0.15 };
const REDUNDANCY_THRESHOLD = 0.65;
/* ────────────────────── Class ────────────────────── */

export class RedundancyAnalyzer {
  #knowledgeRepo: KnowledgeRepositoryImpl;
  #signalBus: SignalBus | null;
  #reportStore: ReportStore | null;
  #logger = Logger.getInstance();

  constructor(
    knowledgeRepo: KnowledgeRepositoryImpl,
    options: { signalBus?: SignalBus; reportStore?: ReportStore } = {}
  ) {
    this.#knowledgeRepo = knowledgeRepo;
    this.#signalBus = options.signalBus ?? null;
    this.#reportStore = options.reportStore ?? null;
  }

  /**
   * 分析所有 active/staging 条目之间的冗余
   */
  async analyzeAll(): Promise<RedundancyResult[]> {
    const recipes = await this.#loadRecipes();
    const results: RedundancyResult[] = [];

    for (let i = 0; i < recipes.length; i++) {
      for (let j = i + 1; j < recipes.length; j++) {
        const result = this.analyzePair(recipes[i], recipes[j]);
        if (result) {
          results.push(result);
        }
      }
    }

    if (this.#reportStore && results.length > 0) {
      for (const r of results) {
        void this.#reportStore.write({
          category: 'analysis',
          type: 'redundancy_report',
          producer: 'RedundancyAnalyzer',
          data: {
            recipeA: r.recipeA,
            redundantWith: r.recipeB,
            dimensions: r.dimensions,
            similarity: r.similarity,
          },
          timestamp: Date.now(),
        });
      }
    }

    if (this.#signalBus && results.length > 0) {
      this.#signalBus.send('lifecycle', 'RedundancyAnalyzer', 1, {
        metadata: { redundantPairCount: results.length },
      });
    }

    this.#logger.debug(`RedundancyAnalyzer: found ${results.length} redundant pairs`);
    return results;
  }

  /**
   * 分析两条 Recipe 的冗余度（委托 RecipeSimilarity 统一算法）
   */
  analyzePair(a: RecipeForRedundancy, b: RecipeForRedundancy): RedundancyResult | null {
    const dims = RecipeSimilarity.computeDimensions(a as RecipeLike, b as RecipeLike);

    const similarity =
      WEIGHTS.title * dims.title +
      WEIGHTS.clause * dims.clause +
      WEIGHTS.code * dims.code +
      WEIGHTS.content * dims.content +
      WEIGHTS.guard * dims.guard;

    if (similarity < REDUNDANCY_THRESHOLD) {
      return null;
    }

    return {
      recipeA: a.id,
      recipeB: b.id,
      similarity: Math.round(similarity * 100) / 100,
      dimensions: {
        title: Math.round(dims.title * 100) / 100,
        clause: Math.round(dims.clause * 100) / 100,
        code: Math.round(dims.code * 100) / 100,
        content: Math.round(dims.content * 100) / 100,
        guard: dims.guard,
      },
    };
  }

  /* ── Internal ── */

  async #loadRecipes(): Promise<RecipeForRedundancy[]> {
    try {
      const entries = await this.#knowledgeRepo.findAllByLifecycles(CONSUMABLE_LIFECYCLES);
      return entries.map((e) => ({
        id: e.id,
        title: e.title,
        doClause: e.doClause || null,
        dontClause: e.dontClause || null,
        coreCode: e.coreCode || null,
        guardPattern: e.content?.pattern || null,
        content: e.content
          ? {
              markdown: e.content.markdown || undefined,
              pattern: e.content.pattern || undefined,
              steps: e.content.steps,
            }
          : null,
      }));
    } catch {
      return [];
    }
  }
}
