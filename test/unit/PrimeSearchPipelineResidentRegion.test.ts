import { RECIPE_SEMANTIC_REGION_METADATA_TYPE } from '@alembic/core/vector';
import { describe, expect, test, vi } from 'vitest';
import { normalizeHostIntentContext } from '../../lib/service/task/HostIntentContext.js';
import { extract } from '../../lib/service/task/IntentExtractor.js';
import { buildIntentSearchPlan } from '../../lib/service/task/IntentSearchPlan.js';
import { PrimeSearchPipeline } from '../../lib/service/task/PrimeSearchPipeline.js';

function createIntentPlan(query = 'resident prime region retrieval') {
  const recognizedIntentDraft = {
    confidence: 0.92,
    constraints: ['architecture convention', 'resident vector route'],
    query,
    sourceRefs: ['host:intent'],
    status: 'recognized',
  };
  const hostIntentContext = normalizeHostIntentContext({
    intentContext: { recognizedIntentDraft },
    userQuery: 'fallback prime request',
  });
  return buildIntentSearchPlan({
    hostIntentContext,
    intentContext: { recognizedIntentDraft },
    mode: 'prime',
    rawQuery: 'fallback prime request',
  });
}

function regionHit(recipeId: string, regionClass: string, score: number, content: string) {
  return {
    item: {
      content,
      id: `recipe_region_${recipeId}_${regionClass}_hash`,
      metadata: {
        type: RECIPE_SEMANTIC_REGION_METADATA_TYPE,
        recipeId,
        regionClass,
        title: 'Resident Region Retrieval',
        trigger: '@resident-region-retrieval',
        dimensionId: 'architecture',
        kind: 'pattern',
        knowledgeType: 'code-pattern',
        language: 'typescript',
        sourceRefs: ['lib/service/task/PrimeSearchPipeline.ts:1'],
        sourceRefsBridge: 'active',
        tags: ['prime', 'resident'],
      },
    },
    score,
  };
}

function wholeEntryHit(score = 0.94) {
  return {
    item: {
      content: 'whole entry vector should not admit trusted prime material',
      id: 'entry_recipe-1',
      metadata: {
        entryId: 'recipe-1',
        title: 'Whole Entry',
        type: 'knowledge-entry',
      },
    },
    score,
  };
}

