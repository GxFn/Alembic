import { normalizeMainlinePosixPath } from "../core/PathIdentity.js";
import type { Recipe, SourceRef } from "../data/ArtifactStores.js";
import type { ContextIndexSnapshot } from "../data/ContextIndex.js";
import type { MainlineSearchDocument } from "./SearchIndex.js";

export interface MainlineSearchProjectionInput {
  readonly recipes?: readonly Recipe[];
  readonly sourceRefs?: readonly SourceRef[];
  readonly snapshot?: ContextIndexSnapshot;
}

export function projectMainlineSearchDocuments(
  input: MainlineSearchProjectionInput,
): MainlineSearchDocument[] {
  const recipes = [...(input.snapshot?.recipes ?? []), ...(input.recipes ?? [])];
  const sourceRefs = [...(input.snapshot?.sourceRefs ?? []), ...(input.sourceRefs ?? [])];
  const documents = new Map<string, MainlineSearchDocument>();

  for (const recipe of recipes) {
    documents.set(`recipe:${recipe.id}`, projectRecipeSearchDocument(recipe));
  }
  for (const sourceRef of sourceRefs) {
    documents.set(`source-ref:${sourceRef.id}`, projectSourceRefSearchDocument(sourceRef));
  }

  // 投影阶段只消费编译好的 snapshot / artifact，不访问 Markdown 文件系统。
  return [...documents.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function projectRecipeSearchDocument(recipe: Recipe): MainlineSearchDocument {
  const title = stringField(recipe, "title") || stringField(recipe, "name") || recipe.id;
  const body = [
    stringField(recipe, "summary"),
    stringField(recipe, "description"),
    stringField(recipe, "body"),
    stringField(recipe, "usageGuide"),
    stringField(recipe, "coreCode"),
  ]
    .filter(Boolean)
    .join("\n\n");
  const tags = arrayStringField(recipe, "tags");
  const primaryPath = stringField(recipe, "path") || firstString(recipe.sourceRefIds);

  return {
    id: `recipe:${recipe.id}`,
    kind: "recipe",
    title,
    ...(body ? { body } : {}),
    ...(primaryPath ? { path: normalizeMainlinePosixPath(primaryPath) } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    metadata: {
      recipeId: recipe.id,
      sourceRefIds: [...recipe.sourceRefIds],
      ...(stringField(recipe, "trigger") ? { trigger: stringField(recipe, "trigger") } : {}),
      ...(stringField(recipe, "kind") ? { knowledgeType: stringField(recipe, "kind") } : {}),
    },
  };
}

export function projectSourceRefSearchDocument(sourceRef: SourceRef): MainlineSearchDocument {
  const normalizedPath = normalizeMainlinePosixPath(sourceRef.location.path);
  return {
    id: `source-ref:${sourceRef.id}`,
    kind: "source-ref",
    title: sourceRef.id,
    path: normalizedPath,
    metadata: {
      sourceRefId: sourceRef.id,
      path: normalizedPath,
      ...(sourceRef.metadata ?? {}),
    },
  };
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function arrayStringField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function firstString(values: readonly string[]): string {
  return values.find((value) => value.trim().length > 0) ?? "";
}
