/**
 * evolution-tools.test.ts
 *
 * confirm_deprecation / skip_evolution 工具处理器测试:
 *   - 正常路径
 *   - Proposal 解决
 *   - ProposalRepository 不可用时的容错
 */

import { describe, expect, it, vi } from 'vitest';
import type { ToolHandlerContext } from '../../lib/agent/tools/_shared.js';
import { confirmDeprecation, skipEvolution } from '../../lib/agent/tools/evolution-tools.js';

// ── Helpers ──────────────────────────────────────────────

function makeContext(services: Record<string, unknown> = {}): ToolHandlerContext {
  return {
    container: {
      get(name: string) {
        return services[name] ?? null;
      },
    },
    projectRoot: '/test/project',
  };
}

// ── confirm_deprecation ──────────────────────────────────

describe('confirmDeprecation', () => {
  it('should have correct tool metadata', () => {
    expect(confirmDeprecation.name).toBe('confirm_deprecation');
    expect(confirmDeprecation.parameters.required).toContain('recipeId');
    expect(confirmDeprecation.parameters.required).toContain('reason');
  });

  it('should call knowledgeService.deprecate and return result', async () => {
    const deprecateFn = vi.fn().mockReturnValue({ success: true });
    const ctx = makeContext({
      knowledgeService: { deprecate: deprecateFn },
    });

    const result = await confirmDeprecation.handler(
      { recipeId: 'recipe-abc', reason: '源文件已删除' },
      ctx
    );

    expect(deprecateFn).toHaveBeenCalledWith('recipe-abc', '源文件已删除', {
      userId: 'evolution-agent',
    });
    expect(result.status).toBe('deprecated');
    expect(result.recipeId).toBe('recipe-abc');
    expect(result.reason).toBe('源文件已删除');
  });

  it('should resolve related deprecate proposals', async () => {
    const deprecateFn = vi.fn();
    const markExecutedFn = vi.fn();
    const ctx = makeContext({
      knowledgeService: { deprecate: deprecateFn },
      proposalRepository: {
        findByTarget: vi.fn().mockReturnValue([
          { id: 'prop-1', type: 'deprecate', status: 'pending' },
          { id: 'prop-2', type: 'evolve', status: 'pending' },
        ]),
        markExecuted: markExecutedFn,
      },
    });

    await confirmDeprecation.handler({ recipeId: 'recipe-abc', reason: 'test' }, ctx);

    // Should only mark deprecate proposals as executed, not evolve
    expect(markExecutedFn).toHaveBeenCalledTimes(1);
    expect(markExecutedFn).toHaveBeenCalledWith(
      'prop-1',
      expect.stringContaining('Evolution Agent confirmed deprecation'),
      'evolution-agent'
    );
  });

  it('should not fail when proposalRepository is unavailable', async () => {
    const deprecateFn = vi.fn();
    const ctx = makeContext({
      knowledgeService: { deprecate: deprecateFn },
      // No proposalRepository
    });

    const result = await confirmDeprecation.handler(
      { recipeId: 'recipe-abc', reason: 'test' },
      ctx
    );

    expect(result.status).toBe('deprecated');
  });

  it('should not fail when proposalRepository.findByTarget throws', async () => {
    const deprecateFn = vi.fn();
    const ctx = makeContext({
      knowledgeService: { deprecate: deprecateFn },
      proposalRepository: {
        findByTarget: vi.fn().mockImplementation(() => {
          throw new Error('DB error');
        }),
      },
    });

    const result = await confirmDeprecation.handler(
      { recipeId: 'recipe-abc', reason: 'test' },
      ctx
    );

    expect(result.status).toBe('deprecated');
  });
});

// ── skip_evolution ───────────────────────────────────────

describe('skipEvolution', () => {
  it('should have correct tool metadata', () => {
    expect(skipEvolution.name).toBe('skip_evolution');
    expect(skipEvolution.parameters.required).toContain('recipeId');
    expect(skipEvolution.parameters.required).toContain('reason');
  });

  it('should return skipped status with params', async () => {
    const ctx = makeContext();
    const result = await skipEvolution.handler({ recipeId: 'recipe-xyz', reason: '信息不足' }, ctx);

    expect(result.status).toBe('skipped');
    expect(result.recipeId).toBe('recipe-xyz');
    expect(result.reason).toBe('信息不足');
  });

  it('should not modify any state', async () => {
    const deprecateFn = vi.fn();
    const ctx = makeContext({
      knowledgeService: { deprecate: deprecateFn },
    });

    await skipEvolution.handler({ recipeId: 'recipe-xyz', reason: 'test' }, ctx);

    // knowledgeService.deprecate should NOT be called
    expect(deprecateFn).not.toHaveBeenCalled();
  });
});
