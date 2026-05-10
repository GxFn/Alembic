import { defaultMainlineLanguageCatalog } from "../code/LanguageCatalog.js";
import type { Recipe, RecipeInput } from "./Recipe.js";
import type { RecipeSubmission } from "./RecipeSubmission.js";

export interface MainlineRecipeQualityInput {
  readonly title?: string | undefined;
  readonly trigger?: string | undefined;
  readonly description?: string | undefined;
  readonly language?: string | undefined;
  readonly category?: string | undefined;
  readonly doClause?: string | undefined;
  readonly dontClause?: string | undefined;
  readonly whenClause?: string | undefined;
  readonly coreCode?: string | undefined;
  readonly usageGuide?: string | undefined;
  readonly contentMarkdown?: string | undefined;
  readonly contentRationale?: string | undefined;
  readonly reasoningWhyStandard?: string | undefined;
  readonly reasoningSources?: readonly string[] | undefined;
  readonly reasoningConfidence?: number | undefined;
  readonly source?: string | undefined;
  readonly headers?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly authority?: number | undefined;
}

export interface MainlineRecipeQualityDimensions {
  readonly completeness: number;
  readonly contentDepth: number;
  readonly deliveryReady: number;
  readonly actionability: number;
  readonly provenance: number;
}

export interface MainlineRecipeQualityScore {
  readonly score: number;
  readonly dimensions: MainlineRecipeQualityDimensions;
  readonly grade: "A" | "B" | "C" | "D" | "F";
}

const QUALITY_WEIGHTS = {
  completeness: 0.25,
  contentDepth: 0.3,
  deliveryReady: 0.2,
  actionability: 0.15,
  provenance: 0.1,
} as const;

const QUALITY_GRADES = {
  A: 0.85,
  B: 0.7,
  C: 0.55,
  D: 0.35,
} as const;

/**
 * RecipeQualityPolicy 是旧 QualityScorer 五维评分的主线实现。
 * 它只读取统一 Recipe 字段，不依赖旧 KnowledgeEntry 或旧 service。
 */
export class RecipeQualityPolicy {
  score(
    input: Recipe | RecipeInput | RecipeSubmission | MainlineRecipeQualityInput,
  ): MainlineRecipeQualityScore {
    const recipe = toQualityInput(input);
    const dimensions: MainlineRecipeQualityDimensions = {
      completeness: scoreCompleteness(recipe),
      contentDepth: scoreContentDepth(recipe),
      deliveryReady: scoreDeliveryReady(recipe),
      actionability: scoreActionability(recipe),
      provenance: scoreProvenance(recipe),
    };
    const score = clamp01(
      dimensions.completeness * QUALITY_WEIGHTS.completeness +
        dimensions.contentDepth * QUALITY_WEIGHTS.contentDepth +
        dimensions.deliveryReady * QUALITY_WEIGHTS.deliveryReady +
        dimensions.actionability * QUALITY_WEIGHTS.actionability +
        dimensions.provenance * QUALITY_WEIGHTS.provenance,
    );

    return {
      score: roundScore(score),
      dimensions: roundDimensions(dimensions),
      grade: toGrade(score),
    };
  }
}

export function toQualityInput(
  input: Recipe | RecipeInput | RecipeSubmission | MainlineRecipeQualityInput,
): MainlineRecipeQualityInput {
  const record = input as Record<string, unknown>;
  const knowledge = recordValue(record.knowledge);
  const classification = recordValue(knowledge.classification);
  const delivery = recordValue(knowledge.delivery);
  const body = recordValue(knowledge.body);
  const reasoning = recordValue(knowledge.reasoning);
  const usage = recordValue(knowledge.usage);
  const source = recordValue(knowledge.source);
  const headers = recordValue(knowledge.headers);
  const content = recordValue(record.content);

  return {
    title: stringValue(record.title),
    trigger: stringValue(record.trigger) ?? stringValue(delivery.trigger),
    description:
      stringValue(record.description) ??
      stringValue(record.summary) ??
      stringValue(delivery.doClause),
    language: stringValue(record.language) ?? stringValue(classification.language),
    category: stringValue(record.category) ?? stringValue(classification.category),
    doClause: stringValue(record.doClause) ?? stringValue(delivery.doClause),
    dontClause: stringValue(record.dontClause) ?? stringValue(delivery.dontClause),
    whenClause: stringValue(record.whenClause) ?? stringValue(delivery.whenClause),
    coreCode: stringValue(record.coreCode) ?? stringValue(delivery.coreCode),
    usageGuide: stringValue(record.usageGuide) ?? stringValue(delivery.usageGuide),
    contentMarkdown: stringValue(body.markdown) ?? stringValue(content.markdown),
    contentRationale: stringValue(body.rationale) ?? stringValue(content.rationale),
    reasoningWhyStandard: stringValue(reasoning.whyStandard),
    reasoningSources: stringArray(reasoning.sources),
    reasoningConfidence: numberValue(reasoning.confidence) ?? numberValue(record.confidence),
    source: stringValue(source.source) ?? stringValue(record.source),
    headers: stringArray(headers.headers),
    tags: stringArray(record.tags),
    authority: numberValue(usage.authority),
  };
}

function scoreCompleteness(recipe: MainlineRecipeQualityInput): number {
  let score = 0;
  score += textScore(recipe.title, 3, 40, 0.15);
  score += presenceScore(recipe.trigger, 0.15);
  score += textScore(recipe.description, 10, 60, 0.15);
  score += textScore(recipe.doClause, 10, 50, 0.15);
  score += textScore(recipe.whenClause, 10, 50, 0.15);
  score += textScore(recipe.coreCode, 10, 200, 0.15);
  score += presenceScore(recipe.dontClause, 0.1);
  return clamp01(score);
}

