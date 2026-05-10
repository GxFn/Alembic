import { clampScore, requireNonEmptyString } from "./internal/assert.js";

/**
 * RecipeEdge 是 Alembic 过去缺少的一等图谱契约。
 * 运行期扩展、Guard 解释、编译期剪枝都应该通过这七种关系表达，
 * 而不是继续依赖临时 metadata 字符串。
 */
export type RecipeEdgeRelation =
  | "requires"
  | "supports"
  | "conflicts_with"
  | "supersedes"
  | "refines"
  | "same_context"
  | "applies_to";

export type RecipeEdgeSource =
  | "source-ref-overlap"
  | "code-entity-cooccurrence"
  | "guard-finding-cooccurrence"
  | "manual"
  | "llm-candidate"
  | "legacy";

export interface RecipeEdge {
  id: string;
  fromRecipeId: string;
  toRecipeId: string;
  relation: RecipeEdgeRelation;
  weight: number;
  evidenceSource: RecipeEdgeSource;
  sourceRefIds: string[];
  createdAt?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RecipeEdgeInput {
  id?: string | undefined;
  fromRecipeId: string;
  toRecipeId: string;
  relation: RecipeEdgeRelation;
  weight?: number | undefined;
  evidenceSource?: RecipeEdgeSource | undefined;
  sourceRefIds?: readonly string[] | undefined;
  createdAt?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** 生成确定性的 edge id，让关系挖掘可以安全 upsert。 */
export function createRecipeEdge(input: RecipeEdgeInput): RecipeEdge {
  const fromRecipeId = requireNonEmptyString(input.fromRecipeId, "recipeEdge.fromRecipeId");
  const toRecipeId = requireNonEmptyString(input.toRecipeId, "recipeEdge.toRecipeId");
  const relation = input.relation;

  return {
    id: input.id ?? recipeEdgeId(fromRecipeId, relation, toRecipeId),
    fromRecipeId,
    toRecipeId,
    relation,
    weight: clampScore(input.weight ?? 1),
    evidenceSource: input.evidenceSource ?? "legacy",
    sourceRefIds: [...new Set(input.sourceRefIds ?? [])],
    createdAt: input.createdAt,
    metadata: input.metadata,
  };
}

export function recipeEdgeId(
  fromRecipeId: string,
  relation: RecipeEdgeRelation,
  toRecipeId: string,
): string {
  return `${fromRecipeId}:${relation}:${toRecipeId}`;
}

/** 阻塞性关系会在运行期 ContextBundle 输出中转成风险提示。 */
export function isBlockingRelation(relation: RecipeEdgeRelation): boolean {
  return relation === "requires" || relation === "conflicts_with";
}
