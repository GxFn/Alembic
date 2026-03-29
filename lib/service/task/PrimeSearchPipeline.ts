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

const RELEVANCE_THRESHOLD = 0.44;

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

    // Multi-query parallel search
    const allResults = await this.#multiQuerySearch(intent.queries, context);

    // Threshold filter
    const filtered = allResults.filter((r) => (r.score ?? 0) >= RELEVANCE_THRESHOLD);

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
   * Multi-query parallel search + de-dup by ID (keep highest score).
   */
  async #multiQuerySearch(
    queries: string[],
    context: { language?: string; intent?: string; sessionHistory?: Array<{ content: string }> }
  ): Promise<SlimSearchResult[]> {
    const promises = queries.map((q) =>
      this.#search
        .search(q, {
          mode: 'auto',
          limit: 8,
          rank: true,
          context,
        })
        .catch(() => ({ items: [] }))
    );

    const responses = await Promise.all(promises);

    // Merge by ID, keep highest score
    const bestById = new Map<string, SlimSearchResult>();
    for (const resp of responses) {
      const items = resp.items || [];
      for (const raw of items) {
        const item = slimSearchResult(raw as SearchResultItem);
        const existing = bestById.get(item.id);
        if (!existing || item.score > existing.score) {
          bestById.set(item.id, item);
        }
      }
    }

    // Sort by score descending
    return [...bestById.values()].sort((a, b) => b.score - a.score);
  }

  /**
   * Build sessionHistory for contextBoost (last 5 queries).
   */
  #buildSessionHistory(): Array<{ content: string }> {
    return this.#sessionQueries.slice(-5).map((q) => ({ content: q }));
  }
}
