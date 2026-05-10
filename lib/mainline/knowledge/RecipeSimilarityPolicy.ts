import { extractMainlineMarkdownCodeBlocks } from "./internal/Markdown.js";
import {
  extractMainlineApiTokens,
  mainlineJaccardSimilarity,
  tokenizeMainlineSimilarity,
} from "./internal/TextAnalysis.js";
import type { Recipe, RecipeInput } from "./Recipe.js";
import type { RecipeSubmission } from "./RecipeSubmission.js";

export interface MainlineRecipeSimilarityLike {
  readonly title?: string | undefined;
  readonly trigger?: string | null | undefined;
  readonly category?: string | null | undefined;
  readonly doClause?: string | null | undefined;
  readonly dontClause?: string | null | undefined;
  readonly coreCode?: string | null | undefined;
  readonly guardPattern?: string | null | undefined;
  readonly content?: {
    readonly markdown?: string | null | undefined;
    readonly pattern?: string | null | undefined;
    readonly steps?: readonly { readonly code?: string | null }[];
  } | null;
}

export interface MainlineRecipeSimilarityDimensions {
  readonly title: number;
  readonly clause: number;
  readonly code: number;
  readonly content: number;
  readonly guard: number;
}

export interface MainlineRecipeFieldAnalysis {
  readonly triggerConflict: boolean;
  readonly doClauseSubset: boolean;
  readonly coreCodeOverlap: number;
  readonly categoryMatch: boolean;
}

export interface MainlineRecipeSimilarityResult {
  readonly similarity: number;
  readonly dimensions: MainlineRecipeSimilarityDimensions;
  readonly fields: MainlineRecipeFieldAnalysis;
}

export interface MainlineRecipeSimilarityMatch extends MainlineRecipeSimilarityResult {
  readonly recipe: Recipe;
}

const SIMILARITY_WEIGHTS = {
  title: 0.15,
  clause: 0.25,
  code: 0.15,
  content: 0.3,
  guard: 0.15,
} as const;

const STOP_WORDS = new Set([
  "我们",
  "使用",
  "项目",
  "需要",
  "可以",
  "应该",
  "建议",
  "目前",
  "已经",
  "这个",
  "那个",
  "一个",
  "进行",
  "通过",
  "对于",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "this",
  "that",
  "these",
  "those",
  "for",
  "and",
  "but",
  "with",
  "not",
  "from",
  "use",
  "all",
  "any",
]);

/**
 * RecipeSimilarityPolicy 是旧 RecipeSimilarity 的主线直接实现。
 * 它保留五维权重和字段级分析，但输入面向统一 Recipe/Submission。
 */
export class RecipeSimilarityPolicy {
  compute(
    left: Recipe | RecipeInput | RecipeSubmission | MainlineRecipeSimilarityLike,
    right: Recipe | RecipeInput | RecipeSubmission | MainlineRecipeSimilarityLike,
  ): MainlineRecipeSimilarityResult {
    const a = toSimilarityLike(left);
    const b = toSimilarityLike(right);
    const dimensions = this.computeDimensions(a, b);
    const similarity =
      SIMILARITY_WEIGHTS.title * dimensions.title +
      SIMILARITY_WEIGHTS.clause * dimensions.clause +
      SIMILARITY_WEIGHTS.code * dimensions.code +
      SIMILARITY_WEIGHTS.content * dimensions.content +
      SIMILARITY_WEIGHTS.guard * dimensions.guard;

    return {
      similarity: roundSimilarity(similarity),
      dimensions,
      fields: this.analyzeFields(a, b),
    };
  }

  computeDimensions(
    left: MainlineRecipeSimilarityLike,
    right: MainlineRecipeSimilarityLike,
  ): MainlineRecipeSimilarityDimensions {
    return {
      title: topicJaccard(left.title, right.title),
      clause: topicJaccard(
        [left.doClause, left.dontClause].filter(Boolean).join(" "),
        [right.doClause, right.dontClause].filter(Boolean).join(" "),
      ),
      code: codeSimilarity(left.coreCode, right.coreCode),
      content: contentTokenSimilarity(left, right),
      guard: guardPatternMatch(left.guardPattern, right.guardPattern),
    };
  }

  analyzeFields(
    candidate: MainlineRecipeSimilarityLike,
    existing: MainlineRecipeSimilarityLike,
  ): MainlineRecipeFieldAnalysis {
    return {
      triggerConflict: isTriggerConflict(candidate.trigger, existing.trigger),
      doClauseSubset: isDoClauseSubset(candidate.doClause, existing.doClause),
      coreCodeOverlap: codeSimilarity(candidate.coreCode, existing.coreCode),
      categoryMatch: Boolean(
        candidate.category && existing.category && candidate.category === existing.category,
      ),
    };
  }

