import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  loadActiveRecipeRegionEntries,
  type RecipeRegionFixtureProofStore,
  type RecipeRegionFixtureVectorService,
  runRecipeRegionFixtureGeneration,
} from '../../lib/service/vector/RecipeRegionFixtureGeneration.js';

const baseReport = {
  mode: 'bounded-generation-test' as const,
  status: 'completed' as const,
  activeRecipeCount: 1,
  distinctRecipeIdsCovered: 1,
  missingRecipeIds: [],
  generatedRecipeRegionItemCount: 2,
  embedded: 2,
  upserted: 2,
  skipped: 0,
  removed: 0,
  degradedCount: 0,
  staleRemovedCount: 0,
  legacyEntryCount: 1,
  legacyEntryOnly: false,
  safeForFullFixtureGeneration: true,
  errors: [],
  generatedRegionClassCounts: {
    identity: 1,
    applicability: 0,
    patternPurpose: 0,
    architectureConvention: 1,
    integrationBoundary: 0,
    qualityConcern: 0,
    negativeBoundary: 0,
    rationale: 0,
    evidence: 0,
  },
  filterProof: {
    recipeSemanticRegionFilterCount: 2,
    regionClassFilterCounts: {
      identity: 1,
      applicability: 0,
      patternPurpose: 0,
      architectureConvention: 1,
      integrationBoundary: 0,
      qualityConcern: 0,
      negativeBoundary: 0,
      rationale: 0,
      evidence: 0,
    },
    filterable: true,
  },
  retrievalSamples: [
    {
      query: 'Repository boundary sync pattern',
      matched: true,
      topK: 5,
      matchedRegionIds: ['recipe_region_recipe-1_architectureConvention_hash'],
      matchedRecipeIds: ['recipe-1'],
      matchedRegionClasses: ['architectureConvention' as const],
      topScore: 1,
    },
  ],
  vectorIndex: {
    count: 3,
    indexPath: '/tmp/vector_index.json',
    indexSize: 128,
    timestamp: '2026-06-17T00:00:00.000Z',
  },
  fullGenerationRoute: {
    method: 'VectorService.syncRecipeSemanticRegions' as const,
    precondition: 'bounded-generation-test-passed' as const,
    allowedAfterBoundedPass: true,
  },
};

