/**
 * PrimeSearchPipeline — Enrichment Layer
 *
 * Multi-query parallel search + scenario routing + session history accumulation.
 * Replaces TaskKnowledgeBridge with full search pipeline integration.
 *
 * @module service/task/PrimeSearchPipeline
 */

import type { SearchResultItem, SlimSearchResult } from '#service/search/SearchTypes.js';
import { slimSearchResult } from '#service/search/SearchTypes.js';
import type { ExtractedIntent } from './IntentExtractor.js';

// ── Types ───────────────────────────────────────────

/** Slim search result (re-export for external use) */
export type { SlimSearchResult } from '#service/search/SearchTypes.js';

export interface PrimeSearchMeta {
  queries: string[];
  scenario: string;
  language: string | null;
  module: string | null;
  resultCount: number;
  filteredCount: number;
}

export interface PrimeSearchResult {
  relatedKnowledge: SlimSearchResult[];
  guardRules: SlimSearchResult[];
  searchMeta: PrimeSearchMeta;
}

/** Minimal SearchEngine shape — duck-typed for DI flexibility */
interface SearchEngineLike {
  search(
    query: string,
    options?: {
      mode?: string;
      limit?: number;
      rank?: boolean;
      context?: {
        sessionHistory?: Array<{ content?: string }>;
        language?: string;
        intent?: string;
      };
    }
  ): Promise<{ items?: unknown[] }>;
}

// ── Constants ───────────────────────────────────────

/** Absolute minimum score — items below this are definitely noise */
const MIN_SCORE_THRESHOLD = 0.3;
/** Relative threshold — items scoring below this fraction of the best result are dropped */
const RELATIVE_SCORE_RATIO = 0.15;
/** Gap ratio — if score drops by more than this factor from the previous item, truncate */
const GAP_DROP_RATIO = 0.25;

// ── PrimeSearchPipeline ─────────────────────────────

export class PrimeSearchPipeline {
  #search: SearchEngineLike;
  #sessionQueries: string[] = [];

  constructor(searchEngine: SearchEngineLike) {
    this.#search = searchEngine;
  }

  /**
   * Core method: multi-query search + scenario routing + result merging.
   */
  async search(intent: ExtractedIntent): Promise<PrimeSearchResult | null> {
    if (!intent.queries.length || !intent.queries[0]?.trim()) {
      return null;
    }

    // Build ranking context
    const context = {
      language: intent.language ?? undefined,
      intent: intent.scenario,
      sessionHistory: this.#buildSessionHistory(),
    };

    // Multi-query parallel search (auto mode + keyword mode for cross-language)
    const allResults = await this.#multiQuerySearch(
      intent.queries,
      intent.keywordQueries ?? [],
      context
    );

    // Quality filter: absolute threshold + relative-to-best + score gap detection
    const filtered = this.#qualityFilter(allResults);

    if (filtered.length === 0) {
      return null;
    }

    // Classify: knowledge vs rules
    const knowledge = filtered.filter((r) => r.kind !== 'rule').slice(0, 5);
    const rules = filtered.filter((r) => r.kind === 'rule').slice(0, 3);

    // Record search to session history
    this.#sessionQueries.push(intent.raw.userQuery);

