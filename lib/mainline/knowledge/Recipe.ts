import { requireNonEmptyString, uniqueStrings } from "./internal/assert.js";
import type { RecipeKnowledgePayload } from "./RecipeKnowledgePayload.js";

/**
 * Recipe 是运行期 bundle 消费的稳定知识单元。
 * 它刻意避开 presentation、wiki 渲染、dashboard workflow 等旧支线字段。
 */
export type RecipeStatus = "candidate" | "active" | "stale" | "superseded" | "rejected";

export type RecipeKind = "convention" | "pattern" | "fact" | "risk" | "workflow" | "guard-rule";

export interface Recipe {
  id: string;
  title: string;
  kind: RecipeKind;
  status: RecipeStatus;
  summary: string;
  trigger?: string | undefined;
  dimensionIds: string[];
  tags: string[];
  sourceRefIds: string[];
  confidence: number;
  updatedAt?: number | undefined;
  knowledge?: RecipeKnowledgePayload | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RecipeInput {
  id: string;
  title: string;
  kind?: RecipeKind | undefined;
  status?: RecipeStatus | undefined;
  summary?: string | undefined;
  trigger?: string | undefined;
  dimensionIds?: readonly string[] | undefined;
  tags?: readonly string[] | undefined;
  sourceRefIds?: readonly string[] | undefined;
  confidence?: number | undefined;
  updatedAt?: number | undefined;
  knowledge?: RecipeKnowledgePayload | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** 在候选数据写入编译后的 context index 前做归一化。 */
export function createRecipe(input: RecipeInput): Recipe {
  return {
    id: requireNonEmptyString(input.id, "recipe.id"),
    title: requireNonEmptyString(input.title, "recipe.title"),
    kind: input.kind ?? "pattern",
    status: input.status ?? "candidate",
    summary: input.summary?.trim() ?? "",
    trigger: input.trigger?.trim(),
    dimensionIds: uniqueStrings(input.dimensionIds ?? []),
    tags: uniqueStrings(input.tags ?? []),
    sourceRefIds: uniqueStrings(input.sourceRefIds ?? []),
    confidence: input.confidence ?? 0,
    updatedAt: input.updatedAt,
    knowledge: input.knowledge,
    metadata: input.metadata,
  };
}

export function isUsableRecipe(recipe: Recipe): boolean {
  return recipe.status === "active" || recipe.status === "candidate";
}
