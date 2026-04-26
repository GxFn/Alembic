import { describe, expect, test } from 'vitest';
import {
  type BootstrapExistingRecipe,
  getBootstrapDimensionExistingRecipes,
  prepareBootstrapRescanState,
  projectBootstrapDimensionRescanContext,
  projectBootstrapExistingRecipesForPrompt,
} from '#workflows/bootstrap/context/BootstrapRescanState.js';

const recipes: BootstrapExistingRecipe[] = [
  {
    id: 'healthy-api',
    title: 'API Contract',
    trigger: 'api_change',
    knowledgeType: 'api',
    status: 'healthy',
    auditScore: 0.9,
    auditEvidence: { file: 'src/api.ts' },
    sourceRefs: ['src/api.ts'],
  },
  {
    id: 'decaying-api',
    title: 'Old API',
    trigger: 'old_api',
    knowledgeType: 'api',
    status: 'decaying',
    decayReason: 'outdated',
  },
  {
    id: 'healthy-ui',
    title: 'UI Pattern',
    trigger: 'ui_change',
    knowledgeType: 'ui',
  },
];

describe('bootstrap rescan state', () => {
  test('prepares dedup sets and rescan context from existing recipes', () => {
    const state = prepareBootstrapRescanState({
      existingRecipes: recipes,
      evolutionPrescreen: { done: true },
    });

    expect(state.globalSubmittedTitles.has('api contract')).toBe(true);
    expect(state.globalSubmittedTitles.has('old api')).toBe(false);
    expect(state.globalSubmittedTriggers).toEqual(new Set(['api_change', 'old_api', 'ui_change']));
    expect(state.globalSubmittedPatterns.size).toBe(0);
    expect(state.rescanContext?.existingRecipes.map((recipe) => recipe.id)).toEqual([
      'healthy-api',
      'healthy-ui',
    ]);
    expect(state.rescanContext?.decayingRecipes.map((recipe) => recipe.id)).toEqual([
      'decaying-api',
    ]);
    expect(state.rescanContext?.coverageByDim).toEqual({ api: 1, ui: 1 });
    expect(state.rescanContext?.evolutionPrescreen).toEqual({ done: true });
    expect(state.bootstrapDedup).toBeTruthy();
  });

  test('projects dimension rescan context and existing recipes', () => {
    const { rescanContext } = prepareBootstrapRescanState({
      existingRecipes: recipes,
      evolutionPrescreen: null,
    });

    expect(
      getBootstrapDimensionExistingRecipes({ rescanContext, dimId: 'api' }).map((r) => r.id)
    ).toEqual(['healthy-api', 'decaying-api']);
    expect(projectBootstrapDimensionRescanContext({ rescanContext, dimId: 'api' })).toMatchObject({
      existingRecipes: [expect.objectContaining({ id: 'healthy-api' })],
      decayingRecipes: [expect.objectContaining({ id: 'decaying-api' })],
      occupiedTriggers: ['api_change', 'old_api', 'ui_change'],
      gap: 4,
      existing: 1,
    });
  });

  test('projects existing recipes for prompt audit hints', () => {
    expect(projectBootstrapExistingRecipesForPrompt(recipes.slice(0, 2))).toEqual([
      expect.objectContaining({
        id: 'healthy-api',
        auditHint: {
          relevanceScore: 0.9,
          verdict: 'watch',
          evidence: { file: 'src/api.ts' },
          decayReasons: [],
        },
      }),
      expect.objectContaining({
        id: 'decaying-api',
        auditHint: null,
      }),
    ]);
  });

  test('handles missing existing recipes', () => {
    const state = prepareBootstrapRescanState({ existingRecipes: null, evolutionPrescreen: null });
    expect(state.existingRecipesList).toBeNull();
    expect(state.rescanContext).toBeNull();
    expect(
      projectBootstrapDimensionRescanContext({ rescanContext: null, dimId: 'api' })
    ).toBeNull();
  });
});
