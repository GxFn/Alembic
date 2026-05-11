import type { Recipe, RecipeInput } from "./Recipe.js";
import type { MainlineRecipeSimilarityMatch } from "./RecipeSimilarityPolicy.js";
import type {
  MainlineRecipeConsolidationAction,
  MainlineRecipeConsolidationRecipeRef,
  MainlineRecipeFieldMergeOperation,
  MainlineRecipeFieldMergeSuggestion,
  MainlineRecipeSubmissionDecision,
} from "./RecipeSubmissionPolicy.js";

export function buildConsolidationAction(input: {
  readonly decision: MainlineRecipeSubmissionDecision;
  readonly candidate: RecipeInput;
  readonly candidateFields: Record<string, unknown>;
  readonly similarRecipes: readonly MainlineRecipeSimilarityMatch[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}): MainlineRecipeConsolidationAction | undefined {
  if (input.decision !== "merge" && input.decision !== "reorganize") {
    return undefined;
  }
  const similarRecipes = input.similarRecipes.map(recipeRefFromMatch);
  const targetMatch = input.similarRecipes[0];
  return {
    action: input.decision,
    candidateRecipe: input.candidate,
    targetRecipe: targetMatch ? recipeRefFromMatch(targetMatch) : undefined,
    similarRecipes,
    fieldMergeSuggestions: buildFieldMergeSuggestions(input.candidateFields, targetMatch?.recipe),
    reviewReason: consolidationReviewReason(input),
    recommendedDisposition:
      input.decision === "merge" && input.errors.length === 0 && similarRecipes.length === 1
        ? "execute"
        : "review",
  };
}

function recipeRefFromMatch(
  match: MainlineRecipeSimilarityMatch,
): MainlineRecipeConsolidationRecipeRef {
  return {
    id: match.recipe.id,
    title: match.recipe.title,
    similarity: match.similarity,
  };
}

function consolidationReviewReason(input: {
  readonly decision: MainlineRecipeSubmissionDecision;
  readonly similarRecipes: readonly MainlineRecipeSimilarityMatch[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}): string {
  const topMatch = input.similarRecipes[0];
  const topReason = topMatch
    ? `${topMatch.recipe.title} similarity=${topMatch.similarity.toFixed(2)}`
    : "未找到可定位的目标 Recipe";
  const policyNotes = [...input.errors, ...input.warnings].filter(Boolean);
  return [
    input.decision === "merge"
      ? `候选 Recipe 应合并到相似知识: ${topReason}`
      : `候选 Recipe 与 ${input.similarRecipes.length} 条知识重叠，建议重组: ${topReason}`,
    ...policyNotes,
  ].join("；");
}

function buildFieldMergeSuggestions(
  candidateRecord: Record<string, unknown>,
  target: Recipe | undefined,
): MainlineRecipeFieldMergeSuggestion[] {
  const targetRecord = target ? recipeFields(target) : {};
  const suggestions: MainlineRecipeFieldMergeSuggestion[] = [];
  for (const field of MERGE_SUGGESTION_FIELDS) {
    const candidateValue = getNestedValue(candidateRecord, field);
    const targetValue = getNestedValue(targetRecord, field);
    const operation = fieldMergeOperation(field, candidateValue, targetValue);
    if (!operation) {
      continue;
    }
    suggestions.push({
      field,
      operation,
      candidateValue,
      targetValue,
      reason: fieldMergeReason(field, operation),
    });
  }
  return suggestions;
}

const MERGE_SUGGESTION_FIELDS = [
  "summary",
  "trigger",
  "doClause",
  "dontClause",
  "whenClause",
  "coreCode",
  "usageGuide",
  "content.markdown",
  "content.rationale",
  "content.pattern",
  "reasoning.whyStandard",
  "reasoning.sources",
  "headers",
] as const;

function fieldMergeOperation(
  field: string,
  candidateValue: unknown,
  targetValue: unknown,
): MainlineRecipeFieldMergeOperation | null {
  if (isMissingMergeValue(candidateValue)) {
    return null;
  }
  if (isMissingMergeValue(targetValue)) {
    return "replace";
  }
  if (sameMergeValue(candidateValue, targetValue)) {
    return "keep-target";
  }
  if (field === "reasoning.sources" || field === "headers") {
    return "append";
  }
  if (field === "content.markdown" || field === "content.rationale") {
    return "review";
  }
  if (field === "trigger" || field === "coreCode" || field === "content.pattern") {
    return "review";
  }
  return "replace";
}

function fieldMergeReason(field: string, operation: MainlineRecipeFieldMergeOperation): string {
  if (operation === "append") {
    return `${field} 可去重追加，保留双方证据。`;
  }
  if (operation === "replace") {
    return `${field} 候选值补足或更新目标字段。`;
  }
  if (operation === "keep-target") {
    return `${field} 与目标一致，保持目标字段即可。`;
  }
  return `${field} 会影响 Recipe 语义或召回，应交给 review 决定。`;
}

function isMissingMergeValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

function sameMergeValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function recipeFields(recipe: Recipe): Record<string, unknown> {
  const knowledge = recipe.knowledge;
  return {
    title: recipe.title,
    summary: recipe.summary,
    trigger: recipe.trigger ?? knowledge?.delivery.trigger,
    kind: recipe.kind,
    category: knowledge?.classification.category,
    language: knowledge?.classification.language,
    knowledgeType: knowledge?.classification.knowledgeType,
    dimensionId: recipe.dimensionIds[0],
    topicHint: knowledge?.delivery.topicHint,
    doClause: knowledge?.delivery.doClause,
    dontClause: knowledge?.delivery.dontClause,
    whenClause: knowledge?.delivery.whenClause,
    coreCode: knowledge?.delivery.coreCode,
    usageGuide: knowledge?.delivery.usageGuide,
    headers: knowledge?.headers.headers ?? [],
    content: {
      markdown: knowledge?.body.markdown,
      rationale: knowledge?.body.rationale,
      pattern: knowledge?.body.pattern,
      steps: knowledge?.body.steps,
    },
    reasoning: {
      whyStandard: knowledge?.reasoning.whyStandard,
      sources: knowledge?.reasoning.sources,
      confidence: recipe.confidence,
    },
  };
}

function getNestedValue(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
