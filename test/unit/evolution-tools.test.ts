/**
 * evolution-tools.test.ts
 *
 * Evolution Agent 工具处理器测试:
 *   - propose_evolution: 附加进化提案
 *   - confirm_deprecation: 确认废弃
 *   - skip_evolution: 显式跳过
 */

import { describe, expect, it, vi } from 'vitest';
import type { ToolHandlerContext } from '../../lib/agent/tools/_shared.js';
import {
  confirmDeprecation,
  proposeEvolution,
  skipEvolution,
} from '../../lib/agent/tools/evolution-tools.js';

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

// ── propose_evolution ────────────────────────────────────

describe('proposeEvolution', () => {
  it('should have correct tool metadata', () => {
    expect(proposeEvolution.name).toBe('propose_evolution');
    expect(proposeEvolution.parameters.required).toContain('recipeId');
    expect(proposeEvolution.parameters.required).toContain('type');
    expect(proposeEvolution.parameters.required).toContain('description');
    expect(proposeEvolution.parameters.required).toContain('evidence');
    expect(proposeEvolution.parameters.required).toContain('confidence');
  });

  it('should create proposal via ProposalRepository and return result', async () => {
    const createFn = vi.fn().mockReturnValue({
      id: 'prop-001',
      status: 'pending',
      expiresAt: Date.now() + 48 * 3600_000,
    });
    const ctx = makeContext({
      proposalRepository: { create: createFn },
    });

    const result = await proposeEvolution.handler(
      {
        recipeId: 'recipe-abc',
        type: 'enhance',
        description: '函数签名已变更为 async',
        evidence: {
          sourceStatus: 'modified',
          currentCode: 'async func sign() -> String { ... }',
          suggestedChanges: '更新核心代码片段和描述以反映 async 变更',
        },
        confidence: 0.85,
      },
      ctx
    );

    expect(createFn).toHaveBeenCalledOnce();
    expect(createFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'enhance',
        targetRecipeId: 'recipe-abc',
        relatedRecipeIds: [],
        confidence: 0.85,
        source: 'decay-scan',
      })
    );
    expect(result.status).toBe('proposed');
    expect(result.proposalId).toBe('prop-001');
    expect(result.recipeId).toBe('recipe-abc');
    expect(result.type).toBe('enhance');
  });

  it('should pass evidence with verifiedBy metadata', async () => {
    const createFn = vi.fn().mockReturnValue({
      id: 'prop-002',
      expiresAt: Date.now() + 24 * 3600_000,
    });
    const ctx = makeContext({
      proposalRepository: { create: createFn },
    });

    await proposeEvolution.handler(
      {
        recipeId: 'recipe-abc',
        type: 'correction',
        description: '源文件已迁移',
        evidence: {
          sourceStatus: 'moved',
          newLocation: 'Sources/NewKit/WBISigner.swift',
          suggestedChanges: '更新 sourceRefs 路径',
        },
        confidence: 0.9,
      },
      ctx
    );

    const evidenceArg = createFn.mock.calls[0][0].evidence[0];
    expect(evidenceArg.verifiedBy).toBe('evolution-agent');
    expect(evidenceArg.sourceStatus).toBe('moved');
    expect(evidenceArg.newLocation).toBe('Sources/NewKit/WBISigner.swift');
    expect(typeof evidenceArg.verifiedAt).toBe('number');
  });

  it('should clamp confidence to 0-1 range', async () => {
    const createFn = vi.fn().mockReturnValue({ id: 'prop-003', expiresAt: 0 });
    const ctx = makeContext({
      proposalRepository: { create: createFn },
    });

    await proposeEvolution.handler(
      {
        recipeId: 'r1',
        type: 'enhance',
        description: 'test',
        evidence: { sourceStatus: 'exists', suggestedChanges: 'test' },
        confidence: 1.5,
      },
      ctx
    );
    expect(createFn.mock.calls[0][0].confidence).toBe(1);

    await proposeEvolution.handler(
      {
        recipeId: 'r2',
        type: 'enhance',
        description: 'test',
        evidence: { sourceStatus: 'exists', suggestedChanges: 'test' },
        confidence: -0.5,
      },
      ctx
    );
    expect(createFn.mock.calls[1][0].confidence).toBe(0);
  });

  it('should return error when ProposalRepository unavailable', async () => {
    const ctx = makeContext(); // no proposalRepository
    const result = await proposeEvolution.handler(
      {
        recipeId: 'recipe-abc',
        type: 'enhance',
        description: 'test',
        evidence: { sourceStatus: 'modified', suggestedChanges: 'test' },
        confidence: 0.8,
      },
      ctx
    );
    expect(result.status).toBe('error');
    expect(result.recipeId).toBe('recipe-abc');
  });

  it('should return error when create returns null', async () => {
    const createFn = vi.fn().mockReturnValue(null);
    const ctx = makeContext({
      proposalRepository: { create: createFn },
    });

    const result = await proposeEvolution.handler(
      {
        recipeId: 'recipe-abc',
        type: 'enhance',
        description: 'test',
        evidence: { sourceStatus: 'exists', suggestedChanges: 'test' },
        confidence: 0.8,
      },
      ctx
    );
    expect(result.status).toBe('error');
  });
});

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
