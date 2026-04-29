import { describe, expect, test } from 'vitest';
import type { RecipeSnapshotEntry } from '#service/cleanup/CleanupService.js';
import type {
  RelevanceAuditResult,
  RelevanceAuditSummary,
} from '#service/evolution/RelevanceAuditor.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import { buildKnowledgeRescanPlan } from '#workflows/capabilities/planning/knowledge/KnowledgeRescanPlanBuilder.js';
import {
  projectExternalRescanEvidencePlan,
  projectInternalRescanGapPlan,
  projectInternalRescanPromptRecipes,
} from '#workflows/capabilities/planning/knowledge/RescanEvidenceProjectors.js';

const dimensions: DimensionDef[] = [
  { id: 'api', label: 'API' },
  { id: 'ui', label: 'UI' },
  { id: 'storage', label: 'Storage' },
  { id: 'network', label: 'Network' },
];

const recipes: RecipeSnapshotEntry[] = [
  recipe({ id: 'api-active', title: 'API Active', trigger: '@api-active', knowledgeType: 'api' }),
  recipe({
    id: 'api-severe',
    title: 'API Severe',
    trigger: '@api-severe',
    knowledgeType: 'api',
  }),
  recipe({
    id: 'ui-staging-watch',
    title: 'UI Staging Watch',
    trigger: '@ui-watch',
    knowledgeType: 'ui',
    lifecycle: 'staging',
  }),
  recipe({
    id: 'ui-staging-decay',
    title: 'UI Staging Decay',
    trigger: '@ui-decay',
    knowledgeType: 'ui',
    lifecycle: 'staging',
  }),
  recipe({
    id: 'storage-a',
    title: 'Storage A',
    trigger: '@storage-a',
    knowledgeType: 'storage',
  }),
  recipe({
    id: 'storage-b',
    title: 'Storage B',
    trigger: '@storage-b',
    knowledgeType: 'storage',
  }),
  recipe({
    id: 'network-dead',
    title: 'Network Dead',
    trigger: '@network-dead',
    knowledgeType: 'network',
  }),
];

const auditSummary: RelevanceAuditSummary = {
  totalAudited: recipes.length,
  healthy: 3,
  watch: 1,
  decay: 1,
  severe: 1,
  dead: 1,
  proposalsCreated: 0,
  immediateDeprecated: 0,
  results: [
    result('api-active', 'API Active', 'healthy'),
    result('api-severe', 'API Severe', 'severe', ['symbols missing']),
    result('ui-staging-watch', 'UI Staging Watch', 'watch'),
    result('ui-staging-decay', 'UI Staging Decay', 'decay', ['source changed']),
    result('storage-a', 'Storage A', 'healthy'),
    result('storage-b', 'Storage B', 'healthy'),
    result('network-dead', 'Network Dead', 'dead', ['source removed']),
  ],
};