    return {
      relatedKnowledge: knowledge,
      guardRules: rules,
      searchMeta: {
        queries: intent.queries,
        scenario: intent.scenario,
        language: intent.language,
        module: intent.module,
        resultCount: allResults.length,
        filteredCount: filtered.length,
      },
    };
  }

  /**
   * Reset session history (called on new session start).
   */
  resetSession(): void {
    this.#sessionQueries = [];
  }

  // ── Private ───────────────────────────────────────

  /**
   * Quality filter: absolute threshold + relative-to-best + score gap detection.
   * Expects items sorted by score descending.
   */
  #qualityFilter(items: SlimSearchResult[]): SlimSearchResult[] {
    if (items.length === 0) {
      return [];
    }
    const maxScore = items[0]?.score ?? 0;
    const effectiveThreshold = Math.max(MIN_SCORE_THRESHOLD, maxScore * RELATIVE_SCORE_RATIO);

    const result: SlimSearchResult[] = [];
    let prevScore = maxScore;
    for (const item of items) {
      const score = item.score;
      if (score < effectiveThreshold) {
        break;
      }
      // Gap detection: if score drops sharply from previous item, stop
      if (result.length > 0 && score < prevScore * GAP_DROP_RATIO) {
        break;
      }
      result.push(item);
      prevScore = score;
    }
    return result;
  }

  /**
   * Multi-query parallel search with optional Reciprocal Rank Fusion (RRF).
   *
   * Single-query: preserves original search engine scores (BM25/CoarseRanker).
   * Multi-query: uses RRF to fuse results, but weights by original score to
   * retain magnitude information.
   */
  async #multiQuerySearch(
    autoQueries: string[],
    keywordQueries: string[],
    context: { language?: string; intent?: string; sessionHistory?: Array<{ content: string }> }
  ): Promise<SlimSearchResult[]> {
    // Auto-mode searches (BM25 without CoarseRanker ranking)
    // Using rank: false preserves raw BM25/FWS score magnitude,
    // which the quality filter needs for effective discrimination.
    // CoarseRanker's max-normalization + freshness/popularity signals
    // would cluster scores around 0.35–0.41, defeating the filter.
    const autoPromises = autoQueries.map((q) =>
      this.#search
        .search(q, { mode: 'auto', limit: 8, rank: false, context })
        .catch(() => ({ items: [] }))
    );

    // Keyword-mode searches (raw FWS scores — for cross-language synonym matching)
    const kwPromises = keywordQueries.map((q) =>
      this.#search
        .search(q, { mode: 'keyword', limit: 8, rank: false })
        .catch(() => ({ items: [] }))
    );

    const [autoResponses, kwResponses] = await Promise.all([
      Promise.all(autoPromises),
      Promise.all(kwPromises),
    ]);

    const allResponses = [...autoResponses, ...kwResponses];

    // Single-query shortcut: preserve original scores from search engine.
    // RRF is pointless with one response — it just converts rank to score,
    // discarding the magnitude information from BM25/CoarseRanker.
    if (allResponses.length === 1) {
      const items = (allResponses[0]?.items || []) as SearchResultItem[];
      return items.map(slimSearchResult).sort((a, b) => b.score - a.score);
    }

    // Multi-query: Weighted RRF — RRF(d) = Σ origScore / (k + rank)
    // Retains original score magnitude while still boosting cross-query overlap.
    const RRF_K = 60;
    const rrfScores = new Map<string, number>();
    const itemById = new Map<string, SlimSearchResult>();

    for (const resp of allResponses) {
      const items = (resp.items || []) as SearchResultItem[];
      for (let rank = 0; rank < items.length; rank++) {
        const raw = items[rank] as SearchResultItem;
        const origScore = Math.max((raw.score as number) || 0, 0.01);
        const item = slimSearchResult(raw);
        rrfScores.set(item.id, (rrfScores.get(item.id) ?? 0) + origScore / (RRF_K + rank));
        // Keep the richest metadata version
        if (!itemById.has(item.id)) {
          itemById.set(item.id, item);
        }
      }
    }

    // Assign fused scores and sort
    // Rescale: RRF_K division crushes scores to ~0.003–0.02 range,
    // which falls below qualityFilter's MIN_SCORE_THRESHOLD (0.1).
    // Multiply by RRF_K to restore original score magnitude.
    // Effective formula: Σ origScore / (1 + rank/K), preserving magnitude
    // while still giving a gentle rank-based discount.
    const results: SlimSearchResult[] = [];
    for (const [id, rrfScore] of rrfScores) {
      const item = itemById.get(id);
      if (!item) {
        continue;
      }
      item.score = Math.round(rrfScore * RRF_K * 1000) / 1000;
      results.push(item);
    }
    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Build sessionHistory for contextBoost (last 5 queries).
   */
  #buildSessionHistory(): Array<{ content: string }> {
    return this.#sessionQueries.slice(-5).map((q) => ({ content: q }));
  }
}
