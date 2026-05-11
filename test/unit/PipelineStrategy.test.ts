import { describe, expect, it, vi } from 'vitest';
import { AgentMessage } from '../../lib/agent/runtime/AgentMessage.js';
import { PipelineStrategy } from '../../lib/agent/strategies/PipelineStrategy.js';

function decisionCall(id: string) {
  return {
    tool: 'knowledge',
    args: {
      action: 'manage',
      params: { operation: 'skip_evolution', id, reason: 'verified valid' },
    },
  };
}

describe('PipelineStrategy gate retries', () => {
  it('can evaluate gate retries with cumulative tool calls', async () => {
    let runCount = 0;
    const runtime = {
      id: 'runtime-1',
      reactLoop: vi.fn(async () => {
        runCount++;
        return {
          reply: `run ${runCount}`,
          toolCalls: [decisionCall(`recipe-${runCount}`)],
          tokenUsage: { input: 1, output: 1 },
          iterations: 1,
        };
      }),
    };
    const strategy = new PipelineStrategy({
      stages: [
        {
          name: 'evolve',
          promptBuilder: () => 'decide',
          retryPromptBuilder: () => 'retry decide',
        },
        {
          name: 'gate',
          gate: {
            useCumulativeToolCalls: true,
            maxRetries: 2,
            evaluator: (source: unknown, _phaseResults, ctx) => {
              const toolCalls =
                (source as { toolCalls?: Array<{ args?: Record<string, unknown> }> }).toolCalls ??
                [];
              const expectedIds = (ctx.existingRecipes as Array<{ id: string }>).map((r) => r.id);
              const processed = new Set(
                toolCalls.map((tc) => {
                  const params = tc.args?.params as Record<string, unknown> | undefined;
                  return params?.id;
                })
              );
              const pendingIds = expectedIds.filter((id) => !processed.has(id));
              return pendingIds.length === 0
                ? { action: 'pass', artifact: { pendingIds } }
                : {
                    action: 'retry',
                    reason: 'pending decisions',
                    artifact: { pendingIds },
                  };
            },
          },
        },
      ],
    });

    const result = await strategy.execute(
      runtime as never,
      new AgentMessage({ content: 'audit' }),
      {
        strategyContext: {
          existingRecipes: [{ id: 'recipe-1' }, { id: 'recipe-2' }],
        },
      }
    );

    expect(runtime.reactLoop).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.phases.gate).toMatchObject({ action: 'pass' });
  });
});
