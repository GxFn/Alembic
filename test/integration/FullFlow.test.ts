import AppRuntime from '../../lib/Bootstrap.js';

describe('Integration: Complete Gateway Flow', () => {
  let appRuntime;
  let components;

  beforeAll(async () => {
    appRuntime = new AppRuntime({ env: 'test' });
    components = await appRuntime.initialize();
  });

  afterAll(async () => {
    await appRuntime.shutdown();
  });

  describe('Full request flow', () => {
    test('handles a complete read operation', async () => {
      const { gateway } = components;

      gateway.register('read_recipes', async () => [
        { id: '1', name: 'Recipe 1' },
        { id: '2', name: 'Recipe 2' },
      ]);

      const result = await gateway.execute({
        actor: 'http-request',
        action: 'read_recipes',
        resource: '/recipes',
      });

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.requestId).toBeDefined();
    });

    test('routes write-shaped actions without actor authority checks', async () => {
      const { gateway } = components;

      gateway.register('create_recipe', async () => ({ recipeId: '123' }));

      const result = await gateway.execute({
        actor: 'http-request',
        action: 'create_recipe',
        resource: '/recipes',
        data: {
          name: 'New Recipe',
          code: 'function example() {}',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data.recipeId).toBe('123');
    });

    test('passes complete candidate data to the registered handler', async () => {
      const { gateway } = components;

      gateway.register('submit_knowledge', async (context) => ({
        candidateId: 'cand-123',
        title: context.data.name,
      }));

      const result = await gateway.execute({
        actor: 'http-request',
        action: 'submit_knowledge',
        resource: '/candidates',
        data: {
          name: 'Good Candidate',
          code: 'function helper() { return true; }',
          reasoning: {
            whyStandard: 'Following best practices',
            sources: ['documentation', 'code review guidelines'],
            qualitySignals: { clarity: 0.95, reusability: 0.9 },
            alternatives: ['inline approach'],
            confidence: 0.92,
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ candidateId: 'cand-123', title: 'Good Candidate' });
    });
  });

  describe('Source-label invariance', () => {
    const sourceLabels = ['http-request', 'dashboard-source', 'batch-runner'];

    for (const actor of sourceLabels) {
      test(`routes ${actor} through the same registered handler`, async () => {
        const { gateway } = components;
        const action = `source_invariance_${actor.replace(/[^a-z0-9]/gi, '_')}`;

        gateway.register(action, async (context) => ({
          actor: context.actor,
          accepted: true,
        }));

        const result = await gateway.execute({
          actor,
          action,
          resource: '/test',
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual({ actor, accepted: true });
      });
    }
  });

  describe('Error recovery', () => {
    test('continues operation after handler error', async () => {
      const { gateway } = components;

      gateway.register('error_action', async () => {
        throw new Error('Handler crashed');
      });

      const result1 = await gateway.execute({
        actor: 'http-request',
        action: 'error_action',
        resource: '/test',
      });

      expect(result1.success).toBe(false);

      gateway.register('success_action', async () => ({ ok: true }));

      const result2 = await gateway.execute({
        actor: 'http-request',
        action: 'success_action',
        resource: '/test',
      });

      expect(result2.success).toBe(true);
    });
  });
});
