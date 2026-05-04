import { describe, expect, it } from 'vitest';
import {
  collectEvolutionDecisionIds,
  projectEvolutionAuditResult,
} from '../../lib/agent/runs/evolution/EvolutionAgentRun.js';
import type { ToolCallEntry } from '../../lib/agent/runtime/AgentRuntimeTypes.js';

function makeToolCall(args: Record<string, unknown>, result: unknown = {}): ToolCallEntry {
  return {
    tool: 'knowledge',
    args,
    result,
    durationMs: 1,
  };
}

describe('projectEvolutionAuditResult', () => {
  it('counts successful canonical knowledge.manage decisions by id', () => {
    const result = projectEvolutionAuditResult({
      reply: '',
      iterations: 3,
      toolCalls: [
        makeToolCall(
          {
            action: 'manage',
            params: { operation: 'evolve', id: 'recipe-1' },
          },
          { status: 'evolution_proposed', outcome: 'proposal-created' }
        ),
        makeToolCall(
          {
            action: 'manage',
            params: { operation: 'deprecate', id: 'recipe-2' },
          },
          { status: 'deprecated', outcome: 'immediately-executed' }
        ),
        makeToolCall(
          {
            action: 'manage',
            params: { operation: 'skip_evolution', id: 'recipe-3' },
          },
          { status: 'evolution_verified', outcome: 'verified' }
        ),
      ],
    });

    expect(result).toMatchObject({
      proposed: 1,
      deprecated: 1,
      skipped: 1,
      iterations: 3,
      toolCalls: 3,
    });
  });

  it('does not report duplicate skipped evolve decisions as proposals created', () => {
    const result = projectEvolutionAuditResult({
      reply: '',
      iterations: 2,
      toolCalls: [
        makeToolCall(
          {
            action: 'manage',
            params: { operation: 'evolve', id: 'recipe-1' },
          },
          { status: 'evolution_proposed', outcome: 'proposal-created' }
        ),
        makeToolCall(
          {
            action: 'manage',
            params: { operation: 'evolve', id: 'recipe-2' },
          },
          { status: 'evolution_proposed', outcome: 'skipped' }
        ),
      ],
    });

    expect(result.proposed).toBe(1);
    expect(result.deprecated).toBe(0);
  });

  it('does not count failed knowledge.manage decisions', () => {
    const result = projectEvolutionAuditResult({
      reply: '',
      iterations: 1,
      toolCalls: [
        makeToolCall(
          {
            action: 'manage',
            params: { operation: 'skip_evolution', id: 'recipe-1' },
          },
          { error: 'Evolution gateway not available' }
        ),
      ],
    });

    expect(result.skipped).toBe(0);
    expect(result.toolCalls).toBe(1);
  });

  it('collects unique expected decision ids and ignores unrelated ids', () => {
    const ids = collectEvolutionDecisionIds(
      [
        makeToolCall({
          action: 'manage',
          params: { operation: 'skip_evolution', id: 'recipe-1' },
        }),
        makeToolCall({
          action: 'manage',
          params: { operation: 'skip_evolution', id: 'recipe-1' },
        }),
        makeToolCall({
          action: 'manage',
          params: { operation: 'skip_evolution', id: 'unknown-recipe' },
        }),
      ],
      ['recipe-1', 'recipe-2']
    );

    expect([...ids]).toEqual(['recipe-1']);
  });
});
