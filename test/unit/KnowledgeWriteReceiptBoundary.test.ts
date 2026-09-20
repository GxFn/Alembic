import { DivergenceError } from '@alembic/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => ({
  knowledgeService: {
    update: vi.fn(),
    deprecate: vi.fn(),
    reactivate: vi.fn(),
    stage: vi.fn(),
    evolve: vi.fn(),
    decay: vi.fn(),
    restore: vi.fn(),
  },
  gateway: { publish: vi.fn() },
  searchEngine: { refreshIndex: vi.fn() },
  container: { get: vi.fn(), services: { searchEngine: true } },
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: () => mocks.container,
}));

import knowledgeRouter from '../../lib/http/routes/knowledge.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  mocks.container.get.mockImplementation((name: string) => {
    if (name === 'knowledgeService') {
      return mocks.knowledgeService;
    }
    if (name === 'recipeProductionGateway') {
      return mocks.gateway;
    }
    if (name === 'searchEngine') {
      return mocks.searchEngine;
    }
    throw new Error(`Unexpected fixture service: ${name}`);
  });
});
afterEach(() => vi.unstubAllEnvs());

const mutations = [
  { operation: 'update', suffix: '', body: { title: 'Changed title' } },
  { operation: 'deprecate', suffix: '/deprecate', body: { reason: 'No longer current' } },
  { operation: 'reactivate', suffix: '/reactivate', body: {} },
  { operation: 'stage', suffix: '/stage', body: {} },
  { operation: 'evolve', suffix: '/evolve', body: {} },
  { operation: 'decay', suffix: '/decay', body: {} },
  { operation: 'restore', suffix: '/restore', body: {} },
  { operation: 'publish', suffix: '/publish', body: {} },
] as const;

describe('knowledge route write receipt boundary', () => {
  it.each(mutations)('does not report a missing $operation receipt as a successful DTO', async ({
    operation,
    suffix,
    body,
  }) => {
    const mutate =
      operation === 'publish' ? mocks.gateway.publish : mocks.knowledgeService[operation];
    let observedWrites = 0;
    mutate.mockImplementation(async () => {
      observedWrites++;
      return null;
    });
    const response = await invokeRouter(knowledgeRouter, {
      method: 'PATCH',
      mountPath: '/api/v1/knowledge',
      path: `/api/v1/knowledge/k-1${suffix}?confirmed=true`,
      body,
    });
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'KNOWLEDGE_WRITE_RECEIPT_UNAVAILABLE',
        retryable: false,
        details: {
          operation,
          id: 'k-1',
          writeState: 'unknown',
          requiresReadback: true,
          retryable: false,
        },
      },
    });
    expect(response.body).not.toHaveProperty('data');
    expect(observedWrites).toBe(1); // 缺回执并不说明服务没有写入，不能自动重试。
    expect(mocks.searchEngine.refreshIndex).not.toHaveBeenCalled();
  });

  it.each([
    'publish',
    'deprecate',
  ] as const)('preserves the confirmed subset of a partial batch %s', async (operation) => {
    const mutate =
      operation === 'publish' ? mocks.gateway.publish : mocks.knowledgeService.deprecate;
    mutate.mockImplementation(async (id: string) =>
      id === 'known' ? { id, title: 'Known receipt' } : null
    );
    const response = await invokeRouter(knowledgeRouter, {
      method: 'POST',
      mountPath: '/api/v1/knowledge',
      path: `/api/v1/knowledge/batch-${operation}`,
      body: { ids: ['known', 'unknown'], confirmed: true, reason: 'Fixture deprecation' },
    });
    const data = response.body.data as Record<string, unknown>;
    expect(data).toMatchObject({
      successCount: 1,
      failureCount: 1,
      total: 2,
      partial: true,
      unknownCount: 1,
      requiresReadback: true,
      retryable: false,
      failed: [
        {
          id: 'unknown',
          code: 'KNOWLEDGE_WRITE_RECEIPT_UNAVAILABLE',
          retryable: false,
          details: { operation, id: 'unknown', writeState: 'unknown', requiresReadback: true },
        },
      ],
    });
    expect(data[operation === 'publish' ? 'published' : 'deprecated']).toEqual([
      { id: 'known', title: 'Known receipt' },
    ]);
    if (operation === 'publish') {
      // 既有 confirmed 是入口控制器确认；写入成功仅由 published 子集证明。
      expect(data.publication).toMatchObject({ confirmed: true, route: 'admin/controller' });
    }
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it('preserves a Core error and its details without relabeling it as a null receipt', async () => {
    const error = new DivergenceError('File persisted, DB readback failed', {
      code: 'knowledge-file-db-divergence',
      fileOpsCompleted: 1,
      reconcileVia: 'KnowledgeSyncService.sync',
    });
    mocks.knowledgeService.update.mockRejectedValueOnce(error);
    await expect(
      invokeRouter(knowledgeRouter, {
        method: 'PATCH',
        mountPath: '/api/v1/knowledge',
        path: '/api/v1/knowledge/k-1',
        body: { title: 'Changed title' },
      })
    ).rejects.toBe(error);
    expect(mocks.knowledgeService.update).toHaveBeenCalledOnce();
  });

  it('reports an all-unknown batch without inventing a confirmed write subset', async () => {
    mocks.gateway.publish.mockResolvedValue(null);
    const response = await invokeRouter(knowledgeRouter, {
      method: 'POST',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge/batch-publish',
      body: { ids: ['first', 'second'], confirmed: true },
    });
    expect(response.body.data).toMatchObject({
      published: [],
      successCount: 0,
      failureCount: 2,
      unknownCount: 2,
      partial: false,
      requiresReadback: true,
      retryable: false,
      publication: { confirmed: true },
    });
    expect(mocks.gateway.publish).toHaveBeenCalledTimes(2);
  });

  it('keeps a confirmed non-null update DTO unchanged', async () => {
    mocks.knowledgeService.update.mockResolvedValue({
      toJSON: () => ({ id: 'k-1', title: 'Confirmed title', lifecycle: 'pending' }),
    });
    const response = await invokeRouter(knowledgeRouter, {
      method: 'PATCH',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge/k-1',
      body: { title: 'Confirmed title' },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { id: 'k-1', title: 'Confirmed title', lifecycle: 'pending' },
    });
  });
});
