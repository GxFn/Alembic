import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getRouter, invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => {
  const container = {
    get: vi.fn(),
    singletons: {
      _projectRoot: '/tmp/alembic-project',
      _workspaceResolver: {
        dataRoot: '/tmp/alembic-project/.alembic-data',
        databasePath: '/tmp/alembic-project/.alembic-data/alembic.db',
        projectId: 'project-test',
        projectRoot: '/tmp/alembic-project',
        runtimeDir: '/tmp/alembic-project/.alembic-data/runtime',
        toFacts: () => ({ dataRootSource: 'project-root', mode: 'standard' }),
      },
    },
  };
  return {
    container,
    guardService: { searchRules: vi.fn() },
    intentEpisodeStore: { latest: vi.fn(), recent: vi.fn() },
    knowledgeGraphService: { getEdges: vi.fn() },
    knowledgeService: { search: vi.fn() },
    searchEngine: { search: vi.fn() },
    vectorService: { getStats: vi.fn() },
  };
});

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

import searchRouter from '../../lib/http/routes/search.js';

describe('search route resident telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.container.get.mockImplementation((name: string) => {
      const services: Record<string, unknown> = {
        guardService: mocks.guardService,
        intentEpisodeStore: mocks.intentEpisodeStore,
        knowledgeGraphService: mocks.knowledgeGraphService,
        knowledgeService: mocks.knowledgeService,
        searchEngine: mocks.searchEngine,
        vectorService: mocks.vectorService,
      };
      return services[name];
    });
    mocks.intentEpisodeStore.latest.mockReturnValue(null);
    mocks.intentEpisodeStore.recent.mockReturnValue([]);
    mocks.knowledgeGraphService.getEdges.mockResolvedValue([]);
    mocks.vectorService.getStats.mockResolvedValue({
      count: 118,
      dimension: 1024,
      embedProviderAvailable: true,
      indexSize: 4096,
      quantized: false,
    });
  });

  test('keeps items compatible while exposing resident semantic vector telemetry', async () => {
    mocks.searchEngine.search.mockResolvedValue({
      items: [{ id: 'recipe-1', score: 0.91, semanticScore: 0.91 }],
      mode: 'semantic',
      query: 'needle',
      ranked: true,
      searchMeta: {
        actualMode: 'semantic',
        durationMs: 7,
        requestedMode: 'semantic',
        resultCount: 1,
        route: 'core-search-engine',
        semanticUsed: true,
        vectorUsed: true,
      },
      total: 1,
      type: 'all',
    });

    const response = await getRouter(searchRouter, '/api/v1/search?q=needle&mode=semantic', {
      mountPath: '/api/v1/search',
    });
    const data = response.body.data as Record<string, unknown>;
    const searchMeta = data.searchMeta as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(data.items).toEqual([{ id: 'recipe-1', score: 0.91, semanticScore: 0.91 }]);
    expect(searchMeta).toMatchObject({
      actualMode: 'semantic',
      coreRoute: 'core-search-engine',
      degraded: false,
      durationMs: 7,
      requestedMode: 'semantic',
      resultCount: 1,
      route: 'resident-search',
      semanticRequested: true,
      semanticUsed: true,
      service: 'alembic-daemon',
      topScore: 0.91,
      vectorUsed: true,
    });
    expect(searchMeta.residentVector).toMatchObject({
      available: true,
      endpoint: '/api/v1/search',
      reason: null,
      stats: {
        count: 118,
        dimension: 1024,
        embedProviderAvailable: true,
        hasIndex: true,
      },
    });
    expect(searchMeta.vector).toMatchObject({
      available: true,
      reason: null,
      stats: {
        count: 118,
        dimension: 1024,
        embedProviderAvailable: true,
        hasIndex: true,
      },
    });
    expect(searchMeta.workspace).toMatchObject({
      dataRoot: '/tmp/alembic-project/.alembic-data',
      dataRootSource: 'project-root',
      databasePath: '/tmp/alembic-project/.alembic-data/alembic.db',
      projectId: 'project-test',
      projectRoot: '/tmp/alembic-project',
      runtimeDir: '/tmp/alembic-project/.alembic-data/runtime',
      workspaceMode: 'standard',
    });
  });

  test('preserves Core sparse-only RRF telemetry without reporting a vector hit', async () => {
    mocks.searchEngine.search.mockResolvedValue({
      items: [{ id: 'recipe-2', score: 0.42 }],
      mode: 'auto(sparse-rrf,conf=0.82)',
      query: 'needle',
      ranked: true,
      searchMeta: {
        actualMode: 'auto(sparse-rrf,conf=0.82)',
        durationMs: 12,
        fallbackReason: 'embed_failed:host placeholder is not executable',
        requestedMode: 'semantic',
        resultCount: 1,
        route: 'core-search-engine',
        semanticUsed: false,
        vectorUsed: false,
      },
      total: 1,
    });

    const response = await getRouter(searchRouter, '/api/v1/search?q=needle&mode=semantic', {
      mountPath: '/api/v1/search',
    });
    const data = response.body.data as Record<string, unknown>;
    const searchMeta = data.searchMeta as Record<string, unknown>;

    expect(data.items).toEqual([{ id: 'recipe-2', score: 0.42 }]);
    expect(searchMeta).toMatchObject({
      actualMode: 'auto(sparse-rrf,conf=0.82)',
      coreRoute: 'core-search-engine',
      degraded: true,
      degradedReason: 'embed_failed:host placeholder is not executable',
      fallbackReason: 'embed_failed:host placeholder is not executable',
      requestedMode: 'semantic',
      semanticUsed: false,
      vectorUsed: false,
    });
    expect(searchMeta.residentVector).toMatchObject({
      available: true,
      endpoint: '/api/v1/search',
      reason: null,
      stats: {
        count: 118,
        dimension: 1024,
        embedProviderAvailable: true,
        hasIndex: true,
      },
    });
    expect(searchMeta.vector).toMatchObject({
      available: true,
      reason: null,
    });
  });

  test('passes resident intent context through POST search without breaking query-only GET', async () => {
    mocks.searchEngine.search.mockResolvedValue({
      items: [{ id: 'recipe-3', score: 0.64 }],
      mode: 'bm25',
      query: 'service factory',
      ranked: true,
      searchMeta: {
        actualMode: 'bm25',
        durationMs: 9,
        requestedMode: 'bm25',
        resultCount: 1,
        route: 'core-search-engine',
        semanticUsed: false,
        vectorUsed: false,
      },
      total: 1,
    });

    const response = await invokeRouter(searchRouter, {
      body: {
        hostDeclaredIntent: {
          confidence: 0.82,
          intent: 'generate',
          query: 'service factory',
          sourceRefs: ['host:intent'],
        },
        hostTurnMeta: {
          language: 'typescript',
          sessionHistory: [{ content: 'previous turn' }],
        },
        mode: 'bm25',
        query: 'fallback query',
      },
      method: 'POST',
      mountPath: '/api/v1/search',
      path: '/api/v1/search',
    });
    const data = response.body.data as Record<string, unknown>;
    const searchMeta = data.searchMeta as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(mocks.searchEngine.search).toHaveBeenCalledWith(
      'service factory',
      expect.objectContaining({
        context: {
          intent: 'generate',
          language: 'typescript',
          sessionHistory: [{ content: 'previous turn' }],
        },
        groupByKind: false,
        limit: 20,
        mode: 'bm25',
        type: 'all',
      })
    );
    expect(data.query).toBe('service factory');
    expect(searchMeta).toMatchObject({
      actualMode: 'bm25',
      degraded: false,
      hostIntentApplied: true,
      hostIntentConfidence: 0.82,
      hostIntentDegraded: false,
      hostIntentSourceRefs: ['host:intent'],
    });
  });

  test('builds an IntentSearchPlan that changes keyword/BM25 query with episode continuity evidence', async () => {
    mocks.intentEpisodeStore.latest.mockReturnValue({
      episodeId: 'episode-prev',
      query: 'previous continuity query',
      sessionKey: 'sha256:previous',
      sourceRefs: ['knowledge:previous'],
      status: 'completed',
      version: 1,
    });
    mocks.intentEpisodeStore.recent.mockReturnValue([
      {
        episodeId: 'episode-prev',
        query: 'previous continuity query',
        sessionKey: 'sha256:previous',
        sourceRefs: ['knowledge:previous'],
        status: 'completed',
        version: 1,
      },
    ]);
    mocks.searchEngine.search.mockResolvedValue({
      items: [
        {
          description: 'Use dependency injection to compose a service factory.',
          id: 'recipe-plan',
          score: 0.77,
          semanticScore: 0.42,
          sourceRefs: ['/Users/private/project/src/recipe.ts:12'],
          title: 'Compose service factory',
          trigger: 'compose service factory',
        },
      ],
      mode: 'bm25',
      ranked: true,
      searchMeta: {
        actualMode: 'bm25',
        durationMs: 5,
        requestedMode: 'bm25',
        resultCount: 1,
        route: 'core-search-engine',
        semanticUsed: false,
        vectorUsed: false,
      },
      total: 1,
    });
    mocks.knowledgeGraphService.getEdges.mockResolvedValue([
      {
        fromId: 'recipe-plan',
        fromType: 'recipe',
        relation: 'related',
        toId: 'recipe-related',
        toType: 'recipe',
      },
    ]);

    const response = await invokeRouter(searchRouter, {
      body: {
        hostTurnMeta: {
          language: 'typescript',
          threadIdHash: 'thread-hash',
        },
        intentContext: {
          keywords: ['factory'],
          recognizedIntentDraft: {
            confidence: 0.88,
            constraints: ['dependency injection'],
            query: 'compose service factory',
            sourceRefs: ['/Users/private/project/src/service.ts:42'],
            status: 'recognized',
            target: 'ServiceFactory',
          },
        },
        mode: 'bm25',
        query: 'fallback query',
      },
      method: 'POST',
      mountPath: '/api/v1/search',
      path: '/api/v1/search',
    });
    const data = response.body.data as Record<string, unknown>;
    const searchMeta = data.searchMeta as Record<string, unknown>;
    const plan = searchMeta.intentSearchPlan as Record<string, unknown>;
    const evidence = searchMeta.intentEvidence as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(mocks.intentEpisodeStore.latest).toHaveBeenCalledWith({
      sessionId: 'thread:thread-hash',
    });
    expect(mocks.searchEngine.search).toHaveBeenCalledWith(
      expect.stringContaining('compose service factory'),
      expect.objectContaining({ mode: 'bm25' })
    );
    expect(data.query).toContain('dependency injection');
    expect(data.query).toContain('previous continuity query');
    expect(plan).toMatchObject({
      applied: true,
      rankingProfile: 'bm25-intent',
      sourceRefs: expect.arrayContaining(['[absolute-path]/service.ts:42', 'knowledge:previous']),
      whySelected: expect.arrayContaining([
        'recognizedIntentDraft.query',
        'intentEpisode.latest.query',
      ]),
    });
    expect(evidence).toMatchObject({
      semanticAnchors: expect.arrayContaining([
        expect.objectContaining({
          source: 'intentSearchPlan.executableQuery',
          value: expect.stringContaining('compose service factory'),
        }),
      ]),
      topAnchorMatches: expect.arrayContaining([
        expect.objectContaining({
          itemId: 'recipe-plan',
          matchType: 'text',
        }),
      ]),
      scoreBreakdown: expect.arrayContaining([
        expect.objectContaining({
          finalScore: 0.77,
          itemId: 'recipe-plan',
          semanticScore: 0.42,
        }),
      ]),
      relationEvidence: expect.arrayContaining([
        expect.objectContaining({
          itemId: 'recipe-plan',
          relatedId: 'recipe-related',
          relation: 'related',
        }),
      ]),
    });
    expect(JSON.stringify(plan)).not.toContain('/Users/private');
    expect(JSON.stringify(evidence)).not.toContain('/Users/private');
  });

  test('does not force low confidence recognized intent into keyword search', async () => {
    mocks.searchEngine.search.mockResolvedValue({
      items: [{ id: 'recipe-low-confidence', score: 0.51 }],
      mode: 'keyword',
      ranked: false,
      searchMeta: {
        actualMode: 'keyword',
        durationMs: 3,
        requestedMode: 'keyword',
        resultCount: 1,
        route: 'core-search-engine',
        semanticUsed: false,
        vectorUsed: false,
      },
      total: 1,
    });

    const response = await invokeRouter(searchRouter, {
      body: {
        intentContext: {
          recognizedIntentDraft: {
            confidence: 0.2,
            query: 'risky inferred query',
            status: 'needs-confirmation',
          },
        },
        mode: 'keyword',
        query: 'fallback query',
      },
      method: 'POST',
      mountPath: '/api/v1/search',
      path: '/api/v1/search',
    });
    const searchMeta = ((response.body.data as Record<string, unknown>).searchMeta ?? {}) as Record<
      string,
      unknown
    >;
    const plan = searchMeta.intentSearchPlan as Record<string, unknown>;

    expect(mocks.searchEngine.search).toHaveBeenCalledWith(
      'fallback query',
      expect.objectContaining({ mode: 'keyword' })
    );
    expect(plan).toMatchObject({
      applied: false,
      executableQuery: 'fallback query',
      omitted: expect.arrayContaining([
        'recognizedIntentDraft.lowConfidence',
        'recognizedIntentDraft.status:needs-confirmation',
      ]),
      rankingProfile: 'raw-fallback',
    });
  });

  test('reports legacy fallback metadata when SearchEngine is unavailable', async () => {
    mocks.searchEngine.search.mockRejectedValue(new Error('offline'));
    mocks.knowledgeService.search.mockResolvedValue({ data: [], pagination: { total: 0 } });
    mocks.guardService.searchRules.mockResolvedValue({ data: [], pagination: { total: 0 } });

    const response = await getRouter(searchRouter, '/api/v1/search?q=needle&mode=semantic', {
      mountPath: '/api/v1/search',
    });
    const data = response.body.data as Record<string, unknown>;
    const searchMeta = data.searchMeta as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(data.totalResults).toBe(0);
    expect(searchMeta).toMatchObject({
      actualMode: 'legacy-fallback',
      coreRoute: null,
      degraded: true,
      degradedReason: 'SearchEngine unavailable; resident service used legacy non-vector fallback',
      requestedMode: 'semantic',
      resultCount: 0,
      semanticUsed: false,
      vectorUsed: false,
    });
    expect(searchMeta.residentVector).toMatchObject({
      available: false,
      endpoint: '/api/v1/search',
      reason: 'SearchEngine unavailable; vector route was not attempted',
      stats: null,
    });
    expect(searchMeta.vector).toMatchObject({
      available: false,
      reason: 'SearchEngine unavailable; vector route was not attempted',
      stats: null,
    });
  });
});
