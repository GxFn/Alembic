import type { RecipeSnapshotEntry } from '#service/cleanup/CleanupService.js';
import type { RelevanceAuditSummary } from '#service/evolution/RelevanceAuditor.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import type {
  AuditVerdict,
  KnowledgeRescanPlan,
  RescanExecutionReason,
} from '#workflows/common-capabilities/knowledge-rescan/KnowledgeRescanPlanBuilder.js';

export interface InternalRescanGapPlan {
  requestedDimensions: DimensionDef[];
  executionDimensions: DimensionDef[];
  gapDimensions: DimensionDef[];
  skippedDimensions: DimensionDef[];
  coverageByDimension: Record<string, number>;
  auditVerdictMap: Map<string, AuditVerdict>;
  executionReasons: Record<string, RescanExecutionReason[]>;
  targetPerDimension: number;
}

export interface ExternalDimensionGap {
  dimensionId: string;
  existingCount: number;
  gap: number;
  existingTriggers: string[];
  executionReasons: RescanExecutionReason[];
}

export interface ExternalRescanEvidencePlan {
  allRecipes: Array<{
    id: string;
    title: string;
    trigger: string;
    knowledgeType: string;
    doClause: string;
    lifecycle: string;
    content: { markdown: string; rationale: string; coreCode: string } | null;
    sourceRefs: string[];
    auditHint: {
      relevanceScore: number;
      verdict: 'healthy' | 'watch' | 'decay' | 'severe';
      decayReasons: string[];
    };
  }>;
  dimensionGaps: ExternalDimensionGap[];
  executionReasons: Record<string, RescanExecutionReason[]>;
  totalGap: number;
  decayCount: number;
  occupiedTriggers: string[];
  coveredDimensions: number;
  gapSummary: string;
}

export function projectInternalRescanGapPlan(plan: KnowledgeRescanPlan): InternalRescanGapPlan {
  return {
    requestedDimensions: plan.requestedDimensions,
    executionDimensions: plan.executionDimensions,
    gapDimensions: plan.gapDimensions,
    skippedDimensions: plan.skippedDimensions,
    coverageByDimension: plan.coverageByDimension,
    auditVerdictMap: plan.auditVerdictMap,
    executionReasons: plan.executionReasons,
    targetPerDimension: plan.targetPerDimension,
  };
}

export function projectInternalRescanPromptRecipes(plan: KnowledgeRescanPlan) {
  return projectInternalRescanPromptRecipesFromParts({
    recipeEntries: plan.recipeEntries,
    auditSummary: plan.auditSummary,
    auditVerdictMap: plan.auditVerdictMap,
  });
}

export function projectInternalRescanPromptRecipesFromParts(opts: {
  recipeEntries: RecipeSnapshotEntry[];
  auditSummary: RelevanceAuditSummary;
  auditVerdictMap: Map<string, AuditVerdict>;
}): Array<{
  id: string;
  title: string;
  trigger: string;
  knowledgeType: string;
  status: 'decaying' | 'healthy';
  decayReason?: string;
  auditScore?: number;
  content?: { markdown?: string; rationale?: string; coreCode?: string };
  sourceRefs?: string[];
  auditEvidence?: Record<string, unknown>;
}> {
  return opts.recipeEntries.map((entry) => {
    const auditResult = opts.auditSummary.results.find((result) => result.recipeId === entry.id);
    const verdict = opts.auditVerdictMap.get(entry.id);
    const isDecaying =
      entry.lifecycle === 'decaying' || verdict === 'decay' || verdict === 'severe';

    return {
      id: entry.id,
      title: entry.title,
      trigger: entry.trigger,
      knowledgeType: entry.knowledgeType,
      status: isDecaying ? 'decaying' : 'healthy',
      decayReason:
        isDecaying && auditResult?.decayReasons ? auditResult.decayReasons.join('; ') : undefined,
      auditScore: auditResult?.relevanceScore,
      content: entry.content,
      sourceRefs: entry.sourceRefs,
      auditEvidence: auditResult?.evidence,
    };
  });
}

export function projectExternalRescanEvidencePlan(
  plan: KnowledgeRescanPlan
): ExternalRescanEvidencePlan {
  const snapshotById = new Map(plan.recipeEntries.map((entry) => [entry.id, entry]));
  const allRecipes = plan.auditSummary.results
    .filter((result) => result.verdict !== 'dead')
    .map((result) => {
      const snapshotEntry = snapshotById.get(result.recipeId);
      const content = snapshotEntry?.content;
      return {
        id: result.recipeId,
        title: result.title,
        trigger: snapshotEntry?.trigger || '',
        knowledgeType: snapshotEntry?.knowledgeType || '',
        doClause: snapshotEntry?.doClause || '',
        lifecycle: snapshotEntry?.lifecycle || 'active',
        content: content
          ? {
              markdown: truncate(content.markdown, 500),
              rationale: truncate(content.rationale, 200),
              coreCode: truncate(content.coreCode, 400),
            }
          : null,
        sourceRefs: (snapshotEntry?.sourceRefs ?? []).slice(0, 5),
        auditHint: {
          relevanceScore: result.relevanceScore,
          verdict: result.verdict as 'healthy' | 'watch' | 'decay' | 'severe',
          decayReasons: result.decayReasons || [],
        },
      };
    });

  const dimensionGaps = plan.dimensionPlans.map((dimensionPlan) => ({
    dimensionId: dimensionPlan.dimension.id,
    existingCount: dimensionPlan.existingCount,
    gap: dimensionPlan.gap,
    existingTriggers: dimensionPlan.existingRecipes.map((entry) => entry.trigger).filter(Boolean),
    executionReasons: dimensionPlan.executionReasons,
  }));
  const totalGap = dimensionGaps.reduce((sum, dimensionGap) => sum + dimensionGap.gap, 0);
  const decayCount = allRecipes.filter(
    (recipe) => recipe.auditHint.verdict === 'decay' || recipe.auditHint.verdict === 'severe'
  ).length;
  const coveredDimensions = dimensionGaps.filter((dimensionGap) => dimensionGap.gap === 0).length;
  const gapSummaryParts = dimensionGaps
    .filter((dimensionGap) => dimensionGap.gap > 0)
    .map((dimensionGap) => `${dimensionGap.dimensionId}(需补${dimensionGap.gap}条)`);
  const gapSummary =
    gapSummaryParts.length > 0
      ? `需补齐维度: ${gapSummaryParts.join('、')}。`
      : '所有维度已充分覆盖，仅在发现全新模式时提交。';

  return {
    allRecipes,
    dimensionGaps,
    executionReasons: plan.executionReasons,
    totalGap,
    decayCount,
    occupiedTriggers: plan.occupiedTriggers,
    coveredDimensions,
    gapSummary,
  };
}

function truncate(value: string | undefined | null, max: number): string {
  if (!value) {
    return '';
  }
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