describe('KnowledgeRescanPlan', () => {
  test('builds a domain plan with coverage, decay, manual request, and skip reasons', () => {
    const plan = buildKnowledgeRescanPlan({
      recipeEntries: recipes,
      auditSummary,
      dimensions,
      requestedDimensionIds: ['api', 'ui', 'storage'],
      targetPerDimension: 2,
    });

    expect(plan.requestedDimensions.map((dimension) => dimension.id)).toEqual([
      'api',
      'ui',
      'storage',
    ]);
    expect(plan.skippedByRequestDimensions.map((dimension) => dimension.id)).toEqual(['network']);
    expect(plan.coverageByDimension).toMatchObject({ api: 2, ui: 1, storage: 2 });
    expect(plan.gapDimensions.map((dimension) => dimension.id)).toEqual(['ui']);
    expect(plan.executionDimensions.map((dimension) => dimension.id)).toEqual(['api', 'ui']);
    expect(plan.skippedDimensions.map((dimension) => dimension.id)).toEqual(['storage']);
    expect(plan.executionReasons.api.map((reason) => reason.kind)).toEqual([
      'manual-request',
      'recipe-decay',
    ]);
    expect(plan.executionReasons.ui.map((reason) => reason.kind)).toEqual([
      'manual-request',
      'recipe-decay',
      'coverage-gap',
    ]);
    expect(plan.executionReasons.storage.map((reason) => reason.kind)).toEqual([
      'manual-request',
      'fully-covered',
    ]);
    expect(plan.occupiedTriggers).toContain('@ui-decay');
  });

  test('projects internal execution dimensions from the shared domain plan', () => {
    const plan = buildKnowledgeRescanPlan({
      recipeEntries: recipes,
      auditSummary,
      dimensions,
      requestedDimensionIds: ['api', 'ui', 'storage'],
      targetPerDimension: 2,
    });
    const gapPlan = projectInternalRescanGapPlan(plan);
    const promptRecipes = projectInternalRescanPromptRecipes(plan);

    expect(gapPlan.targetPerDimension).toBe(2);
    expect(gapPlan.executionDimensions.map((dimension) => dimension.id)).toEqual(['api', 'ui']);
    expect(gapPlan.gapDimensions.map((dimension) => dimension.id)).toEqual(['ui']);
    expect(gapPlan.skippedDimensions.map((dimension) => dimension.id)).toEqual(['storage']);
    expect(promptRecipes.find((entry) => entry.id === 'api-severe')).toMatchObject({
      status: 'decaying',
      decayReason: 'symbols missing',
    });
  });

  test('projects external evidence from the same domain plan', () => {
    const plan = buildKnowledgeRescanPlan({
      recipeEntries: recipes,
      auditSummary,
      dimensions,
      requestedDimensionIds: ['api', 'ui', 'storage'],
      targetPerDimension: 2,
    });
    const evidencePlan = projectExternalRescanEvidencePlan(plan);

    expect(evidencePlan.allRecipes.map((entry) => entry.id)).not.toContain('network-dead');
    expect(evidencePlan.dimensionGaps).toEqual([
      expect.objectContaining({ dimensionId: 'api', existingCount: 2, gap: 0 }),
      expect.objectContaining({ dimensionId: 'ui', existingCount: 1, gap: 1 }),
      expect.objectContaining({ dimensionId: 'storage', existingCount: 2, gap: 0 }),
    ]);
    expect(evidencePlan.totalGap).toBe(1);
    expect(evidencePlan.coveredDimensions).toBe(2);
    expect(evidencePlan.decayCount).toBe(2);
    expect(evidencePlan.executionReasons.ui.map((reason) => reason.kind)).toContain('coverage-gap');
    expect(evidencePlan.occupiedTriggers).toContain('@network-dead');
  });
});

function recipe(opts: Partial<RecipeSnapshotEntry> & Pick<RecipeSnapshotEntry, 'id'>) {
  return {
    title: opts.title ?? opts.id,
    trigger: opts.trigger ?? `@${opts.id}`,
    category: opts.category ?? 'architecture',
    knowledgeType: opts.knowledgeType ?? 'api',
    doClause: opts.doClause ?? 'Use the project pattern.',
    lifecycle: opts.lifecycle ?? 'active',
    content: opts.content ?? {
      markdown: `# ${opts.id}`,
      rationale: 'Because the project uses this pattern.',
      coreCode: 'const value = true;',
    },
    sourceRefs: opts.sourceRefs ?? ['src/example.ts'],
    ...opts,
  } satisfies RecipeSnapshotEntry;
}

function result(
  recipeId: string,
  title: string,
  verdict: RelevanceAuditResult['verdict'],
  decayReasons: string[] = []
): RelevanceAuditResult {
  return {
    recipeId,
    title,
    verdict,
    relevanceScore: verdict === 'healthy' ? 0.95 : 0.4,
    evidence: {
      triggerStillMatches: verdict !== 'dead',
      symbolsAlive: verdict === 'healthy' ? 3 : 0,
      depsIntact: verdict === 'healthy',
      codeFilesExist: verdict === 'dead' ? 0 : 1,
    },
    decayReasons,
  };
}
