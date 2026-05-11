import type { Recipe, RecipeInput } from "./Recipe.js";
import type { RecipeKnowledgePayload } from "./RecipeKnowledgePayload.js";
import { type MainlineRecipeQualityScore, RecipeQualityPolicy } from "./RecipeQualityPolicy.js";
import {
  type MainlineRecipeSimilarityMatch,
  RecipeSimilarityPolicy,
} from "./RecipeSimilarityPolicy.js";
import {
  type NormalizeRecipeSubmissionOptions,
  normalizeRecipeSubmissionToInput,
  type RecipeSubmission,
} from "./RecipeSubmission.js";
import { buildConsolidationAction } from "./RecipeSubmissionConsolidation.js";

export type MainlineRecipeSubmissionDecision =
  | "create"
  | "merge"
  | "reorganize"
  | "insufficient"
  | "reject"
  | "review";

export interface RecipeSubmissionPolicyOptions extends NormalizeRecipeSubmissionOptions {
  readonly existingRecipes?: readonly Recipe[] | undefined;
  readonly existingTitles?: readonly string[] | undefined;
  readonly existingTriggers?: readonly string[] | undefined;
  readonly existingCodeFingerprints?: readonly string[] | undefined;
  readonly systemInjectedFields?: readonly string[] | undefined;
  readonly skipUniqueness?: boolean | undefined;
  readonly skipSimilarity?: boolean | undefined;
  readonly duplicateSimilarityThreshold?: number | undefined;
  readonly highOverlapThreshold?: number | undefined;
  readonly reviewSimilarityThreshold?: number | undefined;
  readonly minSubstanceScore?: number | undefined;
  readonly nowMs?: number | undefined;
}

export interface MainlineRecipeSubmissionPolicyResult {
  readonly accepted: boolean;
  readonly decision: MainlineRecipeSubmissionDecision;
  readonly recipeInput?: RecipeInput | undefined;
  readonly consolidationAction?: MainlineRecipeConsolidationAction | undefined;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly quality?: MainlineRecipeQualityScore | undefined;
  readonly similarRecipes: readonly MainlineRecipeSimilarityMatch[];
  readonly substanceScore: number;
}

export type MainlineRecipeConsolidationActionType = "merge" | "reorganize";

export type MainlineRecipeConsolidationDisposition = "execute" | "review";

export type MainlineRecipeFieldMergeOperation = "append" | "replace" | "keep-target" | "review";

export interface MainlineRecipeConsolidationRecipeRef {
  readonly id: string;
  readonly title: string;
  readonly similarity: number;
}

export interface MainlineRecipeFieldMergeSuggestion {
  readonly field: string;
  readonly operation: MainlineRecipeFieldMergeOperation;
  readonly candidateValue?: unknown | undefined;
  readonly targetValue?: unknown | undefined;
  readonly reason: string;
}

export interface MainlineRecipeConsolidationAction {
  readonly action: MainlineRecipeConsolidationActionType;
  readonly candidateRecipe: RecipeInput;
  readonly targetRecipe?: MainlineRecipeConsolidationRecipeRef | undefined;
  readonly similarRecipes: readonly MainlineRecipeConsolidationRecipeRef[];
  readonly fieldMergeSuggestions: readonly MainlineRecipeFieldMergeSuggestion[];
  readonly reviewReason: string;
  readonly recommendedDisposition: MainlineRecipeConsolidationDisposition;
}

interface RequiredFieldSpec {
  readonly name: string;
  readonly type: "string" | "array" | "object";
  readonly rule: string;
}

