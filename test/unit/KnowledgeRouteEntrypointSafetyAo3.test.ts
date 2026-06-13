import { describe, expect, test, vi } from 'vitest';
import { invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => ({
  knowledgeService: {
    delete: vi.fn(),
  },
  container: {
    get: vi.fn(),
  },
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

import knowledgeRouter from '../../lib/http/routes/knowledge.js';

describe('knowledge route entrypoint safety boundary', () => {
  test('rejects destructive knowledge delete before service call when confirmation is missing', async () => {
    mocks.container.get.mockImplementation((name: string) => {
      if (name === 'knowledgeService') {
        return mocks.knowledgeService;
      }
      throw new Error(`Unexpected service requested: ${name}`);
    });

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
});
