import { describe, expect, it, vi } from 'vitest';
import { handle } from '../../lib/tools/v2/handlers/knowledge.js';
import type { ToolContext } from '../../lib/tools/v2/types.js';

function makeContext(evolutionGateway: unknown): ToolContext {
  return {
    projectRoot: '/project',
    tokenBudget: 1000,
    evolutionGateway,
    runtime: {
      sharedState: {
        evolutionProposalSource: 'rescan-evolution',
      },
    },
  };
}

describe('knowledge.manage evolution operations', () => {
  it('routes evolve decisions through EvolutionGateway with canonical id', async () => {
    const gateway = {
      submit: vi.fn(async () => ({
        recipeId: 'recipe-1',
        action: 'update',
        outcome: 'proposal-created',
        proposalId: 'ep-1',
      })),
    };

    const result = await handle(
      'manage',
      {
        operation: 'evolve',
        id: 'recipe-1',
        reason: 'source changed',
        data: {
          description: 'Network API changed',
          confidence: 0.82,
          evidence: { sourceStatus: 'modified', currentCode: 'func request() async' },
          suggestedChanges: '{"patchVersion":1,"changes":[]}',
        },
      },
      makeContext(gateway)
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      operation: 'evolve',
      id: 'recipe-1',
      status: 'evolution_proposed',
      proposalId: 'ep-1',
    });
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipeId: 'recipe-1',
        action: 'update',
        source: 'rescan-evolution',
        confidence: 0.82,
        description: 'Network API changed',
        reason: 'source changed',
      })
    );
    expect(gateway.submit.mock.calls[0][0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceStatus: 'modified' }),
        expect.objectContaining({ suggestedChanges: '{"patchVersion":1,"changes":[]}' }),
      ])
    );
  });

  it('routes skip_evolution as a valid verification decision', async () => {
    const gateway = {
      submit: vi.fn(async () => ({
        recipeId: 'recipe-1',
        action: 'valid',
        outcome: 'verified',
      })),
    };

    const result = await handle(
      'manage',
      {
        operation: 'skip_evolution',
        id: 'recipe-1',
        reason: '验证有效: 代码与描述完全匹配',
      },
      makeContext(gateway)
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      operation: 'skip_evolution',
      id: 'recipe-1',
      status: 'evolution_verified',
    });
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipeId: 'recipe-1',
        action: 'valid',
        confidence: 0.9,
        source: 'rescan-evolution',
      })
    );
  });

  it('requires EvolutionGateway for evolution decisions', async () => {
    const result = await handle(
      'manage',
      {
        operation: 'evolve',
        id: 'recipe-1',
        reason: 'source changed',
      },
      makeContext(undefined)
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Evolution gateway not available');
  });
});