const REQUIRED_FIELDS: readonly RequiredFieldSpec[] = [
  {
    name: "title",
    type: "string",
    rule: "Recipe identity and dedup need a project-specific title.",
  },
  { name: "content", type: "object", rule: "content must carry markdown/rationale body fields." },
  {
    name: "content.markdown",
    type: "string",
    rule: "content.markdown is the long-form evidence body.",
  },
  {
    name: "content.rationale",
    type: "string",
    rule: "content.rationale explains why this is a standard.",
  },
  { name: "description", type: "string", rule: "description/summary is used in search display." },
  { name: "trigger", type: "string", rule: "trigger is required for runtime recall." },
  { name: "kind", type: "string", rule: "kind decides delivery behavior." },
  {
    name: "doClause",
    type: "string",
    rule: "doClause is the positive action for agent injection.",
  },
  { name: "dontClause", type: "string", rule: "dontClause prevents incorrect implementation." },
  { name: "whenClause", type: "string", rule: "whenClause defines the usage context." },
  { name: "coreCode", type: "string", rule: "coreCode gives the shortest executable pattern." },
  { name: "category", type: "string", rule: "category groups related knowledge." },
  {
    name: "headers",
    type: "array",
    rule: "headers is part of delivery metadata; empty is allowed.",
  },
  { name: "reasoning", type: "object", rule: "reasoning must carry provenance and confidence." },
  { name: "reasoning.whyStandard", type: "string", rule: "whyStandard explains the standard." },
  { name: "reasoning.sources", type: "array", rule: "sources must point to project evidence." },
  { name: "knowledgeType", type: "string", rule: "knowledgeType preserves old fine-grained type." },
  { name: "language", type: "string", rule: "language is used by search, Guard, and delivery." },
  { name: "usageGuide", type: "string", rule: "usageGuide explains how to apply the Recipe." },
];

const EXPECTED_FIELDS: readonly RequiredFieldSpec[] = [
  { name: "dimensionId", type: "string", rule: "dimensionId keeps cold-start coverage visible." },
  { name: "topicHint", type: "string", rule: "topicHint improves runtime disambiguation." },
];

const DEFAULT_DUPLICATE_SIMILARITY_THRESHOLD = 0.7;
const DEFAULT_HIGH_OVERLAP_THRESHOLD = 0.65;
const DEFAULT_REVIEW_SIMILARITY_THRESHOLD = 0.4;
const DEFAULT_MIN_SUBSTANCE_SCORE = 0.3;
const REJECT_CONFIDENCE_THRESHOLD = 0.2;
const AUTO_APPROVE_THRESHOLD = 0.85;
const TRUSTED_AUTO_APPROVE_THRESHOLD = 0.7;
const HIGH_CONFIDENCE_THRESHOLD = 0.9;
const STANDARD_GRACE_PERIOD_MS = 72 * 60 * 60 * 1000;
const HIGH_CONFIDENCE_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const TRUSTED_SOURCES = new Set(["bootstrap", "cursor-scan", "mcp"]);

/**
 * RecipeSubmissionPolicy 是 AI/agent 写入统一 Recipe 前的主线闸门。
 * 它把旧 UnifiedValidator、ConsolidationAdvisor、ConfidenceRouter 的核心策略直接落到 mainline。
 */
export class RecipeSubmissionPolicy {
  readonly #quality: RecipeQualityPolicy;
  readonly #similarity: RecipeSimilarityPolicy;

  constructor(
    dependencies: {
      readonly qualityPolicy?: RecipeQualityPolicy | undefined;
      readonly similarityPolicy?: RecipeSimilarityPolicy | undefined;
    } = {},
  ) {
    this.#quality = dependencies.qualityPolicy ?? new RecipeQualityPolicy();
    this.#similarity = dependencies.similarityPolicy ?? new RecipeSimilarityPolicy();
  }

  evaluate(
    submission: RecipeSubmission | RecipeInput,
    options: RecipeSubmissionPolicyOptions = {},
  ): MainlineRecipeSubmissionPolicyResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let recipeInput: RecipeInput;

    try {
      recipeInput = normalizeRecipeSubmissionToInput(submission as RecipeSubmission, options);
    } catch (error) {
      return {
        accepted: false,
        decision: "reject",
        errors: [error instanceof Error ? error.message : String(error)],
        warnings,
        similarRecipes: [],
        substanceScore: 0,
      };
    }