describe('PrimeSearchPipeline resident semantic-region retrieval', () => {
  test('queries recipe semantic-region classes, merges by recipeId, and preserves region evidence', async () => {
    const searchEngine = { search: vi.fn(async () => ({ items: [] })) };
    const vectorService = {
      getStats: vi.fn(async () => ({ count: 9, embedProviderAvailable: true })),
      search: vi.fn(async (_query: string, opts?: { filter?: Record<string, unknown> }) => {
        if (opts?.filter?.regionClass === 'applicability') {
          return [
            regionHit(
              'recipe-1',
              'applicability',
              0.91,
              'Recipe title: Resident Region Retrieval\nWhen: prime needs resident region matching'
            ),
          ];
        }
        if (opts?.filter?.regionClass === 'architectureConvention') {
          return [
            regionHit(
              'recipe-1',
              'architectureConvention',
              0.86,
              'Convention: use generated recipe-semantic-region chunks only'
            ),
          ];
        }
        return [];
      }),
      syncRecipeSemanticRegions: vi.fn(),
    };
    const pipeline = new PrimeSearchPipeline(searchEngine, { vectorService });

    const result = await pipeline.search(extract('implement resident prime region retrieval'), {
      intentSearchPlan: createIntentPlan(),
    });

    expect(searchEngine.search).not.toHaveBeenCalled();
    expect(vectorService.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        filter: expect.objectContaining({
          type: RECIPE_SEMANTIC_REGION_METADATA_TYPE,
          regionClass: 'applicability',
        }),
      })
    );
    expect(vectorService.syncRecipeSemanticRegions).not.toHaveBeenCalled();
    expect(result?.relatedKnowledge).toHaveLength(1);
    expect(result?.relatedKnowledge[0]?.id).toBe('recipe-1');
    expect(result?.searchMeta.residentRegionRetrieval).toMatchObject({
      used: true,
      vectorAvailable: true,
      regionHitCount: 2,
      selectedRecipes: [
        expect.objectContaining({
          recipeId: 'recipe-1',
          matchedRegionClasses: expect.arrayContaining(['applicability', 'architectureConvention']),
        }),
      ],
    });
    expect(result?.searchMeta.primeInjectionPackage).toMatchObject({
      injection: expect.objectContaining({ status: 'ready', selectedCount: 1 }),
      residentRegionRetrieval: expect.objectContaining({ used: true }),
      selectedKnowledge: [
        expect.objectContaining({
          itemId: 'recipe-1',
          matchedRegionClasses: expect.arrayContaining(['applicability', 'architectureConvention']),
          matchedRegions: expect.arrayContaining([
            expect.objectContaining({
              regionClass: 'applicability',
              snippet: expect.stringContaining('prime needs resident region matching'),
            }),
          ]),
        }),
      ],
    });
  });

  test('rejects whole-entry-only vector hits instead of admitting trusted prime material', async () => {
    const searchEngine = { search: vi.fn(async () => ({ items: [] })) };
    const vectorService = {
      getStats: vi.fn(async () => ({ count: 1, embedProviderAvailable: true })),
      search: vi.fn(async () => [wholeEntryHit()]),
      syncRecipeSemanticRegions: vi.fn(),
    };
    const pipeline = new PrimeSearchPipeline(searchEngine, { vectorService });

    const result = await pipeline.search(extract('implement region retrieval'), {
      intentSearchPlan: createIntentPlan(),
    });

    expect(vectorService.syncRecipeSemanticRegions).not.toHaveBeenCalled();
    expect(result?.relatedKnowledge).toEqual([]);
    expect(result?.searchMeta.residentRegionRetrieval).toMatchObject({
      used: false,
      wholeEntryOnlyRejectedCount: expect.any(Number),
    });
    expect(result?.searchMeta.residentRegionRetrieval?.wholeEntryOnlyRejectedCount).toBeGreaterThan(
      0
    );
    expect(result?.searchMeta.residentRegionRetrieval?.degradedReasons).toContain(
      'resident-region:whole-entry-only-rejected'
    );
    expect(result?.searchMeta.primeInjectionPackage?.injection).toMatchObject({
      selectedCount: 0,
      status: 'empty',
    });
  });

  test('reports resident vector unavailable diagnostics with metadata-only fallback disabled', async () => {
    const searchEngine = { search: vi.fn(async () => ({ items: [] })) };
    const pipeline = new PrimeSearchPipeline(searchEngine);

    const result = await pipeline.search(extract('implement region retrieval'), {
      intentSearchPlan: createIntentPlan(),
    });

    expect(result?.searchMeta.residentRegionRetrieval).toMatchObject({
      used: false,
      vectorAvailable: false,
      metadataOnlyFallback: {
        attempted: false,
        reason: 'not-supported-by-resident-vector-service',
        used: false,
      },
    });
    expect(result?.searchMeta.residentRegionRetrieval?.degradedReasons).toEqual(
      expect.arrayContaining([
        'resident-vector:unavailable',
        'resident-region:metadata-only-fallback-unavailable',
      ])
    );
  });

  test('reports empty resident region index without generating chunks during query', async () => {
    const searchEngine = { search: vi.fn(async () => ({ items: [] })) };
    const vectorService = {
      getStats: vi.fn(async () => ({ count: 0, embedProviderAvailable: true })),
      search: vi.fn(async () => []),
      syncRecipeSemanticRegions: vi.fn(),
    };
    const pipeline = new PrimeSearchPipeline(searchEngine, { vectorService });

    const result = await pipeline.search(extract('implement region retrieval'), {
      intentSearchPlan: createIntentPlan(),
    });

    expect(vectorService.syncRecipeSemanticRegions).not.toHaveBeenCalled();
    expect(result?.searchMeta.residentRegionRetrieval).toMatchObject({
      used: false,
      vectorAvailable: true,
      regionHitCount: 0,
    });
    expect(result?.searchMeta.residentRegionRetrieval?.degradedReasons).toContain(
      'resident-region-index:empty'
    );
  });
});
