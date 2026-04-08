/**
 * evolution-gate-evaluator.test.ts
 *
 * evolutionGateEvaluator 的三状态评估测试:
 *   - pass: 所有 Recipe 都已处理
 *   - retry: 还有未处理的 Recipe
 *   - 边界: 空输入
 */

import { describe, expect, it } from 'vitest';
import { evolutionGateEvaluator } from '../../lib/agent/domain/insight-gate.js';

// ── Helpers ──────────────────────────────────────────────

function makeToolCall(name: string, args: Record<string, unknown> = {}) {
  return { tool: name, name, args };
}

function makeDecayedRecipes(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `recipe-${i + 1}` }));
}

// ── Tests ────────────────────────────────────────────────

describe('evolutionGateEvaluator', () => {
  it('should pass when all recipes are processed', () => {
    const source = {
      toolCalls: [
        makeToolCall('submit_knowledge', { supersedes: 'recipe-1' }),
        makeToolCall('confirm_deprecation', { recipeId: 'recipe-2' }),
        makeToolCall('skip_evolution', { recipeId: 'recipe-3' }),
      ],
    };
    const result = evolutionGateEvaluator(source, null, { decayedRecipes: makeDecayedRecipes(3) });
    expect(result.action).toBe('pass');
    expect(result.artifact).toEqual({
      evolved: 1,
      deprecated: 1,
      skipped: 1,
      totalRecipes: 3,
    });
  });

  it('should retry when some recipes are unprocessed', () => {
    const source = {
      toolCalls: [makeToolCall('submit_knowledge', { supersedes: 'recipe-1' })],
    };
    const result = evolutionGateEvaluator(source, null, { decayedRecipes: makeDecayedRecipes(3) });
    expect(result.action).toBe('retry');
    expect(result.reason).toContain('1/3');
  });

  it('should pass with empty decayed recipes', () => {
    const result = evolutionGateEvaluator(null, null, { decayedRecipes: [] });
    expect(result.action).toBe('pass');
    expect(result.artifact).toEqual({
      evolved: 0,
      deprecated: 0,
      skipped: 0,
      totalRecipes: 0,
    });
  });

  it('should pass when strategyContext is empty (no decayedRecipes)', () => {
    const result = evolutionGateEvaluator(null, null, {});
    expect(result.action).toBe('pass');
  });

  it('should pass with default strategyContext', () => {
    const result = evolutionGateEvaluator(null, null);
    expect(result.action).toBe('pass');
  });

  it('should not count submit_knowledge without supersedes as evolved', () => {
    const source = {
      toolCalls: [
        // 普通 submit — 没有 supersedes
        makeToolCall('submit_knowledge', { title: 'New recipe' }),
        makeToolCall('confirm_deprecation', { recipeId: 'recipe-2' }),
      ],
    };
    const result = evolutionGateEvaluator(source, null, { decayedRecipes: makeDecayedRecipes(2) });
    // Only deprecated counts, evolved = 0 since no supersedes
    expect(result.action).toBe('retry');
    expect(result.reason).toContain('1/2');
  });

  it('should count all deprecated decisions correctly', () => {
    const source = {
      toolCalls: [
        makeToolCall('confirm_deprecation', { recipeId: 'recipe-1' }),
        makeToolCall('confirm_deprecation', { recipeId: 'recipe-2' }),
        makeToolCall('confirm_deprecation', { recipeId: 'recipe-3' }),
      ],
    };
    const result = evolutionGateEvaluator(source, null, { decayedRecipes: makeDecayedRecipes(3) });
    expect(result.action).toBe('pass');
    expect(result.artifact).toEqual({
      evolved: 0,
      deprecated: 3,
      skipped: 0,
      totalRecipes: 3,
    });
  });

  it('should handle null source gracefully', () => {
    const result = evolutionGateEvaluator(null, null, { decayedRecipes: makeDecayedRecipes(2) });
    expect(result.action).toBe('retry');
    expect(result.reason).toContain('0/2');
  });
});
