import { epochSecondsNow } from "../core/index.js";
import type {
  BundleAction,
  BundleRisk,
  CapturePrompt,
  ContextBundle,
  Recipe,
  RecipeEdge,
} from "../knowledge/index.js";
import { GraphExpansion } from "./GraphExpansion.js";
import type { RuntimeRetrievalResult } from "./RuntimeRetrievalPipeline.js";

export interface ContextBundleBuilderOptions {
  readonly graphExpansion?: GraphExpansion | undefined;
  readonly recipeResolver?:
    | ((recipeIds: readonly string[]) => Promise<readonly Recipe[]>)
    | undefined;
  readonly maxGraphNeighbors?: number | undefined;
}

/**
 * ContextBundleBuilder 把检索结果整理成运行期 bundle。
 * bundle 是给 Codex/Guard/Tools 的小型结构化上下文，不是 Wiki 页面。
 */
export class ContextBundleBuilder {
  readonly #graphExpansion: GraphExpansion;
  readonly #recipeResolver:
    | ((recipeIds: readonly string[]) => Promise<readonly Recipe[]>)
    | undefined;
  readonly #maxGraphNeighbors: number;

  constructor(options: ContextBundleBuilderOptions = {}) {
    this.#graphExpansion = options.graphExpansion ?? new GraphExpansion();
    this.#recipeResolver = options.recipeResolver;
    this.#maxGraphNeighbors = options.maxGraphNeighbors ?? 8;
  }

  async build(result: RuntimeRetrievalResult): Promise<ContextBundle> {
    const seedRecipeIds = result.recipes.map((recipe) => recipe.id);
    const graph = this.#graphExpansion.expand(seedRecipeIds, result.edges, {
      maxNeighbors: this.#maxGraphNeighbors,
    });
    const recipes = await this.#resolveExpandedRecipes(result.recipes, graph.expandedRecipeIds);
    const recipeIds = recipes.map((recipe) => recipe.id);
    const riskEdges = graph.riskEdges;
    return {
      id: `bundle:${epochSecondsNow()}`,
      activeContext: result.activeContext,
      recipes,
      edges: [...result.edges],
      sourceRefs: [...result.sourceRefs],
      guardFindings: [],
      risks: [...risksFromHints(result), ...risksFromEdges(riskEdges)],
      suggestedActions: actionsFromRecipes(recipeIds),
      capturePrompts: capturePromptsFromContext(result),
      createdAt: epochSecondsNow(),
      metadata: {
        runtimeRetrieval: {
          hints: result.hints,
          searchHits: result.searchHits.map((hit) => ({ id: hit.document.id, score: hit.score })),
          degradedSourceRefIds: result.degradedSourceRefs.map((sourceRef) => sourceRef.id),
          graphExpansion: {
            expandedRecipeIds: [...graph.expandedRecipeIds],
            expansionEdgeIds: graph.expansionEdges.map((edge) => edge.id),
            riskEdgeIds: riskEdges.map((edge) => edge.id),
          },
        },
      },
    };
  }

  async #resolveExpandedRecipes(
    recipes: readonly Recipe[],
    expandedRecipeIds: readonly string[],
  ): Promise<Recipe[]> {
    const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    const missingRecipeIds = expandedRecipeIds.filter((recipeId) => !byId.has(recipeId));
    if (missingRecipeIds.length > 0 && this.#recipeResolver) {
      for (const recipe of await this.#recipeResolver(missingRecipeIds)) {
        byId.set(recipe.id, recipe);
      }
    }
    return [
      ...recipes,
      ...expandedRecipeIds.flatMap((recipeId) => {
        const recipe = byId.get(recipeId);
        return recipe && !recipes.some((entry) => entry.id === recipe.id) ? [recipe] : [];
      }),
    ];
  }
}

function risksFromHints(result: RuntimeRetrievalResult): BundleRisk[] {
  return result.hints
    .filter((hint) => hint.kind === "degraded-source-ref" || hint.kind === "missing-source-ref")
    .map((hint, index) => ({
      id: `runtime-risk:${index + 1}`,
      message: hint.message,
      severity: "warning",
      recipeIds: [...(hint.recipeIds ?? [])],
    }));
}

function risksFromEdges(edges: readonly RecipeEdge[]): BundleRisk[] {
  return edges.map((edge, index) => ({
    id: `graph-risk:${index + 1}:${edge.id}`,
    message: `Recipe graph risk: ${edge.fromRecipeId} ${edge.relation} ${edge.toRecipeId}.`,
    severity: edge.relation === "conflicts_with" ? "error" : "warning",
    recipeIds: [edge.fromRecipeId, edge.toRecipeId],
  }));
}

function actionsFromRecipes(recipeIds: readonly string[]): BundleAction[] {
  return recipeIds.length > 0
    ? [
        {
          id: "review-runtime-recipes",
          label: "Review recalled Recipes",
          kind: "read",
          recipeIds: [...recipeIds],
        },
      ]
    : [];
}

function capturePromptsFromContext(result: RuntimeRetrievalResult): CapturePrompt[] {
  return result.recipes.length === 0 && result.activeContext.taskText
    ? [
        {
          id: "capture-empty-prime",
          prompt:
            "No Recipe matched this work context. Capture the missing project convention if it repeats.",
          sourceRefIds: [],
        },
      ]
    : [];
}
