import type { Recipe, SourceRef } from "../knowledge/index.js";
import type { MainlineReverseHealthResult } from "./MainlineReverseHealthCheck.js";

export type MainlineDecaySignalStrategy =
  | "no_recent_usage"
  | "high_false_positive"
  | "symbol_drift"
  | "source_ref_stale"
  | "superseded"
  | "contradiction";

export type MainlineDecayLevel = "healthy" | "watch" | "decay" | "severe" | "dead";

export interface MainlineDecaySignal {
  readonly recipeId: string;
  readonly strategy: MainlineDecaySignalStrategy;
  readonly detail: string;
}

export interface MainlineDecayScoreDimensions {
  readonly freshness: number;
  readonly usage: number;
  readonly quality: number;
  readonly authority: number;
}

export interface MainlineDecayPolicyInput {
  readonly recipe: Recipe;
  readonly sourceRefs?: readonly SourceRef[];
  readonly reverseHealth?: MainlineReverseHealthResult | null;
  readonly now?: number;
}

export interface MainlineDecayPolicyResult {
  readonly recipeId: string;
  readonly title: string;
  readonly decayScore: number;
  readonly level: MainlineDecayLevel;
  readonly signals: readonly MainlineDecaySignal[];
  readonly dimensions: MainlineDecayScoreDimensions;
  readonly suggestedGracePeriodMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_SECONDS = 24 * 60 * 60;
const GRACE_PERIOD_STANDARD_MS = 30 * DAY_MS;
const GRACE_PERIOD_SEVERE_MS = 15 * DAY_MS;

const DECAY_THRESHOLDS = {
  NO_USAGE_DAYS: 90,
  FALSE_POSITIVE_RATE: 0.4,
  MIN_FP_TRIGGERS: 10,
} as const;

const SCORE_WEIGHTS = {
  freshness: 0.3,
  usage: 0.3,
  quality: 0.2,
  authority: 0.2,
} as const;

/**
 * MainlineDecayPolicy 是报告型衰退评分。
 * 它保留旧 DecayDetector 的四维权重和 80/60/40/20 分界，但不执行生命周期迁移。
 */
export class MainlineDecayPolicy {
  evaluate(input: MainlineDecayPolicyInput): MainlineDecayPolicyResult {
    const now = normalizeEpochSeconds(input.now ?? Date.now());
    const sourceRefs = input.sourceRefs ?? [];
    const signals = collectDecaySignals(input.recipe, { ...input, sourceRefs, now });
    const dimensions = scoreDimensions(input.recipe, sourceRefs, now);
    const decayScore = Math.round(
      dimensions.freshness * SCORE_WEIGHTS.freshness * 100 +
        dimensions.usage * SCORE_WEIGHTS.usage * 100 +
        dimensions.quality * SCORE_WEIGHTS.quality * 100 +
        dimensions.authority * SCORE_WEIGHTS.authority * 100,
    );
    const level = classifyMainlineDecayScore(decayScore);

    return {
      recipeId: input.recipe.id,
      title: input.recipe.title,
      decayScore,
      level,
      signals,
      dimensions,
      suggestedGracePeriodMs:
        level === "dead"
          ? 0
          : level === "severe"
            ? GRACE_PERIOD_SEVERE_MS
            : GRACE_PERIOD_STANDARD_MS,
    };
  }
}

export function classifyMainlineDecayScore(score: number): MainlineDecayLevel {
  if (score >= 80) {
    return "healthy";
  }
  if (score >= 60) {
    return "watch";
  }
  if (score >= 40) {
    return "decay";
  }
  if (score >= 20) {
    return "severe";
  }
  return "dead";
}

function collectDecaySignals(
  recipe: Recipe,
  context: {
    readonly sourceRefs: readonly SourceRef[];
    readonly reverseHealth?: MainlineReverseHealthResult | null;
    readonly now: number;
  },
): MainlineDecaySignal[] {
  const signals: MainlineDecaySignal[] = [];
  const usage = recipe.knowledge?.usage;
  const lastHitAt = normalizeEpochSeconds(usage?.lastHitAt ?? usage?.lastSearchedAt ?? 0);
  const createdAt = normalizeEpochSeconds(
    recipe.knowledge?.governance.createdAt ?? recipe.updatedAt ?? 0,
  );

  if (lastHitAt) {
    const daysSince = (context.now - lastHitAt) / DAY_SECONDS;
    if (daysSince > DECAY_THRESHOLDS.NO_USAGE_DAYS) {
      signals.push(signal(recipe, "no_recent_usage", `No usage in ${Math.round(daysSince)} days.`));
    }
  } else if (createdAt) {
    const daysSinceCreation = (context.now - createdAt) / DAY_SECONDS;
    if (daysSinceCreation > DECAY_THRESHOLDS.NO_USAGE_DAYS) {
      signals.push(
        signal(
          recipe,
          "no_recent_usage",
          `Never used, created ${Math.round(daysSinceCreation)} days ago.`,
        ),
      );
    }
  }

  const fpRate = usage?.ruleFalsePositiveRate ?? 0;
  const guardHits = usage?.guardHits ?? 0;
  if (
    fpRate > DECAY_THRESHOLDS.FALSE_POSITIVE_RATE &&
    guardHits >= DECAY_THRESHOLDS.MIN_FP_TRIGGERS
  ) {
    signals.push(
      signal(
        recipe,
        "high_false_positive",
        `False positive rate ${(fpRate * 100).toFixed(0)}% with ${guardHits} guard hits.`,
      ),
    );
  }

  const staleRefs = staleSourceRefs(recipe, context.sourceRefs);
  if (staleRefs.length > 0) {
    signals.push(
      signal(recipe, "source_ref_stale", `${staleRefs.length} SourceRef(s) need refresh.`),
    );
  }

  if (
    context.reverseHealth?.signals.some(
      (item) => item.type === "symbol_missing" || item.type === "zero_match",
    )
  ) {
    signals.push(
      signal(
        recipe,
        "symbol_drift",
        `Reverse health reported ${context.reverseHealth.recommendation}.`,
      ),
    );
  }

  if (recipe.status === "superseded") {
    signals.push(signal(recipe, "superseded", "Recipe status is superseded."));
  }

  return signals;
}

function scoreDimensions(
  recipe: Recipe,
  sourceRefs: readonly SourceRef[],
  now: number,
): MainlineDecayScoreDimensions {
  const usage = recipe.knowledge?.usage;
  const lastHitAt = normalizeEpochSeconds(usage?.lastHitAt ?? usage?.lastSearchedAt ?? 0);
  const daysSinceHit = lastHitAt ? Math.max(0, (now - lastHitAt) / DAY_SECONDS) : 365;
  const staleRatio = recipe.sourceRefIds.length
    ? staleSourceRefs(recipe, sourceRefs).length / recipe.sourceRefIds.length
    : 0;
  const baseQuality =
    normalizeOptionalPercent(recipe.knowledge?.quality.overall) ??
    normalizeOptionalPercent(recipe.confidence) ??
    0.5;

  return {
    freshness: clamp01(1 - daysSinceHit / 365),
    usage: clamp01((usage?.hitsLast90d ?? usage?.searchHitsLast30d ?? 0) / 50),
    quality: clamp01(baseQuality * (1 - staleRatio * 0.3)),
    authority: normalizeOptionalPercent(usage?.authority) ?? 0.5,
  };
}

function staleSourceRefs(recipe: Recipe, sourceRefs: readonly SourceRef[]): SourceRef[] {
  const ids = new Set(recipe.sourceRefIds);
  return sourceRefs.filter(
    (sourceRef) =>
      ids.has(sourceRef.id) &&
      (sourceRef.status === "stale" ||
        sourceRef.status === "missing" ||
        sourceRef.status === "unknown"),
  );
}

function signal(
  recipe: Recipe,
  strategy: MainlineDecaySignalStrategy,
  detail: string,
): MainlineDecaySignal {
  return { recipeId: recipe.id, strategy, detail };
}

function normalizeOptionalPercent(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value > 1 ? clamp01(value / 100) : clamp01(value);
}

function normalizeEpochSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
