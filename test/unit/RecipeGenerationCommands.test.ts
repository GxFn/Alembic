import { beforeEach, describe, expect, test, vi } from 'vitest';
import { invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => ({
  runtime: {
    dryRun: vi.fn(),
    rebuild: vi.fn(),
    rollback: vi.fn(),
    status: vi.fn(),
  },
  container: {
    get: vi.fn(),
    services: {},
    singletons: {},
  },
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

import commandsRouter from '../../lib/http/routes/commands.js';

describe('Recipe generation command surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.container.get.mockImplementation((name: string) => {
      if (name === 'recipeVectorGenerationRuntime') {
        return mocks.runtime;
      }
      throw new Error(`Unexpected service requested: ${name}`);
    });
    mocks.runtime.status.mockResolvedValue({ active: null, manifest: null });
    mocks.runtime.dryRun.mockResolvedValue({ status: 'dry-run', writePerformed: false });
    mocks.runtime.rebuild.mockResolvedValue({ status: 'activated', generationId: 'generation-1' });
    mocks.runtime.rollback.mockResolvedValue({
      status: 'rolled-back',
      generationId: 'generation-0',
    });
  });

  test('dry-run is callable without mutation confirmation and reports zero-write', async () => {
    const response = await invokeRouter(commandsRouter, {
      method: 'POST',
      mountPath: '/api/v1/commands',
      path: '/api/v1/commands/recipe-index-generation/dry-run',
    });

    expect(response.status).toBe(200);
    expect(mocks.runtime.dryRun).toHaveBeenCalledWith('migration');
    expect(response.body.data).toMatchObject({ status: 'dry-run', writePerformed: false });
  });

  test('rebuild is rejected before runtime invocation without explicit confirmation', async () => {
    const response = await invokeRouter(commandsRouter, {
      method: 'POST',
      mountPath: '/api/v1/commands',
      path: '/api/v1/commands/recipe-index-generation/rebuild',
    });

    expect(response.status).toBe(400);
    expect(mocks.runtime.rebuild).not.toHaveBeenCalled();
  });

  test('confirmed rebuild and rollback use the generation runtime', async () => {
    const rebuild = await invokeRouter(commandsRouter, {
      body: { confirmed: true },
      method: 'POST',
      mountPath: '/api/v1/commands',
      path: '/api/v1/commands/recipe-index-generation/rebuild',
    });
    const rollback = await invokeRouter(commandsRouter, {
      body: { confirmed: true, generationId: 'generation-0' },
      method: 'POST',
      mountPath: '/api/v1/commands',
      path: '/api/v1/commands/recipe-index-generation/rollback',
    });

    expect(rebuild.status).toBe(200);
    expect(mocks.runtime.rebuild).toHaveBeenCalledWith('migration');
    expect(rollback.status).toBe(200);
    expect(mocks.runtime.rollback).toHaveBeenCalledWith('generation-0');
  });
});