    const candidate = candidateFields(submission, recipeInput);
    validateRequiredFields(candidate, options, errors, warnings);
    validateContentQuality(candidate, errors, warnings);
    if (!options.skipUniqueness) {
      validateUniqueness(candidate, options, errors);
    }

    const substanceScore = scoreSubstance(candidate);
    if (substanceScore < (options.minSubstanceScore ?? DEFAULT_MIN_SUBSTANCE_SCORE)) {
      errors.push(`Recipe 内容实质不足: substanceScore=${substanceScore.toFixed(2)}`);
    }

    const similarRecipes = options.skipSimilarity
      ? []
      : this.#similarity.findSimilar(recipeInput, options.existingRecipes ?? [], {
          threshold: options.reviewSimilarityThreshold ?? DEFAULT_REVIEW_SIMILARITY_THRESHOLD,
          limit: 10,
        });
    const similarityDecision = evaluateSimilarity(similarRecipes, options, errors, warnings);
    const quality = this.#quality.score(recipeInput);
    const routed = routeRecipeInput(recipeInput, quality, {
      nowMs: options.nowMs ?? Date.now(),
      errors,
      warnings,
    });
    const decision = resolveDecision(
      errors,
      substanceScore,
      similarityDecision,
      options.minSubstanceScore ?? DEFAULT_MIN_SUBSTANCE_SCORE,
    );
    const consolidationAction = buildConsolidationAction({
      decision,
      candidate: routed,
      candidateFields: candidate,
      similarRecipes,
      errors,
      warnings,
    });

    return {
      accepted: errors.length === 0,
      decision,
      recipeInput: routed,
      consolidationAction,
      errors,
      warnings,
      quality,
      similarRecipes,
      substanceScore,
    };
  }
}

export function mainlineRecipeCodeFingerprint(code: string | null | undefined): string {
  return (code || "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .slice(0, 200);
}

function validateRequiredFields(
  candidate: Record<string, unknown>,
  options: RecipeSubmissionPolicyOptions,
  errors: string[],
  warnings: string[],
): void {
  const systemInjected = new Set(options.systemInjectedFields ?? []);
  for (const field of REQUIRED_FIELDS) {
    if (systemInjected.has(field.name)) {
      continue;
    }
    if (isMissing(getNestedValue(candidate, field.name), field)) {
      errors.push(`缺少必填字段: ${field.name} — ${field.rule}`);
    }
  }
  for (const field of EXPECTED_FIELDS) {
    if (systemInjected.has(field.name)) {
      continue;
    }
    if (isMissing(getNestedValue(candidate, field.name), field)) {
      warnings.push(`建议填写: ${field.name} — ${field.rule}`);
    }
  }
}

function validateContentQuality(
  candidate: Record<string, unknown>,
  errors: string[],
  warnings: string[],
): void {
  const markdown = stringValue(getNestedValue(candidate, "content.markdown")) ?? "";
  if (markdown.length > 0 && markdown.length < 200) {
    errors.push(
      `content.markdown 过短 (${markdown.length} 字符, 最少 200)。请包含代码片段和项目上下文描述。`,
    );
  }
  if (
    markdown.length >= 200 &&
    !/```[\s\S]*?```/.test(markdown) &&
    !/\S+\.\w{1,10}(:\d+)?/.test(markdown)
  ) {
    errors.push("content.markdown 中必须包含至少一个代码块或文件引用");
  }
  if (markdown.length >= 200 && !hasSourceReference(markdown)) {
    warnings.push("建议在内容中标注代码来源 (来源: path/to/File.ext:行号)");
  }
  if (
    markdown.length >= 200 &&
    hasBareSourceReference(markdown) &&
    !hasFullPathReference(markdown)
  ) {
    warnings.push("源码位置应使用完整相对路径+行号，而非仅文件名");
  }

  const coreCode = (stringValue(candidate.coreCode) ?? "").trim();
  if (coreCode && ["}", ")", "]"].includes(coreCode[0] ?? "")) {
    errors.push(`coreCode 以 "${coreCode[0]}" 开头 — 代码片段不完整，请包含完整的函数/方法/表达式`);
  }

  const title = stringValue(candidate.title) ?? "";
  if (/^(Singleton|Factory|Observer|MVC|MVVM) (pattern|模式)$/i.test(title.trim())) {
    errors.push(`标题过于通用: "${title}" — 请加上项目特定的上下文`);
  }

  if (markdown.length >= 200) {
    const lines = markdown.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length <= 2 && !/```[\s\S]*?```/.test(markdown)) {
      warnings.push(`内容仅 ${lines.length} 行 — 建议包含更多代码片段和设计意图描述`);
    }
  }

  const sources = arrayValue(getNestedValue(candidate, "reasoning.sources"));
  const bareSources = sources.filter(
    (source) => typeof source === "string" && !source.includes("/") && !source.includes("\\"),
  );
  if (sources.length > 0 && bareSources.length === sources.length) {
    warnings.push(
      `reasoning.sources 中的路径缺少目录结构（如 "${bareSources[0]}"）— 应使用完整相对路径`,
    );
  }
}

