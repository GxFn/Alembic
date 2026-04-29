import type { RecipeSnapshotEntry } from '#service/cleanup/CleanupService.js';
import type {
  RelevanceAuditResult,
  RelevanceAuditSummary,
} from '#service/evolution/RelevanceAuditor.js';
import type { DimensionDef } from '#types/project-snapshot.js';

export const TARGET_RECIPES_PER_DIMENSION = 5;

export type AuditVerdict = RelevanceAuditResult['verdict'];

export type RescanExecutionReasonKind =
  | 'manual-request'
  | 'coverage-gap'
  | 'recipe-decay'
  | 'file-change'
  | 'fully-covered';

export interface RescanExecutionReason {
  kind: RescanExecutionReasonKind;
  recipeIds?: string[];
  changedFiles?: string[];
  existing?: number;
  target?: number;
  gap?: number;
  detail?: string;
}

export interface KnowledgeRescanDimensionPlan {
  dimension: DimensionDef;
  existingCount: number;
  gap: number;
  existingRecipes: RecipeSnapshotEntry[];
  decayingRecipes: RecipeSnapshotEntry[];
  executionReasons: RescanExecutionReason[];
  shouldExecute: boolean;
}

export interface KnowledgeRescanPlan {
  recipeEntries: RecipeSnapshotEntry[];
  auditSummary: RelevanceAuditSummary;
  auditVerdictMap: Map<string, AuditVerdict>;
  targetPerDimension: number;
  requestedDimensionIds?: string[];
  requestedDimensions: DimensionDef[];
  skippedByRequestDimensions: DimensionDef[];
  dimensionPlans: KnowledgeRescanDimensionPlan[];
  executionDimensions: DimensionDef[];
  gapDimensions: DimensionDef[];
  skippedDimensions: DimensionDef[];
  coverageByDimension: Record<string, number>;
  executionReasons: Record<string, RescanExecutionReason[]>;
  occupiedTriggers: string[];
  decayingRecipeIds: string[];
}

export interface BuildKnowledgeRescanPlanOptions {
  recipeEntries: RecipeSnapshotEntry[];
  auditSummary: RelevanceAuditSummary;
  dimensions: DimensionDef[];
  requestedDimensionIds?: string[];
  targetPerDimension?: number;
  fileDiff?: {
    affectedDimensionIds?: string[];
    changedFiles?: string[];
  } | null;
}

export function buildKnowledgeRescanPlan({
  recipeEntries,
  auditSummary,
  dimensions,
  requestedDimensionIds,
  targetPerDimension = TARGET_RECIPES_PER_DIMENSION,
  fileDiff,
}: BuildKnowledgeRescanPlanOptions): KnowledgeRescanPlan {
  const requestedIds = requestedDimensionIds?.length ? new Set(requestedDimensionIds) : null;
  const requestedDimensions = requestedIds
    ? dimensions.filter((dimension) => requestedIds.has(dimension.id))
    : [...dimensions];
  const skippedByRequestDimensions = requestedIds
    ? dimensions.filter((dimension) => !requestedIds.has(dimension.id))
    : [];

  const auditVerdictMap = new Map(
    auditSummary.results.map((result) => [result.recipeId, result.verdict])
  );
  const auditResultByRecipeId = new Map(
    auditSummary.results.map((result) => [result.recipeId, result])
  );
  const coverageByDimension = buildCoverageByDimension({ recipeEntries, auditVerdictMap });
  const affectedDimensionIds = new Set(fileDiff?.affectedDimensionIds ?? []);
  const changedFiles = fileDiff?.changedFiles ?? [];
  const dimensionPlans = requestedDimensions.map((dimension) => {
    const existingRecipes = recipeEntries.filter((entry) => entry.knowledgeType === dimension.id);
    const decayingRecipes = existingRecipes.filter((entry) =>
      isRecipeDecaying(entry, auditResultByRecipeId.get(entry.id), auditVerdictMap.get(entry.id))
    );
    const existingCount = coverageByDimension[dimension.id] || 0;
    const gap = Math.max(0, targetPerDimension - existingCount);
    const executionReasons = buildDimensionExecutionReasons({
      dimension,
      requestedIds,
      affectedDimensionIds,
      changedFiles,
      decayingRecipes,
      existingCount,
      targetPerDimension,
      gap,
    });
    const shouldExecute = executionReasons.some(
      (reason) => reason.kind !== 'manual-request' && reason.kind !== 'fully-covered'
    );

    return {
      dimension,
      existingCount,
      gap,
      existingRecipes,
      decayingRecipes,
      executionReasons,
      shouldExecute,
    };
  });

  const gapDimensions = dimensionPlans
    .filter((dimensionPlan) => dimensionPlan.gap > 0)
    .map((dimensionPlan) => dimensionPlan.dimension);
  const executionDimensions = dimensionPlans
    .filter((dimensionPlan) => dimensionPlan.shouldExecute)
    .map((dimensionPlan) => dimensionPlan.dimension);
  const skippedDimensions = dimensionPlans
    .filter((dimensionPlan) => !dimensionPlan.shouldExecute)
    .map((dimensionPlan) => dimensionPlan.dimension);
  const executionReasons = Object.fromEntries(
    dimensionPlans.map((dimensionPlan) => [
      dimensionPlan.dimension.id,
      dimensionPlan.executionReasons,
    ])
  );
  const occupiedTriggers = recipeEntries.map((entry) => entry.trigger).filter(Boolean);
  const decayingRecipeIds = dimensionPlans.flatMap((dimensionPlan) =>
    dimensionPlan.decayingRecipes.map((recipe) => recipe.id)
  );

  return {
    recipeEntries,
    auditSummary,
    auditVerdictMap,
    targetPerDimension,
    requestedDimensionIds,
    requestedDimensions,
    skippedByRequestDimensions,
    dimensionPlans,
    executionDimensions,
    gapDimensions,
    skippedDimensions,
    coverageByDimension,
    executionReasons,
    occupiedTriggers,
    decayingRecipeIds,
  };
}

