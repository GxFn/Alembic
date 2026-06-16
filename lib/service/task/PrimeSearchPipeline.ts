/**
 * PrimeSearchPipeline — Enrichment Layer
 *
 * Multi-query parallel search + scenario routing + session history accumulation.
 * Replaces TaskKnowledgeBridge with full search pipeline integration.
 *
 * @module service/task/PrimeSearchPipeline
 */

import type { SearchResultItem, SlimSearchResult } from '@alembic/core/search';
import { slimSearchResult } from '@alembic/core/search';
import {
  parseRecipeIdFromRegionVectorId,
  RECIPE_SEMANTIC_REGION_METADATA_TYPE,
  type RecipeSemanticRegionClass,
} from '@alembic/core/vector';
import type { HostIntentContextMeta } from './HostIntentContext.js';
import { buildIntentEvidence, type IntentEvidence } from './IntentEvidence.js';
import type { ExtractedIntent } from './IntentExtractor.js';
import {
  applyIntentSearchPlanToExtractedIntent,
  type IntentSearchPlan,
  summarizeIntentSearchPlan,
} from './IntentSearchPlan.js';
import {
  buildPrimeInjectionPackage,
  type PrimeInjectionPackage,
  type PrimeMatchedRegionEvidence,
  type PrimeResidentRegionRecipeEvidence,
  type PrimeResidentRegionRetrieval,
} from './PrimeInjectionPackage.js';

// ── Types ───────────────────────────────────────────

/** Slim search result (re-export for external use) */
export type { SlimSearchResult } from '@alembic/core/search';

export interface PrimeSearchMeta {
  queries: string[];
  scenario: string;
  language: string | null;
  module: string | null;
  resultCount: number;
  filteredCount: number;
  hostIntentApplied?: boolean;
  hostIntentConfidence?: number;
  hostIntentDegraded?: boolean;
  hostIntentDegradedReason?: string;
  hostIntentSourceRefs?: string[];
  intentEvidence?: IntentEvidence;
  intentSearchPlan?: IntentSearchPlan;
  primeInjectionPackage?: PrimeInjectionPackage;
  residentRegionRetrieval?: PrimeResidentRegionRetrieval;
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

interface VectorServiceLike {
  getStats?: () => Promise<{ count?: number; embedProviderAvailable?: boolean }>;
  search: (
    query: string,
    opts?: { filter?: Record<string, unknown> | null; minScore?: number; topK?: number }
  ) => Promise<Array<{ item: Record<string, unknown>; score: number }>>;
  syncRecipeSemanticRegions?: unknown;
}

export interface PrimeSearchOptions {
  hostIntent?: HostIntentContextMeta | null;
  intentSearchPlan?: IntentSearchPlan | null;
  sessionHistory?: Array<{ content?: string }>;
}

export interface PrimeSearchPipelineOptions {
  vectorService?: VectorServiceLike | null;
}

type PrimeSearchItem = SlimSearchResult & {
  metadata?: Record<string, unknown>;
  semanticScore?: number;
  vectorScore?: number;
};

interface RegionQuery {
  query: string;
  regionClass: RecipeSemanticRegionClass;
}

interface RegionHit {
  dimensionId?: string;
  kind: string;
  knowledgeType?: string;
  language: string;
  matchedRegion: PrimeMatchedRegionEvidence;
  recipeId: string;
  score: number;
  sourceRefs: string[];
  tags: string[];
  title: string;
  trigger: string;
}

interface ResidentRegionSearchResult {
  items: PrimeSearchItem[];
  meta: PrimeResidentRegionRetrieval;
  rawHitCount: number;
}

// ── Constants ───────────────────────────────────────

/** Absolute minimum score — items below this are definitely noise */
const MIN_SCORE_THRESHOLD = 0.3;
/** Relative threshold — items scoring below this fraction of the best result are dropped */
const RELATIVE_SCORE_RATIO = 0.15;
/** Gap ratio — if score drops by more than this factor from the previous item, truncate */
const GAP_DROP_RATIO = 0.25;
const REGION_SEARCH_TOP_K = 6;
const REGION_SEARCH_MIN_SCORE = 0.2;
const PRIME_REGION_CLASSES: RecipeSemanticRegionClass[] = [
  'identity',
  'applicability',
  'patternPurpose',
  'architectureConvention',
  'integrationBoundary',
  'qualityConcern',
  'negativeBoundary',
];

// ── PrimeSearchPipeline ─────────────────────────────

export class PrimeSearchPipeline {
  #search: SearchEngineLike;
  #vectorService: VectorServiceLike | null;
  #sessionQueries: string[] = [];