function scoreContentDepth(recipe: MainlineRecipeQualityInput): number {
  let score = 0;
  const markdown = recipe.contentMarkdown || recipe.usageGuide || "";
  score += textScore(markdown || undefined, 50, 800, 0.3);

  if (markdown) {
    if (/^#{1,4}\s/m.test(markdown)) {
      score += 0.08;
    }
    if (/```[\s\S]*?```|`[^`]+`/.test(markdown)) {
      score += 0.08;
    }
    if (/^[\s]*[-*+]\s/m.test(markdown)) {
      score += 0.04;
    }
  }

  score += textScore(recipe.contentRationale, 10, 100, 0.15);
  score += textScore(recipe.reasoningWhyStandard, 10, 100, 0.15);
  if (recipe.reasoningSources && recipe.reasoningSources.length > 0) {
    score += Math.min(0.1, recipe.reasoningSources.length * 0.03);
  }
  if (recipe.usageGuide && recipe.usageGuide !== markdown) {
    score += textScore(recipe.usageGuide, 20, 200, 0.1);
  }
  return clamp01(score);
}

function scoreDeliveryReady(recipe: MainlineRecipeQualityInput): number {
  let score = 0;
  if (recipe.trigger) {
    const valid =
      /^[a-zA-Z0-9_\-:.@]+$/.test(recipe.trigger) &&
      recipe.trigger.length >= 2 &&
      recipe.trigger.length <= 80;
    score += valid ? 0.25 : 0.15;
  }

  if (recipe.language) {
    const normalized = defaultMainlineLanguageCatalog.normalize(recipe.language);
    score += defaultMainlineLanguageCatalog.displayName(normalized) === normalized ? 0.1 : 0.25;
  }

  score += presenceScore(recipe.category, 0.2);
  if (recipe.tags && recipe.tags.length > 0) {
    score += Math.min(0.15, recipe.tags.length * 0.04);
  }
  if (recipe.headers && recipe.headers.length > 0) {
    score += Math.min(0.15, recipe.headers.length * 0.05);
  }
  return clamp01(score);
}

function scoreActionability(recipe: MainlineRecipeQualityInput): number {
  let score = 0;
  const code = recipe.coreCode || "";
  const markdown = recipe.contentMarkdown || recipe.usageGuide || "";
  const codeLength = code.trim().length;

  if (codeLength >= 30 && codeLength <= 500) {
    score += 0.3;
  } else if (codeLength >= 10) {
    score += 0.2;
  } else if (/```[\s\S]{10,}?```/.test(markdown)) {
    score += 0.2;
  }

  if (recipe.doClause) {
    const length = recipe.doClause.trim().length;
    score += length >= 15 && length <= 200 ? 0.25 : length >= 5 ? 0.1 : 0;
  }
  if (recipe.doClause?.trim() && recipe.dontClause?.trim()) {
    score += 0.2;
  } else if (recipe.doClause?.trim()) {
    score += 0.1;
  }
  if (recipe.whenClause) {
    const length = recipe.whenClause.trim().length;
    score += length >= 15 ? 0.25 : length >= 5 ? 0.1 : 0;
  }
  return clamp01(score);
}

function scoreProvenance(recipe: MainlineRecipeQualityInput): number {
  let score = 0;
  if (recipe.reasoningConfidence != null && recipe.reasoningConfidence > 0) {
    score += clamp01(recipe.reasoningConfidence) * 0.3;
  }
  if (recipe.reasoningSources && recipe.reasoningSources.length > 0) {
    score += Math.min(0.3, recipe.reasoningSources.length * 0.1);
  }
  if (recipe.source === "manual") {
    score += 0.2;
  } else if (recipe.source === "mcp") {
    score += 0.15;
  } else if (recipe.source === "bootstrap" || recipe.source === "cursor-scan") {
    score += 0.1;
  }
  if (recipe.authority && recipe.authority > 0) {
    score += (Math.min(100, recipe.authority) / 100) * 0.2;
  }
  return clamp01(score);
}

function textScore(
  text: string | undefined,
  minLength: number,
  optimalLength: number,
  weight: number,
): number {
  if (!text?.trim()) {
    return 0;
  }
  const length = text.trim().length;
  if (length < minLength) {
    return weight * 0.2;
  }
  if (length <= optimalLength) {
    return weight * (0.5 + 0.5 * (length / optimalLength));
  }
  return weight;
}

function presenceScore(value: string | undefined, weight: number): number {
  return value?.trim() ? weight : 0;
}

function toGrade(score: number): MainlineRecipeQualityScore["grade"] {
  if (score >= QUALITY_GRADES.A) {
    return "A";
  }
  if (score >= QUALITY_GRADES.B) {
    return "B";
  }
  if (score >= QUALITY_GRADES.C) {
    return "C";
  }
  if (score >= QUALITY_GRADES.D) {
    return "D";
  }
  return "F";
}

function roundDimensions(
  dimensions: MainlineRecipeQualityDimensions,
): MainlineRecipeQualityDimensions {
  return {
    completeness: roundScore(dimensions.completeness),
    contentDepth: roundScore(dimensions.contentDepth),
    deliveryReady: roundScore(dimensions.deliveryReady),
    actionability: roundScore(dimensions.actionability),
    provenance: roundScore(dimensions.provenance),
  };
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string"))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
