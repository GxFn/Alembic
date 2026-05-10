import type { RecipeEdge, RecipeEdgeRelation } from "../knowledge/index.js";

export interface GraphExpansionOptions {
  readonly maxNeighbors?: number | undefined;
}

export interface GraphExpansionResult {
  readonly expandedRecipeIds: readonly string[];
  readonly expansionEdges: readonly RecipeEdge[];
  readonly riskEdges: readonly RecipeEdge[];
}

const EXPAND_RELATIONS = new Set<RecipeEdgeRelation>(["requires", "same_context", "refines"]);
const RISK_RELATIONS = new Set<RecipeEdgeRelation>(["conflicts_with", "supersedes"]);
const RELATION_ORDER = new Map<RecipeEdgeRelation, number>([
  ["requires", 0],
  ["same_context", 1],
  ["refines", 2],
]);

/**
 * GraphExpansion 只消费 RecipeEdge artifact。
 * 中文注释：运行期图扩展不能读 Markdown，也不能从文件系统临时推断关系。
 */
export class GraphExpansion {
  expand(
    seedRecipeIds: readonly string[],
    edges: readonly RecipeEdge[],
    options: GraphExpansionOptions = {},
  ): GraphExpansionResult {
    const seedIds = new Set(seedRecipeIds);
    const maxNeighbors = Math.max(0, Math.floor(options.maxNeighbors ?? 8));
    const expansionEdges = edges
      .filter((edge) => EXPAND_RELATIONS.has(edge.relation))
      .filter((edge) => seedIds.has(edge.fromRecipeId) || seedIds.has(edge.toRecipeId))
      .sort(compareExpansionEdges);
    const riskEdges = edges
      .filter((edge) => RISK_RELATIONS.has(edge.relation))
      .filter((edge) => seedIds.has(edge.fromRecipeId) || seedIds.has(edge.toRecipeId))
      .sort((left, right) => left.id.localeCompare(right.id));
    const expandedRecipeIds: string[] = [];

    for (const edge of expansionEdges) {
      for (const recipeId of [edge.fromRecipeId, edge.toRecipeId]) {
        if (seedIds.has(recipeId) || expandedRecipeIds.includes(recipeId)) {
          continue;
        }
        expandedRecipeIds.push(recipeId);
        if (expandedRecipeIds.length >= maxNeighbors) {
          return { expandedRecipeIds, expansionEdges, riskEdges };
        }
      }
    }

    return { expandedRecipeIds, expansionEdges, riskEdges };
  }
}

function compareExpansionEdges(left: RecipeEdge, right: RecipeEdge): number {
  return (
    (RELATION_ORDER.get(left.relation) ?? 99) - (RELATION_ORDER.get(right.relation) ?? 99) ||
    right.weight - left.weight ||
    left.id.localeCompare(right.id)
  );
}