  constructor(searchEngine: SearchEngineLike, options: PrimeSearchPipelineOptions = {}) {
    this.#search = searchEngine;
    this.#vectorService = options.vectorService ?? null;
  }

  /**
   * Core method: multi-query search + scenario routing + result merging.
   */
  async search(
    intent: ExtractedIntent,
    options: PrimeSearchOptions = {}
  ): Promise<PrimeSearchResult | null> {
    const plannedIntent = applyIntentSearchPlanToExtractedIntent(intent, options.intentSearchPlan);
    if (!plannedIntent.queries.length || !plannedIntent.queries[0]?.trim()) {
      return null;
    }

    const residentRegionResult = await this.#residentRegionSearch(
      plannedIntent,
      options.intentSearchPlan
    );
    const residentRegionUsed = residentRegionResult.items.length > 0;

    // Build ranking context
    const context = {
      language: plannedIntent.language ?? undefined,
      intent: options.hostIntent?.searchIntent ?? plannedIntent.scenario,
      sessionHistory: this.#buildSessionHistory(options.sessionHistory),
    };

    const allResults = residentRegionUsed
      ? residentRegionResult.items
      : await this.#multiQuerySearch(
          plannedIntent.queries,
          plannedIntent.keywordQueries ?? [],
          context
        );

    // Quality filter: absolute threshold + relative-to-best + score gap detection
    const filtered = residentRegionUsed
      ? residentRegionResult.items
      : this.#qualityFilter(allResults);

    // Classify: knowledge vs rules. Region-vector misses still return structured degraded
    // metadata so callers can distinguish empty region index from ordinary "no match".
    const knowledge = filtered.filter((r) => r.kind !== 'rule').slice(0, 5);
    const rules = filtered.filter((r) => r.kind === 'rule').slice(0, 3);
    const intentEvidence = await buildIntentEvidence({
      actualMode: 'prime',
      intentSearchPlan: options.intentSearchPlan,
      items: filtered,
      requestedMode: 'prime',
      semanticUsed: residentRegionUsed,
      vectorAvailable: residentRegionResult.meta.vectorAvailable,
      vectorUsed: residentRegionUsed,
    });
    const selectedItems = [...knowledge, ...rules];
    const primeInjectionPackage = buildPrimeInjectionPackage({
      hostIntent: options.hostIntent,
      intentEvidence,
      intentSearchPlan: options.intentSearchPlan,
      items: selectedItems,
      search: {
        actualMode: 'prime',
        filteredCount: filtered.length,
        query: plannedIntent.raw.userQuery,
        queries: plannedIntent.queries,
        requestedMode: 'prime',
        resultCount: residentRegionUsed ? residentRegionResult.rawHitCount : allResults.length,
      },
      residentRegionRetrieval: residentRegionResult.meta,
      semanticUsed: residentRegionUsed,
      vectorAvailable: residentRegionResult.meta.vectorAvailable,
      vectorUsed: residentRegionUsed,
    });

    // Record search to session history
    this.#sessionQueries.push(plannedIntent.raw.userQuery);

