/**
 * evolution-gate-evaluator.test.ts
 *
 * evolutionGateEvaluator 的评估测试:
 *   - pass: 所有 Recipe 都已处理（按 recipeId 去重）
 *   - retry: 还有未处理的 Recipe
 *   - 边界: 空输入
 *   - 兼容: existingRecipes 优先，回退 decayedRecipes
 *   - propose_evolution 计入已处理
 *   - 跨 tool 同一 recipeId 去重
 */

import { describe, expect, it } from 'vitest';
import { evolutionGateEvaluator } from '../../lib/agent/prompts/insight-gate.js';

// ── Helpers ──────────────────────────────────────────────

function makeToolCall(name: string, args: Record<string, unknown> = {}) {
  return { tool: name, name, args };
}

function makeExistingRecipes(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `recipe-${i + 1}` }));
}

// ── Tests ────────────────────────────────────────────────

describe('evolutionGateEvaluator', () => {
  it('should pass when all recipes are processed (existingRecipes)', () => {
    const source = {
      toolCalls: [
        makeToolCall('knowledge', { supersedes: 'recipe-1' }),
        makeToolCall('confirm_deprecation', { recipeId: 'recipe-2' }),
        makeToolCall('skip_evolution', { recipeId: 'recipe-3' }),
      ],
    };
    const result = evolutionGateEvaluator(source, null, {
      existingRecipes: makeExistingRecipes(3),
    });
    expect(result.action).toBe('pass');
    expect(result.artifact).toEqual({ processed: 3, totalRecipes: 3 });
  });

  it('should retry when some recipes are unprocessed', () => {
    const source = {
      toolCalls: [makeToolCall('knowledge', { supersedes: 'recipe-1' })],
    };
    const result = evolutionGateEvaluator(source, null, {
      existingRecipes: makeExistingRecipes(3),
    });
    expect(result.action).toBe('retry');
    expect(result.reason).toContain('1/3');
  });

  it('should pass with empty existingRecipes', () => {
    const result = evolutionGateEvaluator(null, null, { existingRecipes: [] });
    expect(result.action).toBe('pass');
    expect(result.artifact).toEqual({ processed: 0, totalRecipes: 0 });
  });

  it('should pass when strategyContext is empty (no recipes)', () => {
    const result = evolutionGateEvaluator(null, null, {});
    expect(result.action).toBe('pass');
  });

  it('should pass with default strategyContext', () => {
    const result = evolutionGateEvaluator(null, null);
    expect(result.action).toBe('pass');
  });

  it('should not count knowledge without supersedes as processed', () => {
    const source = {
      toolCalls: [
        makeToolCall('knowledge', { title: 'New recipe' }),
        makeToolCall('confirm_deprecation', { recipeId: 'recipe-2' }),
      ],
    };
    const result = evolutionGateEvaluator(source, null, {
      existingRecipes: makeExistingRecipes(2),
    });
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
    const result = evolutionGateEvaluator(source, null, {
      existingRecipes: makeExistingRecipes(3),
    });
    expect(result.action).toBe('pass');
    expect(result.artifact).toEqual({ processed: 3, totalRecipes: 3 });
  });

  it('should handle null source gracefully', () => {
    const result = evolutionGateEvaluator(null, null, {
      existingRecipes: makeExistingRecipes(2),
    });
    expect(result.action).toBe('retry');
    expect(result.reason).toContain('0/2');
  });

  it('should fall back to decayedRecipes for backward compat', () => {
    const source = {
      toolCalls: [makeToolCall('skip_evolution', { recipeId: 'recipe-1' })],
    };
    const result = evolutionGateEvaluator(source, null, {
      decayedRecipes: makeExistingRecipes(1),
    });
    expect(result.action).toBe('pass');
    expect(result.artifact).toEqual({ processed: 1, totalRecipes: 1 });
  });

  it('should count propose_evolution as processed', () => {
    const source = {
      toolCalls: [
        makeToolCall('propose_evolution', { recipeId: 'recipe-1' }),
        makeToolCall('skip_evolution', { recipeId: 'recipe-2' }),
        makeToolCall('confirm_deprecation', { recipeId: 'recipe-3' }),
      ],
    };
    const result = evolutionGateEvaluator(source, null, {
      existingRecipes: makeExistingRecipes(3),
    });
    expect(result.action).toBe('pass');
    expect(result.artifact).toEqual({ processed: 3, totalRecipes: 3 });
  });

  it('should deduplicate same recipeId across tools', () => {
    const source = {
      toolCalls: [
        makeToolCall('propose_evolution', { recipeId: 'recipe-1' }),
        makeToolCall('knowledge', { supersedes: 'recipe-1' }),
      ],
    };
    const result = evolutionGateEvaluator(source, null, {
      existingRecipes: makeExistingRecipes(2),
    });
    expect(result.action).toBe('retry');
    expect(result.reason).toContain('1/2');
  });

  it('should not count duplicate calls for same recipe', () => {
    const source = {
      toolCalls: [
        makeToolCall('skip_evolution', { recipeId: 'recipe-1' }),
        makeToolCall('skip_evolution', { recipeId: 'recipe-1' }),
      ],
    };
    const result = evolutionGateEvaluator(source, null, {
      existingRecipes: makeExistingRecipes(2),
    });
    expect(result.action).toBe('retry');
    expect(result.artifact).toBeUndefined();
  });
});