describe('Recipe region fixture generation', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close();
    }
    vi.restoreAllMocks();
  });

  test('loads active Recipe rows into Core RecipeRegionSourceEntry shape', () => {
    const db = createDatabase();
    insertRecipe(db, {
      id: 'recipe-1',
      tags: JSON.stringify(['architecture', 'fixture']),
      content: JSON.stringify({ pattern: 'Use rebuild-only semantic region generation.' }),
      reasoning: JSON.stringify({
        sources: ['lib/service/vector/RecipeRegionFixtureGeneration.ts'],
      }),
    });
    insertRecipe(db, { id: 'deprecated-recipe', lifecycle: 'deprecated' });
    db.prepare(
      `INSERT INTO recipe_source_refs (recipe_id, source_path, status)
       VALUES ('recipe-1', 'lib/service/vector/RecipeRegionFixtureGeneration.ts', 'active')`
    ).run();

    const loaded = loadActiveRecipeRegionEntries(db);

    expect(loaded.activeRecipeCount).toBe(1);
    expect(loaded.entries[0]).toMatchObject({
      id: 'recipe-1',
      lifecycle: 'active',
      tags: ['architecture', 'fixture'],
      content: { pattern: 'Use rebuild-only semantic region generation.' },
      reasoning: { sources: ['lib/service/vector/RecipeRegionFixtureGeneration.ts'] },
    });
    expect(loaded.sourceRefsBridgeByRecipeId['recipe-1']).toEqual({
      status: 'active',
      refs: ['lib/service/vector/RecipeRegionFixtureGeneration.ts'],
    });
  });

  test('runs bounded generation before full generation and returns vector proof', async () => {
    const db = createDatabase();
    insertRecipe(db, { id: 'recipe-1' });
    const calls: string[] = [];
    const vectorService: RecipeRegionFixtureVectorService = {
      testRecipeSemanticRegionGeneration: vi.fn(async () => {
        calls.push('bounded');
        return baseReport;
      }),
      syncRecipeSemanticRegions: vi.fn(async () => {
        calls.push('full');
        return {
          status: 'completed',
          scanned: 1,
          generated: 2,
          embedded: 2,
          upserted: 2,
          removed: 0,
          skipped: 0,
          errors: [],
          generatedMetadata: [
            {
              type: 'recipe-semantic-region',
              recipeId: 'recipe-1',
              regionClass: 'architectureConvention',
            },
          ],
        } as never;
      }),
    };
    const proofStore = createProofStore({
      ids: ['entry_legacy', 'recipe_region_recipe-1_architectureConvention_hash'],
      regionItems: [
        {
          id: 'recipe_region_recipe-1_architectureConvention_hash',
          metadata: {
            type: 'recipe-semantic-region',
            recipeId: 'recipe-1',
            regionClass: 'architectureConvention',
            deprecated: false,
          },
        },
      ],
    });

    const result = await runRecipeRegionFixtureGeneration({
      dataRoot: '/tmp/alembic-data',
      database: db,
      projectRoot: '/tmp/project',
      proofStore,
      vectorService,
    });

    expect(calls).toEqual(['bounded', 'full']);
    expect(result.status).toBe('completed');
    expect(result.blockers).toEqual([]);
    expect(result.proof).toMatchObject({
      recipeRegionItemCount: 1,
      metadataTypeCount: 1,
      legacyEntryCount: 1,
      legacyEntryOnly: false,
      distinctRecipeIdsCovered: 1,
      missingRecipeIds: [],
    });
    expect(result.proof.regionClassDistribution.architectureConvention).toBe(1);
  });

  test('blocks full generation when bounded report is not safe', async () => {
    const db = createDatabase();
    insertRecipe(db, { id: 'recipe-1' });
    const unsafeReport = {
      ...baseReport,
      status: 'degraded' as const,
      legacyEntryOnly: true,
      safeForFullFixtureGeneration: false,
      errors: ['sample-retrieval-proof:embed-provider-unavailable'],
    };
    const vectorService: RecipeRegionFixtureVectorService = {
      testRecipeSemanticRegionGeneration: vi.fn(async () => unsafeReport),
      syncRecipeSemanticRegions: vi.fn(),
    };

    const result = await runRecipeRegionFixtureGeneration({
      dataRoot: '/tmp/alembic-data',
      database: db,
      projectRoot: '/tmp/project',
      vectorService,
    });

    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'bounded-generation-test-not-safe-for-full-fixture',
        'sample-retrieval-proof:embed-provider-unavailable',
      ])
    );
    expect(vectorService.syncRecipeSemanticRegions).not.toHaveBeenCalled();
  });

  test('blocks empty target data roots without running generation', async () => {
    const db = createDatabase();
    const vectorService: RecipeRegionFixtureVectorService = {
      testRecipeSemanticRegionGeneration: vi.fn(),
      syncRecipeSemanticRegions: vi.fn(),
    };

    const result = await runRecipeRegionFixtureGeneration({
      dataRoot: '/tmp/alembic-data',
      database: db,
      projectRoot: '/tmp/project',
      vectorService,
    });

    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(['active-recipe-rows-missing']);
    expect(vectorService.testRecipeSemanticRegionGeneration).not.toHaveBeenCalled();
    expect(vectorService.syncRecipeSemanticRegions).not.toHaveBeenCalled();
  });

  test('rejects a legacy entry-only proof after full sync', async () => {
    const db = createDatabase();
    insertRecipe(db, { id: 'recipe-1' });
    const vectorService: RecipeRegionFixtureVectorService = {
      testRecipeSemanticRegionGeneration: vi.fn(async () => baseReport),
      syncRecipeSemanticRegions: vi.fn(async () => ({
        status: 'completed',
        scanned: 1,
        generated: 2,
        embedded: 2,
        upserted: 2,
        removed: 0,
        skipped: 0,
        errors: [],
        generatedMetadata: [],
      })),
    };
    const proofStore = createProofStore({ ids: ['entry_legacy'], regionItems: [] });

    const result = await runRecipeRegionFixtureGeneration({
      dataRoot: '/tmp/alembic-data',
      database: db,
      projectRoot: '/tmp/project',
      proofStore,
      vectorService,
    });

    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'recipe-semantic-region-fixture-missing',
        'active-recipe-region-coverage-missing:recipe-1',
        'legacy-entry-only-vector-index',
      ])
    );
  });

  test('blocks incomplete embedding even when region metadata was upserted', async () => {
    const db = createDatabase();
    insertRecipe(db, { id: 'recipe-1' });
    const vectorService: RecipeRegionFixtureVectorService = {
      testRecipeSemanticRegionGeneration: vi.fn(async () => baseReport),
      syncRecipeSemanticRegions: vi.fn(async () => ({
        status: 'completed',
        scanned: 1,
        generated: 2,
        embedded: 1,
        upserted: 2,
        removed: 0,
        skipped: 0,
        errors: [],
        generatedMetadata: [],
      })),
    };
    const proofStore = createProofStore({
      ids: ['entry_legacy', 'recipe_region_recipe-1_architectureConvention_hash'],
      regionItems: [
        {
          id: 'recipe_region_recipe-1_architectureConvention_hash',
          metadata: {
            type: 'recipe-semantic-region',
            recipeId: 'recipe-1',
            regionClass: 'architectureConvention',
            deprecated: false,
          },
        },
      ],
    });

    const result = await runRecipeRegionFixtureGeneration({
      dataRoot: '/tmp/alembic-data',
      database: db,
      projectRoot: '/tmp/project',
      proofStore,
      vectorService,
    });

    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(
      expect.arrayContaining(['full-generation-embedding-incomplete:1/2'])
    );
  });

  function createDatabase(): Database.Database {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(`
      CREATE TABLE knowledge_entries (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        lifecycle TEXT,
        language TEXT,
        dimensionId TEXT,
        category TEXT,
        kind TEXT,
        knowledgeType TEXT,
        tags TEXT,
        trigger TEXT,
        topicHint TEXT,
        whenClause TEXT,
        doClause TEXT,
        dontClause TEXT,
        coreCode TEXT,
        usageGuide TEXT,
        content TEXT,
        reasoning TEXT,
        sourceFile TEXT,
        moduleName TEXT,
        contentHash TEXT,
        updatedAt INTEGER
      );
      CREATE TABLE recipe_source_refs (
        recipe_id TEXT,
        source_path TEXT,
        status TEXT
      );
    `);
    return db;
  }

  function insertRecipe(
    db: Database.Database,
    overrides: Partial<Record<string, string | number | null>>
  ): void {
    const row = {
      id: 'recipe-1',
      title: 'Repository boundary sync pattern',
      description: 'Generate region chunks in refresh flows.',
      lifecycle: 'active',
      language: 'typescript',
      dimensionId: 'architecture',
      category: 'Utility',
      kind: 'pattern',
      knowledgeType: 'code-pattern',
      tags: 'architecture,fixture',
      trigger: '@repo-boundary-sync',
      topicHint: 'Utility',
      whenClause: 'When Recipe region fixture setup runs.',
      doClause: 'Run bounded generation before full generation.',
      dontClause: 'Do not generate during query handling.',
      coreCode: null,
      usageGuide: null,
      content: JSON.stringify({ pattern: 'Use an explicit fixture generation helper.' }),
      reasoning: JSON.stringify({
        sources: ['lib/service/vector/RecipeRegionFixtureGeneration.ts'],
      }),
      sourceFile: 'lib/service/vector/RecipeRegionFixtureGeneration.ts',
      moduleName: 'service/vector',
      contentHash: 'hash-1',
      updatedAt: 1,
      ...overrides,
    };
    db.prepare(
      `INSERT INTO knowledge_entries (
        id, title, description, lifecycle, language, dimensionId, category,
        kind, knowledgeType, tags, trigger, topicHint, whenClause, doClause,
        dontClause, coreCode, usageGuide, content, reasoning, sourceFile,
        moduleName, contentHash, updatedAt
      ) VALUES (
        @id, @title, @description, @lifecycle, @language, @dimensionId, @category,
        @kind, @knowledgeType, @tags, @trigger, @topicHint, @whenClause, @doClause,
        @dontClause, @coreCode, @usageGuide, @content, @reasoning, @sourceFile,
        @moduleName, @contentHash, @updatedAt
      )`
    ).run(row);
  }
});

function createProofStore(options: {
  ids: string[];
  regionItems: Record<string, unknown>[];
}): RecipeRegionFixtureProofStore {
  return {
    getStats: vi.fn(async () => ({
      count: options.ids.length,
      indexPath: '/tmp/vector_index.json',
      indexSize: 128,
    })),
    listIds: vi.fn(async () => options.ids),
    searchByFilter: vi.fn(async () => options.regionItems),
  };
}
