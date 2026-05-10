import type { ContextIndexReader } from "../data/index.js";
import type { ActiveWorkContext, Recipe, RecipeEdge, SourceRef } from "../knowledge/index.js";
import type { MainlineSearchHit, MainlineSearchIndex } from "../search/index.js";
import { MainlineQueryPlanner } from "./MainlineQueryPlanner.js";
import { type RuntimeRankedRecipe, RuntimeRecipeRanker } from "./RuntimeRecipeRanker.js";

export interface RuntimeRetrievalResult {
  readonly activeContext: ActiveWorkContext;
  readonly rankedRecipes: readonly RuntimeRankedRecipe[];
  readonly recipes: readonly Recipe[];
  readonly sourceRefs: readonly SourceRef[];
  readonly degradedSourceRefs: readonly SourceRef[];
  readonly edges: readonly RecipeEdge[];
  readonly searchHits: readonly MainlineSearchHit[];
  readonly hints: readonly RuntimeRetrievalHint[];
}

export type RuntimeRetrievalHintKind =
  | "no-search-results"
  | "empty-context-index"
  | "degraded-source-ref"
  | "missing-source-ref";

export interface RuntimeRetrievalHint {
  readonly kind: RuntimeRetrievalHintKind;
  readonly message: string;
  readonly recipeIds?: readonly string[];
  readonly sourceRefIds?: readonly string[];
}

interface ContextIndexLookupExtensions {
  findRecipesByIds?(recipeIds: readonly string[]): Promise<Recipe[]>;
  findSourceRefsByIds?(sourceRefIds: readonly string[]): Promise<SourceRef[]>;
  findRecipesBySourceRefIds?(sourceRefIds: readonly string[], limit?: number): Promise<Recipe[]>;
}

export interface RuntimeRetrievalPipelineOptions {
  readonly limit?: number;
  readonly queryPlanner?: MainlineQueryPlanner;
  readonly ranker?: RuntimeRecipeRanker;
}

/**
 * RuntimeRetrievalPipeline 是 prime/Tool 的只读召回入口。
 * 它只读 ContextIndex 和 SearchIndex，不扫描 Markdown，不触发编译期任务。
 */
export class RuntimeRetrievalPipeline {
  readonly #contextIndex: ContextIndexReader;
  readonly #searchIndex: MainlineSearchIndex;
  readonly #queryPlanner: MainlineQueryPlanner;
  readonly #ranker: RuntimeRecipeRanker;
  readonly #limit: number;

  constructor(
    contextIndex: ContextIndexReader,
    searchIndex: MainlineSearchIndex,
    options: RuntimeRetrievalPipelineOptions = {},
  ) {
    this.#contextIndex = contextIndex;
    this.#searchIndex = searchIndex;
    this.#queryPlanner = options.queryPlanner ?? new MainlineQueryPlanner();
    this.#ranker = options.ranker ?? new RuntimeRecipeRanker();
    this.#limit = options.limit ?? 20;
  }

  async retrieve(activeContext: ActiveWorkContext): Promise<RuntimeRetrievalResult> {
    const queryPlan = this.#queryPlanner.plan(activeContext);
    const searchHits = mergeHits(
      queryPlan.variants.flatMap((variant) =>
        this.#searchIndex.search({
          ...(variant.text ? { text: variant.text } : {}),
          ...(variant.paths?.length ? { paths: variant.paths } : {}),
          ...(variant.symbols?.length ? { symbols: variant.symbols } : {}),
          limit: this.#limit,
        }),
      ),
    ).slice(0, this.#limit);
    const hints: RuntimeRetrievalHint[] = [];
    if (searchHits.length === 0) {
      hints.push({ kind: "no-search-results", message: "Runtime search returned no hits." });
    }

    const lookup = this.#contextIndex as ContextIndexReader & ContextIndexLookupExtensions;
    const recipeIds = idsFromHits(searchHits, "recipe:");
    const sourceRefIds = idsFromHits(searchHits, "source-ref:");
    const recipes = uniqueRecipes([
      ...(lookup.findRecipesByIds ? await lookup.findRecipesByIds(recipeIds) : []),
      ...(await this.#contextIndex.findRecipesByFiles(activeContext.files, this.#limit)),
      ...(lookup.findRecipesBySourceRefIds
        ? await lookup.findRecipesBySourceRefIds(sourceRefIds, this.#limit)
        : []),
    ]).slice(0, this.#limit);
    const resolvedSourceRefs = lookup.findSourceRefsByIds
      ? await lookup.findSourceRefsByIds(sourceRefIds)
      : [];
    const recipeIdsForLookup = recipes.map((recipe) => recipe.id);
    const [recipeSourceRefs, edges] =
      recipeIdsForLookup.length > 0
        ? await Promise.all([
            this.#contextIndex.findSourceRefs(recipeIdsForLookup),
            this.#contextIndex.findRecipeEdges(recipeIdsForLookup),
          ])
        : [[], []];
    const sourceRefs = uniqueSourceRefs([...resolvedSourceRefs, ...recipeSourceRefs]);
    const degradedSourceRefs = sourceRefs.filter(
      (sourceRef) => sourceRef.status !== "active" && sourceRef.status !== "renamed",
    );
    appendSourceRefHints(hints, recipes, sourceRefs, degradedSourceRefs);

    if (recipes.length === 0 && sourceRefs.length === 0) {
      hints.push({
        kind: "empty-context-index",
        message: "ContextIndex returned no runtime artifacts.",
      });
    }

    const rankedRecipes = this.#ranker.rank({ recipes, sourceRefs, searchHits, activeContext });
    return {
      activeContext,
      rankedRecipes,
      recipes: rankedRecipes.map((entry) => entry.recipe),
      sourceRefs,
      degradedSourceRefs,
      edges,
      searchHits,
      hints,
    };
  }
}

function mergeHits(hits: readonly MainlineSearchHit[]): MainlineSearchHit[] {
  return [...new Map(hits.map((hit) => [hit.document.id, hit])).values()].sort(
    (left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id),
  );
}

function idsFromHits(hits: readonly MainlineSearchHit[], prefix: string): string[] {
  return [
    ...new Set(
      hits
        .map((hit) => hit.document.id)
        .filter((id) => id.startsWith(prefix))
        .map((id) => id.slice(prefix.length)),
    ),
  ];
}

function uniqueRecipes(recipes: readonly Recipe[]): Recipe[] {
  return [...new Map(recipes.map((recipe) => [recipe.id, recipe])).values()];
}

function uniqueSourceRefs(sourceRefs: readonly SourceRef[]): SourceRef[] {
  return [...new Map(sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef])).values()];
}

function appendSourceRefHints(
  hints: RuntimeRetrievalHint[],
  recipes: readonly Recipe[],
  sourceRefs: readonly SourceRef[],
  degradedSourceRefs: readonly SourceRef[],
): void {
  const sourceRefIds = new Set(sourceRefs.map((sourceRef) => sourceRef.id));
  const missing = recipes.flatMap((recipe) =>
    recipe.sourceRefIds.filter((sourceRefId) => !sourceRefIds.has(sourceRefId)),
  );
  if (missing.length > 0) {
    hints.push({
      kind: "missing-source-ref",
      message: "Some Recipe SourceRefs were not resolved.",
      sourceRefIds: missing,
    });
  }
  if (degradedSourceRefs.length > 0) {
    hints.push({
      kind: "degraded-source-ref",
      message: "Some SourceRefs are stale, missing, renamed, or unknown and were only down-ranked.",
      sourceRefIds: degradedSourceRefs.map((sourceRef) => sourceRef.id),
    });
  }
}
