import { describe, expect, test, vi } from 'vitest';
import { invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => ({
  auditLogger: {
    log: vi.fn(),
  },
  knowledgeService: {
    create: vi.fn(),
  },
  container: {
    get: vi.fn(),
  },
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

import knowledgeRouter from '../../lib/http/routes/knowledge.js';

describe('knowledge route AO3 permission boundary', () => {
  test('fails closed and audits when PermissionManager is unavailable', async () => {
    mocks.container.get.mockImplementation((name: string) => {
      if (name === 'permissionManager') {
        throw new Error('permission manager offline');
      }
      if (name === 'auditLogger') {
        return mocks.auditLogger;
      }
      if (name === 'knowledgeService') {
        return mocks.knowledgeService;
      }
      throw new Error(`Unexpected service requested: ${name}`);
    });

    const response = await invokeRouter(knowledgeRouter, {
      body: {
        content: 'Always validate permissions before writes.',
        title: 'Permission Boundary',
      },
      method: 'POST',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge',
    });

    expect(response.status).toBe(403);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatchObject({
      code: 'PERMISSION_CHECK_UNAVAILABLE',
      reasonCode: 'permission-denied',
    });
    expect(mocks.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'knowledge.permission.check',
        actor: 'anonymous',
        result: 'failure',
      })
    );
    expect(mocks.knowledgeService.create).not.toHaveBeenCalled();
  });
});