function validateUniqueness(
  candidate: Record<string, unknown>,
  options: RecipeSubmissionPolicyOptions,
  errors: string[],
): void {
  const titles = new Set(
    [
      ...(options.existingTitles ?? []),
      ...(options.existingRecipes ?? []).map((recipe) => recipe.title),
    ].map(normalizeUniqueKey),
  );
  const triggers = new Set(
    [
      ...(options.existingTriggers ?? []),
      ...(options.existingRecipes ?? []).flatMap((recipe) => [
        recipe.trigger,
        recipe.knowledge?.delivery.trigger,
      ]),
    ]
      .filter((value): value is string => typeof value === "string")
      .map(normalizeUniqueKey),
  );
  const fingerprints = new Set([
    ...(options.existingCodeFingerprints ?? []),
    ...(options.existingRecipes ?? []).flatMap((recipe) =>
      recipeCodeFingerprints(recipe).filter((fingerprint) => fingerprint.length >= 20),
    ),
  ]);

  const title = normalizeUniqueKey(stringValue(candidate.title));
  if (title && titles.has(title)) {
    errors.push(`标题重复: "${candidate.title}"`);
  }

  const trigger = normalizeUniqueKey(stringValue(candidate.trigger));
  if (trigger && triggers.has(trigger)) {
    errors.push(`trigger 重复: "${candidate.trigger}"`);
  }

  for (const fingerprint of candidateCodeFingerprints(candidate)) {
    if (fingerprint.length >= 20 && fingerprints.has(fingerprint)) {
      errors.push("代码模式重复 — 已存在相同核心代码的 Recipe。请提交不同的代码片段。");
      return;
    }
  }
}

function evaluateSimilarity(
  matches: readonly MainlineRecipeSimilarityMatch[],
  options: RecipeSubmissionPolicyOptions,
  errors: string[],
  warnings: string[],
): MainlineRecipeSubmissionDecision | null {
  const duplicateThreshold =
    options.duplicateSimilarityThreshold ?? DEFAULT_DUPLICATE_SIMILARITY_THRESHOLD;
  const highOverlapThreshold = options.highOverlapThreshold ?? DEFAULT_HIGH_OVERLAP_THRESHOLD;
  const duplicate = matches.find((match) => match.similarity >= duplicateThreshold);
  if (duplicate) {
    errors.push(
      `Recipe 与现有知识高度重复: ${duplicate.recipe.title} (similarity=${duplicate.similarity.toFixed(2)})`,
    );
    return "merge";
  }

  const highOverlaps = matches.filter((match) => match.similarity >= highOverlapThreshold);
  if (highOverlaps.length >= 2) {
    warnings.push(`发现 ${highOverlaps.length} 条高重叠 Recipe，建议重组而不是继续新增。`);
    return "reorganize";
  }
  if (highOverlaps.length === 1) {
    const overlap = highOverlaps[0];
    if (overlap) {
      warnings.push(`发现相近 Recipe: ${overlap.recipe.title}，建议优先考虑 merge。`);
    }
    return "merge";
  }
  if (matches.length > 0) {
    warnings.push(`发现 ${matches.length} 条相近 Recipe，建议人工复核新增价值。`);
    return "review";
  }
  return null;
}

