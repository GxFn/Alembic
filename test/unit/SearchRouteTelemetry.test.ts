import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getRouter } from '../helpers/express.js';

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