    return {
      relatedKnowledge: knowledge,
      guardRules: rules,
      searchMeta: {
        queries: plannedIntent.queries,
        scenario: plannedIntent.scenario,
        language: plannedIntent.language,
        module: plannedIntent.module,
        resultCount: residentRegionUsed ? residentRegionResult.rawHitCount : allResults.length,
        filteredCount: filtered.length,
        ...(options.intentSearchPlan
          ? { intentSearchPlan: summarizeIntentSearchPlan(options.intentSearchPlan) }
          : {}),
        intentEvidence,
        primeInjectionPackage,
        residentRegionRetrieval: residentRegionResult.meta,
        ...(options.hostIntent
          ? {
              hostIntentApplied: true,
              hostIntentConfidence: options.hostIntent.confidence,
              hostIntentDegraded: options.hostIntent.degraded,
              hostIntentDegradedReason: options.hostIntent.degradedReason,
              hostIntentSourceRefs: options.hostIntent.sourceRefs,
            }
          : {}),
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

  async #residentRegionSearch(
    intent: ExtractedIntent,
    plan: IntentSearchPlan | null | undefined
  ): Promise<ResidentRegionSearchResult> {
    const queries = this.#buildRegionQueries(intent, plan);
    const degradedReasons: string[] = [];
    const baseMeta = (): PrimeResidentRegionRetrieval => ({
      attempted: true,
      degradedReasons: uniqueStrings(degradedReasons),
      metadataOnlyFallback: {
        attempted: false,
        reason: 'not-supported-by-resident-vector-service',
        used: false,
      },
      queryCount: queries.length,
      regionHitCount: 0,
      route: 'resident-vector-recipe-semantic-region',
      selectedRecipes: [],
      used: false,
      vectorAvailable: false,
      wholeEntryOnlyRejectedCount: 0,
    });

    if (!this.#vectorService?.search) {
      degradedReasons.push('resident-vector:unavailable');
      degradedReasons.push('resident-region:metadata-only-fallback-unavailable');
      return { items: [], meta: baseMeta(), rawHitCount: 0 };
    }

    const stats = await this.#readVectorStats(degradedReasons);
    const vectorAvailable = stats?.embedProviderAvailable !== false;
    if (!vectorAvailable) {
      degradedReasons.push('resident-vector:unavailable');
      degradedReasons.push('resident-region:metadata-only-fallback-unavailable');
      return {
        items: [],
        meta: { ...baseMeta(), vectorAvailable },
        rawHitCount: 0,
      };
    }
    if (typeof stats?.count === 'number' && stats.count === 0) {
      degradedReasons.push('resident-region-index:empty');
    }

    const hits: RegionHit[] = [];
    let rawHitCount = 0;
    let wholeEntryOnlyRejectedCount = 0;

    for (const regionQuery of queries) {
      const response = await this.#safeRegionVectorSearch(regionQuery, degradedReasons);
      rawHitCount += response.length;
      for (const rawHit of response) {
        const normalized = this.#normalizeRegionHit(rawHit, regionQuery.regionClass);
        if (!normalized.hit) {
          if (normalized.rejectedAsWholeEntry) {
            wholeEntryOnlyRejectedCount++;
          }
          continue;
        }
        hits.push(normalized.hit);
      }
    }

    if (hits.length === 0 && rawHitCount > 0 && wholeEntryOnlyRejectedCount === rawHitCount) {
      degradedReasons.push('resident-region:whole-entry-only-rejected');
    }
    if (hits.length === 0 && !degradedReasons.includes('resident-region-index:empty')) {
      degradedReasons.push('resident-region:no-region-hits');
    }

    const selectedRecipes = this.#mergeRegionHits(hits);
    const items = selectedRecipes.map((recipe) => this.#regionRecipeToSearchItem(recipe));
    return {
      items,
      meta: {
        ...baseMeta(),
        degradedReasons: uniqueStrings(degradedReasons),
        regionHitCount: hits.length,
        selectedRecipes,
        used: items.length > 0,
        vectorAvailable,
        wholeEntryOnlyRejectedCount,
      },
      rawHitCount,
    };
  }

  async #readVectorStats(degradedReasons: string[]) {
    if (!this.#vectorService?.getStats) {
      return null;
    }
    try {
      return await this.#vectorService.getStats();
    } catch (err: unknown) {
      degradedReasons.push(
        `resident-region-index:unavailable:${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  async #safeRegionVectorSearch(
    regionQuery: RegionQuery,
    degradedReasons: string[]
  ): Promise<Array<{ item: Record<string, unknown>; score: number }>> {
    const vectorService = this.#vectorService;
    if (!vectorService) {
      return [];
    }
    try {
      return await vectorService.search(regionQuery.query, {
        topK: REGION_SEARCH_TOP_K,
        minScore: REGION_SEARCH_MIN_SCORE,
        filter: {
          deprecated: false,
          regionClass: regionQuery.regionClass,
          type: RECIPE_SEMANTIC_REGION_METADATA_TYPE,
        },
      });
    } catch (err: unknown) {
      degradedReasons.push(
        `resident-region-search-failed:${regionQuery.regionClass}:${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return [];
    }
  }

  #normalizeRegionHit(
    rawHit: { item: Record<string, unknown>; score: number },
    expectedRegionClass: RecipeSemanticRegionClass
  ): { hit: RegionHit | null; rejectedAsWholeEntry: boolean } {
    const item = rawHit.item ?? {};
    const metadata = asRecord(item.metadata);
    const vectorId = stringValue(item.id);
    const metadataType = stringValue(metadata?.type);
    const isWholeEntry =
      vectorId?.startsWith('entry_') === true ||
      metadataType !== RECIPE_SEMANTIC_REGION_METADATA_TYPE;
    if (isWholeEntry) {
      return { hit: null, rejectedAsWholeEntry: true };
    }
    const recipeId =
      stringValue(metadata?.recipeId) ??
      (vectorId ? parseRecipeIdFromRegionVectorId(vectorId) : null);
    const regionClass = stringValue(metadata?.regionClass) as RecipeSemanticRegionClass | undefined;
    if (!recipeId || !regionClass) {
      return { hit: null, rejectedAsWholeEntry: false };
    }
    const score = roundScore(rawHit.score);
    const sourceRefs = stringsFrom(metadata?.sourceRefs).slice(0, 8);
    return {
      hit: {
        dimensionId: stringValue(metadata?.dimensionId),
        kind: stringValue(metadata?.kind) ?? 'pattern',
        knowledgeType: stringValue(metadata?.knowledgeType),
        language: stringValue(metadata?.language) ?? '',
        matchedRegion: {
          regionClass,
          score,
          snippet: stringValue(item.content)?.slice(0, 360) ?? '',
          sourceRefs,
          ...(stringValue(metadata?.sourceRefsBridge)
            ? { sourceRefsBridge: stringValue(metadata?.sourceRefsBridge) }
            : {}),
          vectorId: vectorId ?? `${recipeId}:${expectedRegionClass}`,
        },
        recipeId,
        score,
        sourceRefs,
        tags: stringsFrom(metadata?.tags),
        title: stringValue(metadata?.title) ?? '',
        trigger: stringValue(metadata?.trigger) ?? '',
      },
      rejectedAsWholeEntry: false,
    };
  }

  #mergeRegionHits(hits: RegionHit[]): PrimeResidentRegionRecipeEvidence[] {
    const byRecipe = new Map<string, RegionHit[]>();
    for (const hit of hits) {
      byRecipe.set(hit.recipeId, [...(byRecipe.get(hit.recipeId) ?? []), hit]);
    }

    return [...byRecipe.entries()]
      .flatMap(([recipeId, recipeHits]) => {
        const sortedHits = recipeHits.sort((a, b) => b.score - a.score);
        const best = sortedHits[0];
        if (!best) {
          return [];
        }
        const matchedRegions = this.#dedupeMatchedRegions(
          sortedHits.map((hit) => hit.matchedRegion)
        );
        const score = roundScore(
          Math.min(1, best.score + Math.max(0, matchedRegions.length - 1) * 0.05)
        );
        return [
          {
            matchedRegionClasses: uniqueStrings(
              matchedRegions.map((region) => region.regionClass)
            ) as RecipeSemanticRegionClass[],
            matchedRegions,
            recipeId,
            score,
            sourceRefs: uniqueStrings(recipeHits.flatMap((hit) => hit.sourceRefs)).slice(0, 12),
            ...(best.title ? { title: best.title } : {}),
            ...(best.trigger ? { trigger: best.trigger } : {}),
          },
        ];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  #dedupeMatchedRegions(regions: PrimeMatchedRegionEvidence[]): PrimeMatchedRegionEvidence[] {
    const byClass = new Map<RecipeSemanticRegionClass, PrimeMatchedRegionEvidence>();
    for (const region of regions) {
      const existing = byClass.get(region.regionClass);
      if (!existing || region.score > existing.score) {
        byClass.set(region.regionClass, region);
      }
    }
    return [...byClass.values()].sort((a, b) => b.score - a.score).slice(0, 6);
  }

  #regionRecipeToSearchItem(recipe: PrimeResidentRegionRecipeEvidence): PrimeSearchItem {
    const bestRegion = recipe.matchedRegions[0];
    return {
      description: bestRegion?.snippet ?? '',
      id: recipe.recipeId,
      kind: 'pattern',
      language: '',
      metadata: {
        admissionRoute: 'recipe-semantic-region',
        residentRegionEvidence: recipe,
      },
      score: recipe.score,
      semanticScore: recipe.score,
      sourceRefs: recipe.sourceRefs,
      title: recipe.title ?? '',
      trigger: recipe.trigger ?? '',
      vectorScore: recipe.score,
    };
  }

  #buildRegionQueries(
    intent: ExtractedIntent,
    plan: IntentSearchPlan | null | undefined
  ): RegionQuery[] {
    const baseQuery = trimQuery(
      uniqueStrings([
        plan?.applied ? plan.executableQuery : undefined,
        ...intent.queries.slice(0, 3),
        intent.raw.userQuery,
      ]).join(' ')
    );
    if (!baseQuery) {
      return [];
    }
    const byClass: Record<RecipeSemanticRegionClass, string> = {
      identity: `${baseQuery} title trigger dimension capability anchors`,
      applicability: `${baseQuery} requirement scenario applicability when applies`,
      patternPurpose: `${baseQuery} design pattern purpose problem solved implementation`,
      architectureConvention: `${baseQuery} architecture convention boundary ownership lifecycle responsibility route ordering state`,
      integrationBoundary: `${baseQuery} integration boundary API MCP CLI daemon plugin Core storage host agent resident service`,
      qualityConcern: `${baseQuery} quality concern safety concurrency performance observability testing compatibility resilience validation`,
      negativeBoundary: `${baseQuery} negative boundary do not avoid constraints false positive prohibited`,
      evidence: `${baseQuery} evidence source refs validation anchors`,
      rationale: `${baseQuery} rationale why standard architecture explanation`,
    };
    return PRIME_REGION_CLASSES.map((regionClass) => ({
      query: trimQuery(byClass[regionClass]).slice(0, 420),
      regionClass,
    })).filter((item) => item.query.length > 0);
  }

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

