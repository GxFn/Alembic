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
        knowledgeService: mocks.knowledgeService,
        searchEngine: mocks.searchEngine,
        vectorService: mocks.vectorService,
      };
      return services[name];
    });
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
      appliedFilters: {},
      coreRoute: 'core-search-engine',
      degraded: false,
      durationMs: 7,
      filterOnly: false,
      requestedMode: 'semantic',
      resultCount: 1,
      route: 'resident-search',
      semanticRequested: true,
      semanticUsed: true,
      service: 'alembic-daemon',
      topScore: 0.91,
      vectorUsed: true,
    });
    expect(searchMeta).not.toHaveProperty('intentEvidence');
    expect(searchMeta).not.toHaveProperty('intentSearchPlan');
    expect(searchMeta).not.toHaveProperty('primeInjectionPackage');
    expect(searchMeta).not.toHaveProperty('decisionRegister');
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

    expect(response.status).toBe(200);
    expect(data.items).toEqual([{ id: 'recipe-2', score: 0.42 }]);
    expect(searchMeta).toMatchObject({
      actualMode: 'auto(sparse-rrf,conf=0.82)',
      degraded: true,
      degradedReason: 'embed_failed:host placeholder is not executable',
      fallbackReason: 'embed_failed:host placeholder is not executable',
      requestedMode: 'semantic',
      semanticUsed: false,
      vectorUsed: false,
    });
    expect(searchMeta.vector).toMatchObject({
      available: true,
      reason: null,
    });
  });

  test('passes explicit metadata filters to Core without host context leakage', async () => {
    mocks.searchEngine.search.mockResolvedValue({
      items: [{ id: 'recipe-filtered', score: 0.88 }],
      mode: 'semantic',
      ranked: true,
      searchMeta: {
        actualMode: 'semantic',
        appliedFilters: {
          category: 'quality',
          dimensionId: 'asq-publication',
          kind: 'pattern',
          knowledgeType: 'code-pattern',
          language: 'typescript',
          scope: 'project-specific',
          tags: ['search', 'telemetry'],
        },
        durationMs: 6,
        requestedMode: 'semantic',
        resultCount: 1,
        route: 'core-search-engine',
        semanticUsed: true,
        vectorUsed: true,
      },
      total: 1,
    });

    const response = await invokeRouter(searchRouter, {
      body: {
        category: 'quality',
        dimensionId: 'asq-publication',
        filters: { scope: 'project-specific' },
        hostDeclaredIntent: {
          intent: 'generate',
          query: 'should not affect public search',
        },
        kind: 'pattern',
        knowledgeType: 'code-pattern',
        language: 'typescript',
        mode: 'semantic',
        query: 'filter query',
        rank: true,
        tags: ['search', 'telemetry'],
      },
      method: 'POST',
      mountPath: '/api/v1/search',
      path: '/api/v1/search',
    });
    const data = response.body.data as Record<string, unknown>;
    const searchMeta = data.searchMeta as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(mocks.searchEngine.search).toHaveBeenCalledWith(
      'filter query',
      expect.objectContaining({
        category: 'quality',
        dimensionId: 'asq-publication',
        groupByKind: false,
        kind: 'pattern',
        knowledgeType: 'code-pattern',
        language: 'typescript',
        limit: 20,
        mode: 'semantic',
        rank: true,
        scope: 'project-specific',
        tags: ['search', 'telemetry'],
        type: 'all',
      })
    );
    expect(mocks.searchEngine.search).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ context: expect.anything() })
    );
    expect(data.query).toBe('filter query');
    expect(searchMeta).toMatchObject({
      appliedFilters: {
        category: 'quality',
        dimensionId: 'asq-publication',
        kind: 'pattern',
        knowledgeType: 'code-pattern',
        language: 'typescript',
        scope: 'project-specific',
        tags: ['search', 'telemetry'],
      },
      filterOnly: true,
      semanticUsed: true,
      vectorUsed: true,
    });
    expect(JSON.stringify(data)).not.toContain('intentEvidence');
    expect(JSON.stringify(data)).not.toContain('primeInjectionPackage');
    expect(JSON.stringify(data)).not.toContain('IntentSearchPlan');
    expect(JSON.stringify(data)).not.toContain('should not affect public search');
  });

  test('rejects retired public search modes', async () => {
    const getResponse = await getRouter(searchRouter, '/api/v1/search?q=needle&mode=bm25', {
      mountPath: '/api/v1/search',
    });

    expect(getResponse.status).toBe(400);
    expect(mocks.searchEngine.search).not.toHaveBeenCalled();
  });

  test('reports degraded search telemetry when SearchEngine is unavailable', async () => {
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
      appliedFilters: {},
      coreRoute: null,
      degraded: true,
      degradedReason: 'SearchEngine unavailable; resident service used legacy non-vector fallback',
      filterOnly: false,
      requestedMode: 'semantic',
      resultCount: 0,
      semanticUsed: false,
      vectorUsed: false,
    });
    expect(searchMeta).not.toHaveProperty('intentEvidence');
    expect(searchMeta).not.toHaveProperty('primeInjectionPackage');
    expect(searchMeta.residentVector).toMatchObject({
      available: false,
      endpoint: '/api/v1/search',
      reason: 'SearchEngine unavailable; vector route was not attempted',
      stats: null,
    });
  });
});
