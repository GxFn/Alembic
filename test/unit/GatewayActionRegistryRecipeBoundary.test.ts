import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Gateway } from '../../lib/governance/gateway/Gateway.js';
import { registerGatewayActions } from '../../lib/governance/gateway/GatewayActionRegistry.js';

describe('Gateway Recipe production boundary', () => {
  const knowledgeService = {
    create: vi.fn(),
    publish: vi.fn(),
  };
  const recipeProductionGateway = {
    publish: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    recipeProductionGateway.publish.mockResolvedValue({ id: 'recipe-1', lifecycle: 'active' });
  });

  test('legacy create actions are absent and cannot invoke KnowledgeService.create', async () => {
    const gateway = registeredGateway();

    expect(gateway.getRegisteredActions()).not.toEqual(
      expect.arrayContaining(['candidate:create', 'recipe:create'])
    );
    for (const action of ['candidate:create', 'recipe:create']) {
      const result = await gateway.execute({
        action,
        actor: 'runtime-probe',
        data: { title: 'must not be written' },
        resource: 'knowledge',
      });
      expect(result).toMatchObject({
        success: false,
        error: { code: 'INTERNAL_ERROR' },
      });
    }
    expect(knowledgeService.create).not.toHaveBeenCalled();
    expect(gateway.getRegisteredActions()).toEqual(
      expect.arrayContaining(['candidate:list', 'candidate:get', 'recipe:list', 'recipe:get'])
    );
  });

  test('legacy publish aliases consume RecipeProductionGateway readiness', async () => {
    const gateway = registeredGateway();

    for (const [action, data] of [
      ['candidate:approve', { candidateId: 'recipe-1' }],
      ['candidate:apply_to_recipe', { candidateId: 'recipe-1' }],
      ['recipe:publish', { recipeId: 'recipe-1' }],
    ] as const) {
      const result = await gateway.execute({
        action,
        actor: 'runtime-probe',
        data,
        resource: 'knowledge',
      });
      expect(result.success).toBe(true);
    }
    expect(recipeProductionGateway.publish).toHaveBeenCalledTimes(3);
    expect(knowledgeService.publish).not.toHaveBeenCalled();
  });

  function registeredGateway() {
    const gateway = new Gateway();
    registerGatewayActions(gateway, {
      get(name: string) {
        if (name === 'knowledgeService') {
          return knowledgeService;
        }
        if (name === 'recipeProductionGateway') {
          return recipeProductionGateway;
        }
        return {};
      },
    });
    return gateway;
  }
});