    // Semantic-mode search for primary query — ensures semantic is always
    // part of RRF fusion even when auto mode skips it (confidence ≥ 60)
    const semanticPromise = autoQueries[0]
      ? this.#search
          .search(autoQueries[0], { mode: 'semantic', limit: 6, rank: false })
          .catch(() => ({ items: [] }))
      : Promise.resolve({ items: [] });

    // Keyword-mode searches (raw FWS scores — for cross-language synonym matching)
    const kwPromises = keywordQueries.map((q) =>
      this.#search
        .search(q, { mode: 'keyword', limit: 8, rank: false })
        .catch(() => ({ items: [] }))
    );

    const [autoResponses, kwResponses, semanticResponse] = await Promise.all([
      Promise.all(autoPromises),
      Promise.all(kwPromises),
      semanticPromise,
    ]);

    // Merge: auto + semantic + keyword
    const semanticItems = ((semanticResponse as { items?: unknown[] }).items ||
      []) as SearchResultItem[];
    const allResponses = [
      ...autoResponses,
      ...(semanticItems.length > 0 ? [semanticResponse] : []),
      ...kwResponses,
    ];

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
  #buildSessionHistory(extra: Array<{ content?: string }> = []): Array<{ content: string }> {
    const extraHistory = extra
      .map((entry) => (typeof entry.content === 'string' ? entry.content.trim() : ''))
      .filter(Boolean)
      .map((content) => ({ content }));
    return [...extraHistory, ...this.#sessionQueries.slice(-5).map((q) => ({ content: q }))].slice(
      -8
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function roundScore(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stringsFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(stringsFrom);
  }
  const normalized = stringValue(value);
  return normalized ? [normalized] : [];
}

function trimQuery(value: string): string {
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = stringValue(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}