  findSimilar(
    candidate: Recipe | RecipeInput | RecipeSubmission | MainlineRecipeSimilarityLike,
    existingRecipes: readonly Recipe[],
    options: { readonly threshold?: number | undefined; readonly limit?: number } = {},
  ): MainlineRecipeSimilarityMatch[] {
    const threshold = options.threshold ?? 0.4;
    const limit = options.limit ?? 10;
    return existingRecipes
      .map((recipe) => ({ recipe, ...this.compute(candidate, recipe) }))
      .filter((match) => match.similarity >= threshold)
      .sort(
        (left, right) =>
          right.similarity - left.similarity || left.recipe.id.localeCompare(right.recipe.id),
      )
      .slice(0, limit);
  }
}

export function toSimilarityLike(
  input: Recipe | RecipeInput | RecipeSubmission | MainlineRecipeSimilarityLike,
): MainlineRecipeSimilarityLike {
  const record = input as Record<string, unknown>;
  const knowledge = recordValue(record.knowledge);
  const classification = recordValue(knowledge.classification);
  const delivery = recordValue(knowledge.delivery);
  const body = recordValue(knowledge.body);
  const content = recordValue(record.content);
  const flatSteps = arrayValue(content.steps);
  const bodySteps = arrayValue(body.steps);
  const pattern = stringValue(body.pattern) ?? stringValue(content.pattern);

  return {
    title: stringValue(record.title),
    trigger: stringValue(record.trigger) ?? stringValue(delivery.trigger),
    category: stringValue(record.category) ?? stringValue(classification.category),
    doClause: stringValue(record.doClause) ?? stringValue(delivery.doClause),
    dontClause: stringValue(record.dontClause) ?? stringValue(delivery.dontClause),
    coreCode: stringValue(record.coreCode) ?? stringValue(delivery.coreCode),
    guardPattern: pattern,
    content: {
      markdown: stringValue(body.markdown) ?? stringValue(content.markdown),
      pattern,
      steps: [...flatSteps, ...bodySteps].flatMap((step) => {
        const code = isRecord(step) ? stringValue(step.code) : undefined;
        return code ? [{ code }] : [];
      }),
    },
  };
}

function contentTokenSimilarity(
  left: MainlineRecipeSimilarityLike,
  right: MainlineRecipeSimilarityLike,
): number {
  return mainlineJaccardSimilarity(extractRecipeApiTokens(left), extractRecipeApiTokens(right));
}

export function extractRecipeApiTokens(input: MainlineRecipeSimilarityLike): Set<string> {
  const tokens = new Set<string>();
  for (const code of recipeCodeFragments(input)) {
    for (const token of extractMainlineApiTokens(code)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function recipeCodeFragments(input: MainlineRecipeSimilarityLike): string[] {
  const fragments: string[] = [];
  if (input.coreCode?.trim()) {
    fragments.push(input.coreCode);
  }
  if (input.content?.pattern?.trim()) {
    fragments.push(input.content.pattern);
  }
  if (input.content?.markdown?.trim()) {
    fragments.push(
      ...extractMainlineMarkdownCodeBlocks(input.content.markdown).map((block) => block.code),
    );
  }
  for (const step of input.content?.steps ?? []) {
    if (step.code?.trim()) {
      fragments.push(step.code);
    }
  }
  return fragments;
}

function topicJaccard(left: string | null | undefined, right: string | null | undefined): number {
  return mainlineJaccardSimilarity(topicWords(left), topicWords(right));
}

function topicWords(text: string | null | undefined): Set<string> {
  return new Set(
    [...tokenizeMainlineSimilarity(text ?? "")].filter((token) => !STOP_WORDS.has(token)),
  );
}

function codeSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const a = left?.replace(/\s+/g, "") ?? "";
  const b = right?.replace(/\s+/g, "") ?? "";
  if (!a || !b) {
    return 0;
  }
  return ngramJaccard(a, b, 3);
}

function ngramJaccard(left: string, right: string, size: number): number {
  return mainlineJaccardSimilarity(ngrams(left, size), ngrams(right, size));
}

function ngrams(text: string, size: number): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index <= text.length - size; index += 1) {
    grams.add(text.slice(index, index + size));
  }
  return grams;
}

function guardPatternMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  return left && right && left === right ? 1 : 0;
}

function isTriggerConflict(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  const prefixLeft = triggerPrefix(left);
  const prefixRight = triggerPrefix(right);
  return prefixLeft.length > 3 && prefixLeft === prefixRight;
}

function triggerPrefix(trigger: string): string {
  if (!trigger.startsWith("@")) {
    return "";
  }
  const parts = trigger.split("-");
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : trigger;
}

function isDoClauseSubset(
  candidateDo: string | null | undefined,
  existingDo: string | null | undefined,
): boolean {
  const candidateWords = topicWords(candidateDo);
  const existingWords = topicWords(existingDo);
  if (candidateWords.size === 0 || existingWords.size === 0) {
    return false;
  }
  let covered = 0;
  for (const word of candidateWords) {
    if (existingWords.has(word)) {
      covered += 1;
    }
  }
  return covered / candidateWords.size >= 0.8;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundSimilarity(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}
