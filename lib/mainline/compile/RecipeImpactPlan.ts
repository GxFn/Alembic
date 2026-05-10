export type MainlineRecipeImpactLevel = "pattern" | "reference" | "none";

export type MainlineRecipeImpactReason =
  | "source-deleted"
  | "source-deleted-partial"
  | "source-modified-pattern"
  | "source-modified-reference"
  | "source-modified-none";

export type MainlineRecipeImpactSuggestedAction = "update" | "deprecate" | "verify" | "none";

export interface MainlineRecipeImpact {
  readonly recipeId: string;
  readonly recipeTitle: string;
  readonly changedPath: string;
  readonly reason: MainlineRecipeImpactReason;
  readonly impactLevel: MainlineRecipeImpactLevel;
  readonly impactScore: number;
  readonly matchedTokens: readonly string[];
  readonly suggestedAction: MainlineRecipeImpactSuggestedAction;
  readonly sourceRefIds: readonly string[];
}

export type MainlineRecipeImpactIgnoredReason =
  | "no-recipe-reference"
  | "recipe-not-trackable"
  | "created-file";

export interface MainlineRecipeImpactIgnored {
  readonly changedPath: string;
  readonly reason: MainlineRecipeImpactIgnoredReason;
}

export interface MainlineRecipeImpactPlanSummary {
  readonly totalChangedFiles: number;
  readonly filesWithRecipeRef: number;
  readonly impactCount: number;
  readonly ignoredCount: number;
  readonly patternImpactCount: number;
  readonly referenceImpactCount: number;
  readonly byReason: Record<string, number>;
  readonly byAction: Record<string, number>;
}

export interface MainlineRecipeImpactPlan {
  readonly impacts: readonly MainlineRecipeImpact[];
  readonly ignored: readonly MainlineRecipeImpactIgnored[];
  readonly summary: MainlineRecipeImpactPlanSummary;
}

export function createEmptyMainlineRecipeImpactPlan(): MainlineRecipeImpactPlan {
  return {
    impacts: [],
    ignored: [],
    summary: summarizeMainlineRecipeImpacts({
      changedFiles: [],
      impacts: [],
      ignored: [],
    }),
  };
}

const IMPACT_REASON_PRIORITY: Record<MainlineRecipeImpactReason, number> = {
  "source-deleted": 5,
  "source-deleted-partial": 4,
  "source-modified-pattern": 3,
  "source-modified-reference": 2,
  "source-modified-none": 1,
};

/**
 * 将同一 Recipe 的多文件影响合并成候选摘要。
 * 增量流水线可以用这个轻量结果决定是否进入后续 AI 审查，而不绑定旧 proposal 流程。
 */
export function mainlineRecipeImpactCandidates(
  plan: MainlineRecipeImpactPlan,
): MainlineRecipeImpact[] {
  const byRecipe = new Map<string, MainlineRecipeImpact>();
  for (const impact of plan.impacts) {
    const current = byRecipe.get(impact.recipeId);
    if (!current) {
      byRecipe.set(impact.recipeId, impact);
      continue;
    }
    byRecipe.set(impact.recipeId, mergeRecipeImpact(current, impact));
  }
  return [...byRecipe.values()].sort(compareRecipeImpacts);
}

export function summarizeMainlineRecipeImpacts(input: {
  readonly changedFiles: readonly string[];
  readonly impacts: readonly MainlineRecipeImpact[];
  readonly ignored: readonly MainlineRecipeImpactIgnored[];
}): MainlineRecipeImpactPlanSummary {
  const byReason: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  const filesWithRecipeRef = new Set(input.impacts.map((impact) => impact.changedPath));

  for (const impact of input.impacts) {
    byReason[impact.reason] = (byReason[impact.reason] ?? 0) + 1;
    byAction[impact.suggestedAction] = (byAction[impact.suggestedAction] ?? 0) + 1;
  }

  return {
    totalChangedFiles: input.changedFiles.length,
    filesWithRecipeRef: filesWithRecipeRef.size,
    impactCount: input.impacts.length,
    ignoredCount: input.ignored.length,
    patternImpactCount: input.impacts.filter((impact) => impact.impactLevel === "pattern").length,
    referenceImpactCount: input.impacts.filter((impact) => impact.impactLevel === "reference")
      .length,
    byReason,
    byAction,
  };
}

function mergeRecipeImpact(
  left: MainlineRecipeImpact,
  right: MainlineRecipeImpact,
): MainlineRecipeImpact {
  const reason =
    IMPACT_REASON_PRIORITY[right.reason] > IMPACT_REASON_PRIORITY[left.reason]
      ? right.reason
      : left.reason;
  const representative =
    compareImpactLevel(right.impactLevel, left.impactLevel) > 0 ||
    (right.impactLevel === left.impactLevel && right.impactScore > left.impactScore)
      ? right
      : left;
  return {
    ...representative,
    reason,
    changedPath: uniqueSorted([left.changedPath, right.changedPath]).join(","),
    impactScore: Math.max(left.impactScore, right.impactScore),
    matchedTokens: uniqueSorted([...left.matchedTokens, ...right.matchedTokens]),
    sourceRefIds: uniqueSorted([...left.sourceRefIds, ...right.sourceRefIds]),
    suggestedAction: mergeSuggestedAction(left.suggestedAction, right.suggestedAction),
  };
}

function mergeSuggestedAction(
  left: MainlineRecipeImpactSuggestedAction,
  right: MainlineRecipeImpactSuggestedAction,
): MainlineRecipeImpactSuggestedAction {
  const priority: Record<MainlineRecipeImpactSuggestedAction, number> = {
    deprecate: 4,
    update: 3,
    verify: 2,
    none: 1,
  };
  return priority[right] > priority[left] ? right : left;
}

function compareImpactLevel(
  left: MainlineRecipeImpactLevel,
  right: MainlineRecipeImpactLevel,
): number {
  const priority: Record<MainlineRecipeImpactLevel, number> = {
    pattern: 3,
    reference: 2,
    none: 1,
  };
  return priority[left] - priority[right];
}

function compareRecipeImpacts(left: MainlineRecipeImpact, right: MainlineRecipeImpact): number {
  return (
    IMPACT_REASON_PRIORITY[right.reason] - IMPACT_REASON_PRIORITY[left.reason] ||
    right.impactScore - left.impactScore ||
    left.recipeId.localeCompare(right.recipeId) ||
    left.changedPath.localeCompare(right.changedPath)
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
