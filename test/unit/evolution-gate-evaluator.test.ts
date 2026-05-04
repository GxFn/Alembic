/**
 * evolution-gate-evaluator.test.ts
 *
 * evolutionGateEvaluator 的评估测试:
 *   - pass: 所有 Recipe 都已处理（按 id 去重）
 *   - retry: 还有未处理的 Recipe
 *   - 边界: 空输入
 *   - 兼容: existingRecipes 优先，回退 decayedRecipes
 *   - propose_evolution 计入已处理
 *   - 跨 tool 同一 id 去重
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
        makeToolCall('knowledge', {
          action: 'manage',
          params: { operation: 'evolve', id: 'recipe-1' },
        }),
        makeToolCall('confirm_deprecation', { recipeId: 'recipe-2' }),
        makeToolCall('skip_evolution', { recipeId: 'recipe-3' }),
      ],
    };
    const result = evolutionGateEvaluator(source, null, {
      existingRecipes: makeExistingRecipes(3),
    });
    expect(result.action).toBe('pass');
    expect(result.artifact).toMatchObject({ processed: 3, totalRecipes: 3, pendingIds: [] });
  });

  it('should count V2 knowledge.manage id decisions', () => {
    const source = {
      toolCalls: [
        makeToolCall('knowledge', {
          action: 'manage',
          params: { operation: 'skip_evolution', id: 'recipe-1' },
        }),
      ],
    };
    const result = evolutionGateEvaluator(source, null, {
      existingRecipes: makeExistingRecipes(1),
    });
    expect(result.action).toBe('pass');
    expect(result.artifact).toMatchObject({ processed: 1, totalRecipes: 1, pendingIds: [] });
  });

  it('should ignore failed V2 knowledge.manage decisions', () => {
    const source = {
      toolCalls: [
        {
          ...makeToolCall('knowledge', {
            action: 'manage',
            params: { operation: 'skip_evolution', id: 'recipe-1' },
          }),
          result: { error: 'knowledge.manage requires id' },
        },
      ],
    };
    const result = evolutionGateEvaluator(source, null, {
      existingRecipes: makeExistingRecipes(1),
    });
    expect(result.action).toBe('retry');
    expect(result.reason).toContain('0/1');
    expect(result.artifact).toMatchObject({ pendingIds: ['recipe-1'] });
  });

  it('should ignore decisions for ids outside the expected recipe set', () => {
    const source = {
      toolCalls: [
        makeToolCall('knowledge', {
          action: 'manage',
          params: { operation: 'skip_evolution', id: 'unknown-recipe' },
        }),
        makeToolCall('knowledge', {
          action: 'manage',
          params: { operation: 'skip_evolution', id: 'another-unknown-recipe' },
        }),
      ],
    };
    const result = evolutionGateEvaluator(source, null, {
      existingRecipes: makeExistingRecipes(2),
    });
    expect(result.action).toBe('retry');
    expect(result.artifact).toMatchObject({
      processed: 0,
      totalRecipes: 2,
      pendingIds: ['recipe-1', 'recipe-2'],
    });
  });

  it('should pass when cumulative retry calls cover all expected ids', () => {
    const source = {
      toolCalls: [
        makeToolCall('knowledge', {
          action: 'manage',
          params: { operation: 'skip_evolution', id: 'recipe-1' },
        }),
        makeToolCall('knowledge', {
          action: 'manage',
          params: { operation: 'skip_evolution', id: 'recipe-2' },
        }),
      ],
    };
    const result = evolutionGateEvaluator(source, null, {
      existingRecipes: makeExistingRecipes(2),
    });
    expect(result.action).toBe('pass');
    expect(result.artifact).toMatchObject({ processed: 2, totalRecipes: 2, pendingIds: [] });
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
    expect(result.artifact).toMatchObject({ pendingIds: ['recipe-2', 'recipe-3'] });
  });

  it('should pass with empty existingRecipes', () => {
    const result = evolutionGateEvaluator(null, null, { existingRecipes: [] });
    expect(result.action).toBe('pass');
    expect(result.artifact).toMatchObject({ processed: 0, totalRecipes: 0, pendingIds: [] });
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
    expect(result.artifact).toMatchObject({ processed: 3, totalRecipes: 3, pendingIds: [] });
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
    expect(result.artifact).toMatchObject({ processed: 1, totalRecipes: 1, pendingIds: [] });
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
    expect(result.artifact).toMatchObject({ processed: 3, totalRecipes: 3, pendingIds: [] });
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
    expect(result.artifact).toMatchObject({
      processed: 1,
      totalRecipes: 2,
      pendingIds: ['recipe-2'],
    });
  });
});
