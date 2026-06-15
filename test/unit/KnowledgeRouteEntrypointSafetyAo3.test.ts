import { describe, expect, test, vi } from 'vitest';
import { invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => ({
  knowledgeService: {
    delete: vi.fn(),
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
    mocks.searchEngine.refreshIndex.mockResolvedValue(undefined);
    mocks.vectorService.syncCoordinator.reconcile.mockResolvedValue({
      missingQueued: 1,
      orphansRemoved: 0,
    });
    mocks.container.get.mockImplementation((name: string) => {
      if (name === 'knowledgeService') {
        return mocks.knowledgeService;
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
    expect(mocks.knowledgeService.publish).not.toHaveBeenCalled();
    expect(mocks.searchEngine.refreshIndex).not.toHaveBeenCalled();
  });

  test('single knowledge publish is controller-authorized and reports freshness refresh', async () => {
    const response = await invokeRouter(knowledgeRouter, {
      method: 'PATCH',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge/k-1/publish?confirmed=true',
    });

    expect(response.status).toBe(200);
    expect(mocks.knowledgeService.publish).toHaveBeenCalledWith('k-1', {
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

  test('batch publish keeps confirmation gate and reports one freshness refresh', async () => {
    const response = await invokeRouter(knowledgeRouter, {
      body: { ids: ['k-1', 'k-2'], confirmed: true },
      method: 'POST',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge/batch-publish',
    });

    expect(response.status).toBe(200);
    expect(mocks.knowledgeService.publish).toHaveBeenCalledTimes(2);
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