function buildCoverageByDimension({
  recipeEntries,
  auditVerdictMap,
}: {
  recipeEntries: RecipeSnapshotEntry[];
  auditVerdictMap: Map<string, AuditVerdict>;
}): Record<string, number> {
  const coverageByDimension: Record<string, number> = {};

  for (const entry of recipeEntries) {
    const dimensionId = entry.knowledgeType || 'unknown';
    const isConfirmed = entry.lifecycle === 'active' || entry.lifecycle === 'evolving';
    const verdict = auditVerdictMap.get(entry.id);
    const isHealthyStaging =
      entry.lifecycle === 'staging' && (!verdict || verdict === 'healthy' || verdict === 'watch');

    if (isConfirmed || isHealthyStaging) {
      coverageByDimension[dimensionId] = (coverageByDimension[dimensionId] || 0) + 1;
    }
  }

  return coverageByDimension;
}

function buildDimensionExecutionReasons({
  dimension,
  requestedIds,
  affectedDimensionIds,
  changedFiles,
  decayingRecipes,
  existingCount,
  targetPerDimension,
  gap,
}: {
  dimension: DimensionDef;
  requestedIds: Set<string> | null;
  affectedDimensionIds: Set<string>;
  changedFiles: string[];
  decayingRecipes: RecipeSnapshotEntry[];
  existingCount: number;
  targetPerDimension: number;
  gap: number;
}): RescanExecutionReason[] {
  const reasons: RescanExecutionReason[] = [];
  if (requestedIds?.has(dimension.id)) {
    reasons.push({ kind: 'manual-request', detail: 'Dimension explicitly requested by caller' });
  }
  if (affectedDimensionIds.has(dimension.id)) {
    reasons.push({ kind: 'file-change', changedFiles });
  }
  if (decayingRecipes.length > 0) {
    reasons.push({
      kind: 'recipe-decay',
      recipeIds: decayingRecipes.map((recipe) => recipe.id),
      detail: `${decayingRecipes.length} recipes require verification or evolution`,
    });
  }
  if (gap > 0) {
    reasons.push({
      kind: 'coverage-gap',
      existing: existingCount,
      target: targetPerDimension,
      gap,
    });
  }
  if (reasons.length === 0 || reasons.every((reason) => reason.kind === 'manual-request')) {
    reasons.push({
      kind: 'fully-covered',
      existing: existingCount,
      target: targetPerDimension,
    });
  }
  return reasons;
}

function isRecipeDecaying(
  entry: RecipeSnapshotEntry,
  auditResult: RelevanceAuditResult | undefined,
  verdict: AuditVerdict | undefined
): boolean {
  return (
    entry.lifecycle === 'decaying' ||
    verdict === 'decay' ||
    verdict === 'severe' ||
    auditResult?.verdict === 'decay' ||
    auditResult?.verdict === 'severe'
  );
}
