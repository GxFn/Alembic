import {
  createRecipeEdge,
  type Recipe,
  type RecipeEdge,
  type RecipeEdgeRelation,
} from "../knowledge/index.js";

export interface RecipeRelationMinerOptions {
  readonly minSharedSourceRefs?: number;
}

/**
 * RecipeRelationMiner 先迁移确定性关系挖掘。
 * 中文注释：LLM 关系候选后续由 AiTaskPlanner/AgentRuntime 产生；这里默认只做
 * declared relations 和 SourceRef overlap，避免编译期引入 provider 依赖。
 */
export class RecipeRelationMiner {
  readonly #minSharedSourceRefs: number;

  constructor(options: RecipeRelationMinerOptions = {}) {
    this.#minSharedSourceRefs = options.minSharedSourceRefs ?? 1;
  }

  mine(recipes: readonly Recipe[]): RecipeEdge[] {
    return uniqueEdges([
      ...this.mineDeclaredRelations(recipes),
      ...this.mineSourceRefOverlap(recipes),
    ]);
  }

  mineDeclaredRelations(recipes: readonly Recipe[]): RecipeEdge[] {
    const recipeByTarget = recipeTargetIndex(recipes);
    const edges: RecipeEdge[] = [];

    for (const recipe of recipes) {
      for (const entry of relationEntriesForRecipe(recipe)) {
        const relation = normalizeRelation(entry.bucket);
        const targetRecipe = recipeByTarget.get(normalizeTarget(entry.target));
        if (!relation || !targetRecipe || targetRecipe.id === recipe.id) {
          continue;
        }
        edges.push(
          createRecipeEdge({
            fromRecipeId: recipe.id,
            toRecipeId: targetRecipe.id,
            relation,
            weight: 1,
            evidenceSource: "manual",
            sourceRefIds: sharedValues(recipe.sourceRefIds, targetRecipe.sourceRefIds),
            metadata: {
              bucket: entry.bucket,
              target: entry.target,
              ...(entry.description ? { description: entry.description } : {}),
            },
          }),
        );
      }
    }

    return uniqueEdges(edges);
  }

  mineSourceRefOverlap(recipes: readonly Recipe[]): RecipeEdge[] {
    const edges: RecipeEdge[] = [];

    for (let leftIndex = 0; leftIndex < recipes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < recipes.length; rightIndex += 1) {
        const left = recipes[leftIndex];
        const right = recipes[rightIndex];
        if (!left || !right) {
          continue;
        }
        const sharedSourceRefs = sharedValues(left.sourceRefIds, right.sourceRefIds);

        if (sharedSourceRefs.length < this.#minSharedSourceRefs) {
          continue;
        }

        edges.push(
          createRecipeEdge({
            fromRecipeId: left.id,
            toRecipeId: right.id,
            relation: inferRelation(left, right),
            weight: Math.min(1, sharedSourceRefs.length / Math.max(left.sourceRefIds.length, 1)),
            evidenceSource: "source-ref-overlap",
            sourceRefIds: sharedSourceRefs,
          }),
        );
      }
    }

    return edges;
  }
}

interface DeclaredRelationEntry {
  readonly bucket: string;
  readonly target: string;
  readonly description?: string;
}

function sharedValues(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => rightSet.has(value)))];
}

function inferRelation(left: Recipe, right: Recipe): RecipeEdgeRelation {
  if (left.kind === "guard-rule" || right.kind === "guard-rule") {
    return "supports";
  }
  if (left.kind === "risk" || right.kind === "risk") {
    return "conflicts_with";
  }
  return "same_context";
}

function relationEntriesForRecipe(recipe: Recipe): DeclaredRelationEntry[] {
  return [
    ...relationEntriesFromBuckets(recipe.knowledge?.relations.buckets),
    ...relationEntriesFromUnknown(recipe.metadata?.relations),
    ...relationEntriesFromUnknown(recipe.metadata?.recipeRelations),
  ];
}

function relationEntriesFromBuckets(
  buckets:
    | Record<string, readonly { target: string; description?: string | undefined }[]>
    | undefined,
): DeclaredRelationEntry[] {
  if (!buckets) {
    return [];
  }
  return Object.entries(buckets).flatMap(([bucket, entries]) =>
    entries.flatMap((entry) =>
      entry.target
        ? [
            {
              bucket,
              target: entry.target,
              ...(entry.description ? { description: entry.description } : {}),
            },
          ]
        : [],
    ),
  );
}

function relationEntriesFromUnknown(value: unknown): DeclaredRelationEntry[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([bucket, rawEntries]) => {
    const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
    return entries.flatMap((entry) => {
      if (typeof entry === "string" && entry.trim()) {
        return [{ bucket, target: entry.trim() }];
      }
      if (!isRecord(entry)) {
        return [];
      }
      const target = stringValue(entry.target);
      if (!target) {
        return [];
      }
      return [
        {
          bucket,
          target,
          ...(stringValue(entry.description)
            ? { description: stringValue(entry.description) as string }
            : {}),
        },
      ];
    });
  });
}

function normalizeRelation(bucket: string): RecipeEdgeRelation | undefined {
  const normalized = bucket.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "requires" || normalized === "depends_on" || normalized === "depends") {
    return "requires";
  }
  if (normalized === "supports" || normalized === "supported_by" || normalized === "related") {
    return "supports";
  }
  if (normalized === "conflicts" || normalized === "conflicts_with") {
    return "conflicts_with";
  }
  if (normalized === "supersedes" || normalized === "replaces") {
    return "supersedes";
  }
  if (normalized === "refines" || normalized === "extends") {
    return "refines";
  }
  if (normalized === "same_context" || normalized === "cooccurs_with") {
    return "same_context";
  }
  if (normalized === "applies_to") {
    return "applies_to";
  }
  return undefined;
}

function recipeTargetIndex(recipes: readonly Recipe[]): Map<string, Recipe> {
  const index = new Map<string, Recipe>();
  for (const recipe of recipes) {
    index.set(normalizeTarget(recipe.id), recipe);
    index.set(normalizeTarget(recipe.title), recipe);
    if (recipe.trigger) {
      index.set(normalizeTarget(recipe.trigger), recipe);
    }
  }
  return index;
}

function normalizeTarget(target: string): string {
  return target.trim().replace(/^@/, "").toLowerCase();
}

function uniqueEdges(edges: readonly RecipeEdge[]): RecipeEdge[] {
  return [...new Map(edges.map((edge) => [edge.id, edge])).values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