function routeRecipeInput(
  recipeInput: RecipeInput,
  quality: MainlineRecipeQualityScore,
  context: {
    readonly nowMs: number;
    readonly errors: string[];
    readonly warnings: string[];
  },
): RecipeInput {
  const confidence = recipeInput.confidence ?? 0;
  if (confidence < REJECT_CONFIDENCE_THRESHOLD) {
    context.errors.push(
      `confidence 过低: ${confidence.toFixed(2)} < ${REJECT_CONFIDENCE_THRESHOLD}`,
    );
  }
  if (quality.score < 0.3) {
    context.warnings.push(`质量分偏低: ${quality.score.toFixed(2)}，保持 candidate/pending。`);
  }

  const source = recipeInput.knowledge?.source.source;
  const trusted = source ? TRUSTED_SOURCES.has(source) : false;
  const highConfidence = confidence >= HIGH_CONFIDENCE_THRESHOLD;
  const standardAuto =
    confidence >= AUTO_APPROVE_THRESHOLD ||
    (trusted && confidence >= TRUSTED_AUTO_APPROVE_THRESHOLD);
  const shouldStage = quality.score >= 0.3 && (highConfidence || standardAuto);
  const gracePeriod = highConfidence ? HIGH_CONFIDENCE_GRACE_PERIOD_MS : STANDARD_GRACE_PERIOD_MS;
  const lifecycle = shouldStage ? "staging" : "pending";
  const stagingDeadline = shouldStage ? context.nowMs + gracePeriod : null;

  return {
    ...recipeInput,
    status: confidence < REJECT_CONFIDENCE_THRESHOLD ? "rejected" : recipeInput.status,
    knowledge: mergePolicyQuality(recipeInput.knowledge, {
      quality,
      lifecycle,
      autoApprovable: shouldStage,
      stagingDeadline,
    }),
  };
}

function mergePolicyQuality(
  knowledge: RecipeKnowledgePayload | undefined,
  input: {
    readonly quality: MainlineRecipeQualityScore;
    readonly lifecycle: string;
    readonly autoApprovable: boolean;
    readonly stagingDeadline: number | null;
  },
): RecipeKnowledgePayload | undefined {
  if (!knowledge) {
    return undefined;
  }
  return {
    ...knowledge,
    quality: {
      ...knowledge.quality,
      completeness: input.quality.dimensions.completeness,
      overall: input.quality.score,
      grade: input.quality.grade,
    },
    governance: {
      ...knowledge.governance,
      lifecycle: input.lifecycle,
      autoApprovable: input.autoApprovable,
      stagingDeadline: input.stagingDeadline,
    },
  };
}

function resolveDecision(
  errors: readonly string[],
  substanceScore: number,
  similarityDecision: MainlineRecipeSubmissionDecision | null,
  minSubstanceScore: number,
): MainlineRecipeSubmissionDecision {
  if (substanceScore < minSubstanceScore) {
    return "insufficient";
  }
  if (errors.length > 0) {
    return similarityDecision === "merge" ? "merge" : "reject";
  }
  return similarityDecision ?? "create";
}

