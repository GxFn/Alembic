import { describe, expect, test, vi } from 'vitest';
import { createIdleIntent } from '../../lib/service/handler-runtime/types.js';
import { taskHandler } from '../../lib/service/task/TaskDispatchService.js';

describe('task handler intent episode integration', () => {
  test('starts, attaches, and closes an intent episode across resident task lifecycle', async () => {
    const store = {
      attachTask: vi.fn(),
      start: vi.fn().mockReturnValue({
        episodeId: 'episode_1',
        sessionKey: 'sha256:session',
        status: 'active',
      }),
      updateOutcome: vi.fn(),
    };
    const pipeline = {
      search: vi.fn().mockResolvedValue({
        guardRules: [],
        relatedKnowledge: [{ id: 'recipe-1', sourceRefs: ['src/recipe.ts:1'], title: 'Recipe' }],
        searchMeta: {
          filteredCount: 0,
          hostIntentApplied: true,
          hostIntentConfidence: 0.9,
          hostIntentSourceRefs: ['host:intent'],
          queries: ['episode store'],
          resultCount: 1,
        },
      }),
    };
    const signalBus = { send: vi.fn() };
    const ctx = {
      container: {
        get: vi.fn((name: string) => {
          if (name === 'intentEpisodeStore') {
            return store;
          }
          if (name === 'primeSearchPipeline') {
            return pipeline;
          }
          if (name === 'signalBus') {
            return signalBus;
          }
          throw new Error(`unexpected service: ${name}`);
        }),
      },
      session: {
        id: 'raw-session-id',
        intent: createIdleIntent(),
        lastActivityAt: Date.now(),
        startedAt: Date.now(),
        toolCallCount: 0,
        toolsUsed: new Set<string>(),
      },
    };

    const prime = await taskHandler(ctx, {
      activeFile: '/Users/private/project/src/task.ts',
      hostDeclaredIntent: {
        confidence: 0.9,
        intent: 'generate',
        query: 'episode store',
        sourceRefs: ['host:intent'],
      },
      hostTurnMeta: {
        id: 'turn-1',
        language: 'typescript',
      },
      operation: 'prime',
      userQuery: 'fallback',
    });

    expect(store.start).toHaveBeenCalledWith(
      expect.objectContaining({
        activeFile: '/Users/private/project/src/task.ts',
        hostIntent: expect.objectContaining({
          applied: true,
          confidence: 0.9,
          sourceRefs: ['host:intent'],
        }),
        query: 'episode store',
        searchMeta: expect.objectContaining({
          hostIntentApplied: true,
          hostIntentSourceRefs: ['host:intent'],
          primeInjectionPackage: expect.objectContaining({
            selectedKnowledge: expect.arrayContaining([
              expect.objectContaining({ itemId: 'recipe-1', sourceRefs: ['src/recipe.ts:1'] }),
            ]),
          }),
          queries: ['episode store'],
        }),
        sessionId: 'raw-session-id',
        turnId: 'turn-1',
      })
    );
    expect(prime).toMatchObject({
      data: {
        intentEpisode: {
          episodeId: 'episode_1',
          sessionKey: 'sha256:session',
        },
        primeInjectionPackage: expect.objectContaining({
          selectedKnowledge: expect.arrayContaining([
            expect.objectContaining({ itemId: 'recipe-1' }),
          ]),
        }),
      },
      success: true,
    });
    expect(ctx.session.intent.episodeId).toBe('episode_1');
    expect(ctx.session.intent.episodeSessionKey).toBe('sha256:session');

    const create = await taskHandler(ctx, {
      operation: 'create',
      title: 'Implement episode store',
    });
    const created = (create.data as Record<string, unknown>).id as string;

    expect(created).toMatch(/^alembic-/);
    expect(store.attachTask).toHaveBeenCalledWith('episode_1', created);
    expect(create).toMatchObject({
      data: {
        intentEpisode: {
          episodeId: 'episode_1',
          sessionKey: 'sha256:session',
        },
      },
      success: true,
    });

    await taskHandler(ctx, {
      id: created,
      operation: 'close',
      reason: 'done',
    });

    expect(signalBus.send).toHaveBeenCalledWith(
      'intent',
      'TaskHandler',
      0,
      expect.objectContaining({
        metadata: {
          chain: expect.objectContaining({
            outcome: 'completed',
            taskId: created,
          }),
        },
        target: created,
      })
    );
    expect(store.updateOutcome).toHaveBeenCalledWith('episode_1', {
      reason: 'done',
      searchMeta: expect.objectContaining({ queries: ['episode store'] }),
      status: 'completed',
      taskId: created,
    });
    expect(ctx.session.intent.phase).toBe('idle');
  });

  test('preserves resident region retrieval evidence when rebuilding prime package', async () => {
    const store = {
      attachTask: vi.fn(),
      start: vi.fn().mockReturnValue({
        episodeId: 'episode_region',
        sessionKey: 'sha256:region',
        status: 'active',
      }),
      updateOutcome: vi.fn(),
    };
    const residentRegionEvidence = {
      attempted: true,
      degradedReasons: [],
      metadataOnlyFallback: {
        attempted: false,
        reason: 'not-supported-by-resident-vector-service',
        used: false,
      },
      queryCount: 7,
      regionHitCount: 1,
      route: 'resident-vector-recipe-semantic-region',
      selectedRecipes: [
        {
          matchedRegionClasses: ['architectureConvention'],
          matchedRegions: [
            {
              regionClass: 'architectureConvention',
              score: 0.93,
              snippet: 'Convention: consume recipe-semantic-region vectors.',
              sourceRefs: ['lib/service/task/PrimeSearchPipeline.ts:1'],
              sourceRefsBridge: 'active',
              vectorId: 'recipe_region_recipe-1_architectureConvention_hash',
            },
          ],
          recipeId: 'recipe-1',
          score: 0.93,
          sourceRefs: ['lib/service/task/PrimeSearchPipeline.ts:1'],
          title: 'Resident Region Retrieval',
          trigger: '@resident-region-retrieval',
        },
      ],
      used: true,
      vectorAvailable: true,
      wholeEntryOnlyRejectedCount: 0,
    };
    const pipeline = {
      search: vi.fn().mockResolvedValue({
        guardRules: [],
        relatedKnowledge: [
          {
            id: 'recipe-1',
            metadata: {
              residentRegionEvidence: residentRegionEvidence.selectedRecipes[0],
            },
            score: 0.93,
            sourceRefs: ['lib/service/task/PrimeSearchPipeline.ts:1'],
            title: 'Resident Region Retrieval',
            trigger: '@resident-region-retrieval',
          },
        ],
        searchMeta: {
          filteredCount: 1,
          queries: ['resident region retrieval'],
          residentRegionRetrieval: residentRegionEvidence,
          resultCount: 1,
        },
      }),
    };
    const ctx = {
      container: {
        get: vi.fn((name: string) => {
          if (name === 'intentEpisodeStore') {
            return store;
          }
          if (name === 'primeSearchPipeline') {
            return pipeline;
          }
          throw new Error(`unexpected service: ${name}`);
        }),
      },
      session: {
        id: 'raw-session-id',
        intent: createIdleIntent(),
        lastActivityAt: Date.now(),
        startedAt: Date.now(),
        toolCallCount: 0,
        toolsUsed: new Set<string>(),
      },
    };

    const prime = await taskHandler(ctx, {
      hostDeclaredIntent: {
        confidence: 0.9,
        intent: 'generate',
        query: 'resident region retrieval',
        sourceRefs: ['host:intent'],
      },
      operation: 'prime',
      userQuery: 'fallback',
    });

    expect(prime).toMatchObject({
      data: {
        primeInjectionPackage: expect.objectContaining({
          residentRegionRetrieval: expect.objectContaining({ used: true }),
          selectedKnowledge: expect.arrayContaining([
            expect.objectContaining({
              itemId: 'recipe-1',
              matchedRegionClasses: ['architectureConvention'],
              matchedRegions: expect.arrayContaining([
                expect.objectContaining({
                  regionClass: 'architectureConvention',
                  snippet: expect.stringContaining('recipe-semantic-region'),
                }),
              ]),
            }),
          ]),
          vector: expect.objectContaining({
            semanticUsed: true,
            vectorAvailable: true,
            vectorUsed: true,
          }),
        }),
        searchMeta: expect.objectContaining({
          residentRegionRetrieval: expect.objectContaining({ used: true }),
        }),
      },
      success: true,
    });
    expect(store.start).toHaveBeenCalledWith(
      expect.objectContaining({
        searchMeta: expect.objectContaining({
          residentRegionRetrieval: expect.objectContaining({ used: true }),
        }),
      })
    );
  });
});
