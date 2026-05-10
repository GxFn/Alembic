import {
  type ActiveWorkContext,
  isFreshSourceRef,
  type Recipe,
  type SourceRef,
} from "../knowledge/index.js";
import type { MainlineSearchHit } from "../search/index.js";

export interface RuntimeRankedRecipe {
  readonly recipe: Recipe;
  readonly score: number;
  readonly reasons: string[];
}

export interface RuntimeRecipeRankerInput {
  readonly recipes: readonly Recipe[];
  readonly sourceRefs: readonly SourceRef[];
  readonly searchHits: readonly MainlineSearchHit[];
  readonly activeContext: ActiveWorkContext;
}

/**
 * RuntimeRecipeRanker 在运行期做轻量排序。
 * stale SourceRef 只降权，不删除，避免 prime 结果因为索引暂时落后而完全丢失上下文。
 */
export class RuntimeRecipeRanker {
  rank(input: RuntimeRecipeRankerInput): RuntimeRankedRecipe[] {
    const sourceRefs = new Map(input.sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]));
    const searchScores = searchScoreByRecipe(input.searchHits);
    return input.recipes
      .map((recipe) =>
        rankRecipe(recipe, sourceRefs, searchScores.get(recipe.id) ?? 0, input.activeContext),
      )
      .sort(
        (left, right) => right.score - left.score || left.recipe.id.localeCompare(right.recipe.id),
      );
  }
}

function rankRecipe(
  recipe: Recipe,
  sourceRefs: ReadonlyMap<string, SourceRef>,
  searchScore: number,
  activeContext: ActiveWorkContext,
): RuntimeRankedRecipe {
  let score = recipe.confidence + searchScore;
  const reasons: string[] = [];
  const activeFiles = new Set(activeContext.files);
  for (const sourceRefId of recipe.sourceRefIds) {
    const sourceRef = sourceRefs.get(sourceRefId);
    if (!sourceRef) {
      continue;
    }
    if (activeFiles.has(sourceRef.location.path)) {
      score += 2;
      reasons.push("source-ref:file");
    }
    if (isFreshSourceRef(sourceRef)) {
      score += 0.5;
      reasons.push("source-ref:fresh");
    } else {
      score -= 0.75;
      reasons.push(`source-ref:${sourceRef.status}`);
    }
  }
  if (
    activeContext.symbols?.some(
      (symbol) => recipe.summary.includes(symbol) || recipe.title.includes(symbol),
    )
  ) {
    score += 1.5;
    reasons.push("symbol");
  }
  return { recipe, score, reasons: [...new Set(reasons)] };
}

function searchScoreByRecipe(hits: readonly MainlineSearchHit[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const hit of hits) {
    const recipeId = recipeIdFromDocument(hit.document.id, hit.document.metadata?.recipeId);
    if (recipeId) {
      scores.set(recipeId, Math.max(scores.get(recipeId) ?? 0, hit.score));
    }
  }
  return scores;
}

function recipeIdFromDocument(documentId: string, metadataRecipeId: unknown): string | undefined {
  if (typeof metadataRecipeId === "string") {
    return metadataRecipeId;
  }
  return documentId.startsWith("recipe:") ? documentId.slice("recipe:".length) : undefined;
}
