import type { Recipe } from "./Recipe.js";
import type { RecipeSubmission } from "./RecipeSubmission.js";
import {
  type MainlineRecipeConsolidationAction,
  type MainlineRecipeSubmissionDecision,
  type MainlineRecipeSubmissionPolicyResult,
  mainlineRecipeCodeFingerprint,
  RecipeSubmissionPolicy,
  type RecipeSubmissionPolicyOptions,
} from "./RecipeSubmissionPolicy.js";

export interface RecipeSubmissionAdmissionOptions
  extends Omit<
    RecipeSubmissionPolicyOptions,
    "existingTitles" | "existingTriggers" | "existingCodeFingerprints"
  > {
  readonly existingTitles?: unknown | undefined;
  readonly existingTriggers?: unknown | undefined;
  readonly existingCodeFingerprints?: unknown | undefined;
}

export interface RecipeSubmissionAdmissionDecision {
  readonly accepted: boolean;
  readonly rejected: boolean;
  readonly duplicate: boolean;
  readonly merge: boolean;
  readonly reorganize: boolean;
  readonly decision: MainlineRecipeSubmissionDecision;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly similarRecipes: readonly {
    readonly id: string;
    readonly title: string;
    readonly similarity: number;
  }[];
  readonly consolidationAction?: MainlineRecipeConsolidationAction | undefined;
  readonly substanceScore: number;
  readonly quality?:
    | {
        readonly score: number;
        readonly grade: string;
      }
    | undefined;
}

export function admitRecipeSubmission(
  submission: RecipeSubmission,
  options: RecipeSubmissionAdmissionOptions = {},
): RecipeSubmissionAdmissionDecision {
  const result = new RecipeSubmissionPolicy().evaluate(submission, {
    ...options,
    id: options.id ?? stableAdmissionId(submission.title),
    existingTitles: normalizeStringList(options.existingTitles),
    existingTriggers: normalizeStringList(options.existingTriggers),
    existingCodeFingerprints: normalizeStringList(options.existingCodeFingerprints),
  });
  return presentAdmissionDecision(result);
}

export function existingCodeFingerprintsFromRecords(records: readonly unknown[]): string[] {
  const fingerprints = new Set<string>();
  for (const record of records) {
    const item = recordValue(record);
    const content = recordValue(item?.content);
    for (const value of [item?.coreCode, content?.pattern, content?.markdown]) {
      if (typeof value !== "string") {
        continue;
      }
      const fingerprint = mainlineRecipeCodeFingerprint(value);
      if (fingerprint.length >= 20) {
        fingerprints.add(fingerprint);
      }
    }
  }
  return [...fingerprints];
}

export function existingRecipesFromRecords(records: readonly unknown[]): Recipe[] {
  return records.map(recordToRecipe).filter((recipe): recipe is Recipe => recipe !== null);
}

function presentAdmissionDecision(
  result: MainlineRecipeSubmissionPolicyResult,
): RecipeSubmissionAdmissionDecision {
  const duplicate = result.errors.some((error) => /重复|高度重复/.test(error));
  return {
    accepted: result.accepted,
    rejected: !result.accepted,
    duplicate,
    merge: result.decision === "merge",
    reorganize: result.decision === "reorganize",
    decision: result.decision,
    errors: result.errors,
    warnings: result.warnings,
    similarRecipes: result.similarRecipes.map((match) => ({
      id: match.recipe.id,
      title: match.recipe.title,
      similarity: match.similarity,
    })),
    consolidationAction: result.consolidationAction,
    substanceScore: result.substanceScore,
    quality: result.quality
      ? { score: result.quality.score, grade: result.quality.grade }
      : undefined,
  };
}

function stableAdmissionId(title: unknown): string {
  const raw = typeof title === "string" && title.trim() ? title.trim() : "untitled";
  return `admission:${raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function normalizeStringList(value: unknown): string[] {
  if (value instanceof Set) {
    return [...value].filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function recordToRecipe(value: unknown): Recipe | null {
  const item = recordValue(value);
  if (!item) {
    return null;
  }
  const id = stringValue(item.id) ?? stringValue(item._id) ?? stringValue(item.title);
  const title = stringValue(item.title);
  if (!id || !title) {
    return null;
  }
  return {
    id,
    title,
    kind: "pattern",
    status: "candidate",
    summary: stringValue(item.description) ?? stringValue(item.summary) ?? "",
    trigger: stringValue(item.trigger),
    dimensionIds: normalizeStringList(item.dimensionId),
    tags: normalizeStringList(item.tags),
    sourceRefIds: normalizeStringList(item.sourceRefs),
    confidence: typeof item.confidence === "number" ? item.confidence : 0,
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
