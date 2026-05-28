import { describe, expect, test, vi } from 'vitest';
import { getRouter, invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => {
  return {
    container: {
      get: vi.fn(),
      singletons: {},
    },
  };
});

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

import aiRouter from '../../lib/http/routes/ai.js';

const disabledProviderId = ['mo', 'ck'].join('');

describe('AI runtime product mock removal', () => {
  test('reports AI unavailable without exposing a product mock provider', async () => {
    const previousProvider = process.env.ALEMBIC_AI_PROVIDER;
    process.env.ALEMBIC_AI_PROVIDER = disabledProviderId;
    try {
      const providersResponse = await getRouter(aiRouter, '/api/v1/ai/providers', {
        mountPath: '/api/v1/ai',
      });
      const providersData = providersResponse.body.data as Record<string, unknown>;
      const providers = providersData.providers as Array<{ id: string }>;

      expect(providersResponse.status).toBe(200);
      expect(providers.map((provider) => provider.id)).not.toContain(disabledProviderId);
      expect(providersData.active).toMatchObject({ provider: '' });
      expect(providersData.ai).toMatchObject({
        ready: false,
        unavailableReason: 'not-configured',
      });

      const configResponse = await getRouter(aiRouter, '/api/v1/ai/config', {
        mountPath: '/api/v1/ai',
      });
      expect(configResponse.status).toBe(200);
      expect(configResponse.body.data).toMatchObject({
        provider: null,
        model: null,
        isMock: false,
        isReady: false,
        unavailableReason: 'not-configured',
      });
    } finally {
      if (previousProvider === undefined) {
        delete process.env.ALEMBIC_AI_PROVIDER;
      } else {
        process.env.ALEMBIC_AI_PROVIDER = previousProvider;
      }
    }
  });

  test('rejects product runtime requests that still select the mock provider', async () => {
    const probeResponse = await invokeRouter(aiRouter, {
      body: { provider: disabledProviderId },
      method: 'POST',
      mountPath: '/api/v1/ai',
      path: '/api/v1/ai/probe',
    });
    expect(probeResponse.status).toBe(400);
    expect(probeResponse.body.error).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });

    const configResponse = await invokeRouter(aiRouter, {
      body: { provider: disabledProviderId },
      method: 'POST',
      mountPath: '/api/v1/ai',
      path: '/api/v1/ai/config',
    });
    expect(configResponse.status).toBe(400);
    expect(configResponse.body.error).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
  });

  test('does not expose the historical cleanup endpoint', async () => {
    await expect(
      invokeRouter(aiRouter, {
        method: 'POST',
        mountPath: '/api/v1/ai',
        path: `/api/v1/ai/${disabledProviderId}/cleanup`,
      })
    ).rejects.toThrow('No Express route handled');
  });
});
