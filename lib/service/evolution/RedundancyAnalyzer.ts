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

import Logger from '../../infrastructure/logging/Logger.js';
import type { ReportStore } from '../../infrastructure/report/ReportStore.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import { ContradictionDetector } from './ContradictionDetector.js';

/* ────────────────────── Types ────────────────────── */

interface DatabaseLike {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

export interface RedundancyResult {
  recipeA: string;
  recipeB: string;
  similarity: number;
  dimensions: {
    title: number;
    clause: number;
    code: number;
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
}

/* ────────────────────── Constants ────────────────────── */

const WEIGHTS = { title: 0.2, clause: 0.3, code: 0.3, guard: 0.2 };
const REDUNDANCY_THRESHOLD = 0.65;

/* ────────────────────── Class ────────────────────── */

export class RedundancyAnalyzer {
  #db: DatabaseLike;
  #signalBus: SignalBus | null;
  #reportStore: ReportStore | null;
  #logger = Logger.getInstance();

  constructor(
    db: DatabaseLike,
    options: { signalBus?: SignalBus; reportStore?: ReportStore } = {}
  ) {
    this.#db = db;
    this.#signalBus = options.signalBus ?? null;
    this.#reportStore = options.reportStore ?? null;
  }

  /**
   * 分析所有 active/staging 条目之间的冗余
   */
  analyzeAll(): RedundancyResult[] {
    const recipes = this.#loadRecipes();
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
   * 分析两条 Recipe 的冗余度
   */
  analyzePair(a: RecipeForRedundancy, b: RecipeForRedundancy): RedundancyResult | null {
    const d1 = RedundancyAnalyzer.#titleJaccard(a.title, b.title);
    const d2 = this.#clauseSimilarity(a, b);
    const d3 = RedundancyAnalyzer.#codeSimilarity(a.coreCode, b.coreCode);
    const d4 = a.guardPattern && b.guardPattern && a.guardPattern === b.guardPattern ? 1.0 : 0;

    const similarity =
      WEIGHTS.title * d1 + WEIGHTS.clause * d2 + WEIGHTS.code * d3 + WEIGHTS.guard * d4;

    if (similarity < REDUNDANCY_THRESHOLD) {
      return null;
    }

    return {
      recipeA: a.id,
      recipeB: b.id,
      similarity: Math.round(similarity * 100) / 100,
      dimensions: {
        title: Math.round(d1 * 100) / 100,
        clause: Math.round(d2 * 100) / 100,
        code: Math.round(d3 * 100) / 100,
        guard: d4,
      },
    };
  }

  /* ── Internal ── */

  #loadRecipes(): RecipeForRedundancy[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT id, title,
                do_clause AS doClause,
                dont_clause AS dontClause,
                json_extract(content, '$.pattern') AS guardPattern,
                json_extract(content, '$.coreCode') AS coreCode
         FROM knowledge_entries
         WHERE lifecycle IN ('active', 'staging', 'evolving')`
        )
        .all();
      return rows.map((r) => ({
        id: r.id as string,
        title: r.title as string,
        doClause: (r.doClause as string) ?? null,
        dontClause: (r.dontClause as string) ?? null,
        coreCode: (r.coreCode as string) ?? null,
        guardPattern: (r.guardPattern as string) ?? null,
      }));
    } catch {
      return [];
    }
  }

  /** 维度 1: 标题 Jaccard 相似度 */
  static #titleJaccard(titleA: string, titleB: string): number {
    const wordsA = ContradictionDetector.extractTopicWords(titleA);
    const wordsB = ContradictionDetector.extractTopicWords(titleB);

    if (wordsA.size === 0 && wordsB.size === 0) {
      return 0;
    }

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) {
        intersection++;
      }
    }

    const union = wordsA.size + wordsB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /** 维度 2: doClause + dontClause 文本相似度 */
  #clauseSimilarity(a: RecipeForRedundancy, b: RecipeForRedundancy): number {
    const textA = [a.doClause, a.dontClause].filter(Boolean).join(' ');
    const textB = [b.doClause, b.dontClause].filter(Boolean).join(' ');

    if (!textA || !textB) {
      return 0;
    }

    const wordsA = ContradictionDetector.extractTopicWords(textA);
    const wordsB = ContradictionDetector.extractTopicWords(textB);

    if (wordsA.size === 0 && wordsB.size === 0) {
      return 0;
    }

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) {
        intersection++;
      }
    }

    const union = wordsA.size + wordsB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /** 维度 3: coreCode 去空白后字符级相似度 (简化 Levenshtein → 公共子串比率) */
  static #codeSimilarity(codeA: string | null, codeB: string | null): number {
    if (!codeA || !codeB) {
      return 0;
    }

    const a = codeA.replace(/\s+/g, '');
    const b = codeB.replace(/\s+/g, '');

    if (a.length === 0 && b.length === 0) {
      return 0;
    }

    // 使用最长公共子串（LCS）比率作为相似度的近似
    // 对于较长的代码，使用 n-gram 方法避免 O(n²) 开销
    const maxLen = Math.max(a.length, b.length);
    if (maxLen > 2000) {
      return RedundancyAnalyzer.#ngramSimilarity(a, b, 4);
    }

    const lcsLen = RedundancyAnalyzer.#lcsLength(a, b);
    return (2 * lcsLen) / (a.length + b.length);
  }

  /** 最长公共子序列长度（O(n*m) 但只用 2 行空间） */
  static #lcsLength(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    let prev = new Uint16Array(n + 1);
    let curr = new Uint16Array(n + 1);

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          curr[j] = prev[j - 1] + 1;
        } else {
          curr[j] = Math.max(prev[j], curr[j - 1]);
        }
      }
      [prev, curr] = [curr, prev];
      curr.fill(0);
    }
    return prev[n];
  }

  /** n-gram 相似度（大文本用） */
  static #ngramSimilarity(a: string, b: string, n: number): number {
    const ngramsA = new Set<string>();
    for (let i = 0; i <= a.length - n; i++) {
      ngramsA.add(a.slice(i, i + n));
    }

    const ngramsB = new Set<string>();
    for (let i = 0; i <= b.length - n; i++) {
      ngramsB.add(b.slice(i, i + n));
    }

    let intersection = 0;
    for (const ng of ngramsA) {
      if (ngramsB.has(ng)) {
        intersection++;
      }
    }

    const union = ngramsA.size + ngramsB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}
