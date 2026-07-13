import { describe, expect, test, vi } from 'vitest';
import { invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => ({
  knowledgeService: {
    create: vi.fn(),
    delete: vi.fn(),
    publish: vi.fn(),
  },
  recipeProductionGateway: {
    createOrStage: vi.fn(),
    evaluateReadiness: vi.fn(),
    publish: vi.fn(),
  },
  searchEngine: {
    refreshIndex: vi.fn(),
  },
  vectorService: {
    syncCoordinator: {
      reconcile: vi.fn(),
    },
  },
  container: {
    services: {
      knowledgeService: true,
      searchEngine: true,
      vectorService: true,
    },
    get: vi.fn(),
  },
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

import knowledgeRouter from '../../lib/http/routes/knowledge.js';

describe('knowledge route entrypoint safety boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.container.services = {
      knowledgeService: true,
      searchEngine: true,
      vectorService: true,
    };
    mocks.knowledgeService.publish.mockResolvedValue({
      id: 'k-1',
      title: 'Knowledge One',
      lifecycle: 'active',
      toJSON() {
        return { id: 'k-1', title: 'Knowledge One', lifecycle: 'active' };
      },
    });
    mocks.recipeProductionGateway.publish.mockResolvedValue({
      id: 'k-1',
      title: 'Knowledge One',
      lifecycle: 'active',
      toJSON() {
        return { id: 'k-1', title: 'Knowledge One', lifecycle: 'active' };
      },
    });
    mocks.recipeProductionGateway.evaluateReadiness.mockResolvedValue({
      ready: true,
      schemaVersion: '1',
      profileHash: 'profile-hash-native',
      documentSetHash: 'document-set-hash-native',
      violations: [],
      warnings: [],
    });
    mocks.searchEngine.refreshIndex.mockResolvedValue(undefined);
    mocks.vectorService.syncCoordinator.reconcile.mockResolvedValue({
      missingQueued: 1,
      orphansRemoved: 0,
    });
    mocks.container.get.mockImplementation((name: string) => {
      if (name === 'knowledgeService') {
        return mocks.knowledgeService;
      }
      if (name === 'recipeProductionGateway') {
        return mocks.recipeProductionGateway;
      }
      if (name === 'searchEngine') {
        return mocks.searchEngine;
      }
      if (name === 'vectorService') {
        return mocks.vectorService;
      }
      throw new Error(`Unexpected service requested: ${name}`);
    });
  });

  test('retires direct knowledge creation as a typed zero-write endpoint', async () => {
    const response = await invokeRouter(knowledgeRouter, {
      body: {
        title: 'Legacy direct create',
        content: { pattern: 'This payload must never reach a write service.' },
      },
      method: 'POST',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge',
    });

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'RECIPE_CREATE_RETIRED',
      },
    });
    expect(mocks.knowledgeService.create).not.toHaveBeenCalled();
    expect(mocks.recipeProductionGateway.createOrStage).not.toHaveBeenCalled();
  });

  test('returns the complete Core retrieval readiness report without requesting write surfaces', async () => {
    const response = await invokeRouter(knowledgeRouter, {
      method: 'GET',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge/k-1/retrieval-readiness',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: {
        ready: true,
        schemaVersion: '1',
        profileHash: 'profile-hash-native',
        documentSetHash: 'document-set-hash-native',
        violations: [],
        warnings: [],
      },
    });
    expect(mocks.recipeProductionGateway.evaluateReadiness).toHaveBeenCalledWith('k-1');
    expect(mocks.container.get).toHaveBeenCalledTimes(1);
    expect(mocks.knowledgeService.create).not.toHaveBeenCalled();
    expect(mocks.knowledgeService.delete).not.toHaveBeenCalled();
    expect(mocks.recipeProductionGateway.publish).not.toHaveBeenCalled();
    expect(mocks.searchEngine.refreshIndex).not.toHaveBeenCalled();
    expect(mocks.vectorService.syncCoordinator.reconcile).not.toHaveBeenCalled();
  });

  test('passes provider, vector, generation, and rank diagnostics through as warnings only', async () => {
    mocks.recipeProductionGateway.evaluateReadiness.mockResolvedValueOnce({
      ready: true,
      schemaVersion: '1',
      profileHash: 'profile-hash-native',
      documentSetHash: 'document-set-hash-native',
      violations: [],
      warnings: [
        { code: 'retrieval.provider.unavailable', message: 'Provider is offline.' },
        { code: 'retrieval.vector-store.unavailable', message: 'Vector store is offline.' },
        { code: 'retrieval.index.pending', message: 'Generation is pending.' },
        { code: 'retrieval.ranking.metrics-missing', message: 'Rank metrics are missing.' },
      ],
    });

    const response = await invokeRouter(knowledgeRouter, {
      method: 'GET',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge/k-1/retrieval-readiness',
    });

    expect(response.body.data).toMatchObject({
      ready: true,
      violations: [],
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'retrieval.provider.unavailable' }),
        expect.objectContaining({ code: 'retrieval.vector-store.unavailable' }),
        expect.objectContaining({ code: 'retrieval.index.pending' }),
        expect.objectContaining({ code: 'retrieval.ranking.metrics-missing' }),
      ]),
    });
    expect(mocks.container.get).toHaveBeenCalledTimes(1);
  });

  test('rejects destructive knowledge delete before service call when confirmation is missing', async () => {
    const response = await invokeRouter(knowledgeRouter, {
      method: 'DELETE',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge/k-1',
    });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatchObject({
      code: 'OPERATION_CONFIRMATION_REQUIRED',
    });
    expect(mocks.knowledgeService.delete).not.toHaveBeenCalled();
  });

  test('rejects single knowledge publish before service call when confirmation is missing', async () => {
    const response = await invokeRouter(knowledgeRouter, {
      method: 'PATCH',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge/k-1/publish',
    });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatchObject({
      code: 'OPERATION_CONFIRMATION_REQUIRED',
    });
    expect(mocks.recipeProductionGateway.publish).not.toHaveBeenCalled();
    expect(mocks.searchEngine.refreshIndex).not.toHaveBeenCalled();
  });

  test('single knowledge publish is controller-authorized and reports freshness refresh', async () => {
    const response = await invokeRouter(knowledgeRouter, {
      method: 'PATCH',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge/k-1/publish?confirmed=true',
    });

    expect(response.status).toBe(200);
    expect(mocks.recipeProductionGateway.publish).toHaveBeenCalledWith('k-1', {
      ip: '',
      userAgent: '',
      userId: 'http-request',
    });
    expect(mocks.searchEngine.refreshIndex).toHaveBeenCalledWith({ force: true });
    expect(response.body.data).toMatchObject({
      publication: {
        confirmed: true,
        lifecycle: 'active',
        route: 'admin/controller',
      },
      searchFreshness: {
        searchIndex: { attempted: true, refreshed: true },
        vectorReconcile: { attempted: true, reconciled: true, missingQueued: 1 },
      },
    });
  });

  test('propagates Core retrieval-readiness rejection without falling back to KnowledgeService', async () => {
    mocks.recipeProductionGateway.publish.mockRejectedValueOnce(
      new Error('RETRIEVAL_READINESS_BLOCKED')
    );

    await expect(
      invokeRouter(knowledgeRouter, {
        method: 'PATCH',
        mountPath: '/api/v1/knowledge',
        path: '/api/v1/knowledge/k-1/publish?confirmed=true',
      })
    ).rejects.toThrow('RETRIEVAL_READINESS_BLOCKED');
    expect(mocks.knowledgeService.publish).not.toHaveBeenCalled();
  });

  test('batch publish keeps confirmation gate and reports one freshness refresh', async () => {
    const response = await invokeRouter(knowledgeRouter, {
      body: { ids: ['k-1', 'k-2'], confirmed: true },
      method: 'POST',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge/batch-publish',
    });

    expect(response.status).toBe(200);
    expect(mocks.recipeProductionGateway.publish).toHaveBeenCalledTimes(2);
    expect(mocks.searchEngine.refreshIndex).toHaveBeenCalledTimes(1);
    expect(response.body.data).toMatchObject({
      successCount: 2,
      publication: {
        confirmed: true,
        lifecycle: 'active',
        route: 'admin/controller',
      },
      searchFreshness: {
        searchIndex: { attempted: true, refreshed: true },
      },
    });
  });
});