function candidateFields(
  submission: RecipeSubmission | RecipeInput,
  recipeInput: RecipeInput,
): Record<string, unknown> {
  const original = submission as Record<string, unknown>;
  const knowledge = recipeInput.knowledge;
  return {
    ...original,
    title: recipeInput.title,
    description: stringValue(original.description) ?? recipeInput.summary,
    summary: recipeInput.summary,
    trigger: recipeInput.trigger ?? knowledge?.delivery.trigger,
    kind: original.kind ?? recipeInput.kind,
    category: original.category ?? knowledge?.classification.category,
    language: original.language ?? knowledge?.classification.language,
    knowledgeType: original.knowledgeType ?? knowledge?.classification.knowledgeType,
    dimensionId: original.dimensionId ?? recipeInput.dimensionIds?.[0],
    topicHint: original.topicHint ?? knowledge?.delivery.topicHint,
    doClause: original.doClause ?? knowledge?.delivery.doClause,
    dontClause: original.dontClause ?? knowledge?.delivery.dontClause,
    whenClause: original.whenClause ?? knowledge?.delivery.whenClause,
    coreCode: original.coreCode ?? knowledge?.delivery.coreCode,
    usageGuide: original.usageGuide ?? knowledge?.delivery.usageGuide,
    headers: original.headers ?? knowledge?.headers.headers ?? [],
    content: {
      ...recordValue(original.content),
      markdown: recordValue(original.content).markdown ?? knowledge?.body.markdown,
      rationale: recordValue(original.content).rationale ?? knowledge?.body.rationale,
      pattern: recordValue(original.content).pattern ?? knowledge?.body.pattern,
      steps: recordValue(original.content).steps ?? knowledge?.body.steps,
    },
    reasoning: {
      ...recordValue(original.reasoning),
      whyStandard: recordValue(original.reasoning).whyStandard ?? knowledge?.reasoning.whyStandard,
      sources: recordValue(original.reasoning).sources ?? knowledge?.reasoning.sources,
      confidence: recordValue(original.reasoning).confidence ?? recipeInput.confidence,
    },
  };
}

function scoreSubstance(candidate: Record<string, unknown>): number {
  let score = 0;
  score += textContribution(stringValue(candidate.doClause), 15, 0.2);
  score += textContribution(stringValue(candidate.dontClause), 10, 0.1);
  score += textContribution(stringValue(candidate.whenClause), 15, 0.15);
  score += textContribution(stringValue(candidate.coreCode), 30, 0.25);
  score += textContribution(stringValue(getNestedValue(candidate, "content.markdown")), 200, 0.2);
  score += arrayValue(getNestedValue(candidate, "reasoning.sources")).length > 0 ? 0.1 : 0;
  return Math.round(Math.min(1, score) * 100) / 100;
}

function textContribution(value: string | undefined, targetLength: number, weight: number): number {
  if (!value?.trim()) {
    return 0;
  }
  return Math.min(1, value.trim().length / targetLength) * weight;
}

function candidateCodeFingerprints(candidate: Record<string, unknown>): string[] {
  return [
    stringValue(candidate.coreCode),
    stringValue(getNestedValue(candidate, "content.pattern")),
  ].flatMap((code) => {
    if (!code || code.length < 30) {
      return [];
    }
    return [mainlineRecipeCodeFingerprint(code)];
  });
}

function recipeCodeFingerprints(recipe: Recipe): string[] {
  return [recipe.knowledge?.delivery.coreCode, recipe.knowledge?.body.pattern].flatMap((code) => {
    if (!code || code.length < 30) {
      return [];
    }
    return [mainlineRecipeCodeFingerprint(code)];
  });
}

function isMissing(value: unknown, field: RequiredFieldSpec): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (field.type === "string") {
    return typeof value !== "string" || !value.trim();
  }
  if (field.type === "array") {
    if (!Array.isArray(value)) {
      return true;
    }
    return field.name === "reasoning.sources" ? value.length === 0 : false;
  }
  return !isRecord(value);
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

function hasSourceReference(markdown: string): boolean {
  return /来源[:：]|[Ss]ource[:：]|\(\S+\.\w+:\d+\)|\S+\.\w+:\d+/.test(markdown);
}

function hasFullPathReference(markdown: string): boolean {
  return /(?:来源[:：]\s*|\()\S+\/\S+\.\w+:\d+/.test(markdown);
}

function hasBareSourceReference(markdown: string): boolean {
  return /(?:来源[:：]\s*|\()[A-Z]\w+\.\w+:\d+/.test(markdown);
}

function normalizeUniqueKey(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
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
