/**
 * evolution-tools.test.ts
 *
 * Evolution Agent 工具处理器测试 (EvolutionGateway 版):
 *   - propose_evolution → gateway.submit({ action: 'update' })
 *   - confirm_deprecation → gateway.submit({ action: 'deprecate' })
 *   - skip_evolution → gateway.submit({ action: 'valid' })
 */

import { describe, expect, it, vi } from 'vitest';
import type { ToolHandlerContext } from '../../lib/agent/tools/_shared.js';
import {
  confirmDeprecation,
  proposeEvolution,
  skipEvolution,
} from '../../lib/agent/tools/evolution-tools.js';

function createMockGateway(outcome = 'proposal-created', proposalId = 'prop-001') {
  return {
    submit: vi.fn(async () => ({
      outcome,
      proposalId: outcome === 'error' ? undefined : proposalId,
      error: outcome === 'error' ? 'Something went wrong' : undefined,
    })),
  };
}

function makeContext(services: Record<string, unknown> = {}): ToolHandlerContext {
  return {
    container: {
      get() {
        throw new Error('evolution tools should use named lifecycle service contracts');
      },
    },
    serviceContracts: {
      lifecycle: {
        getKnowledgeLifecycleService: () => null,
        getProposalRepository: () => null,
        getEvolutionGateway: () => services.evolutionGateway ?? null,
        getConsolidationAdvisor: () => null,
      },
    },
    projectRoot: '/test/project',
  };
}

function makeLifecycleContractContext(evolutionGateway: unknown): ToolHandlerContext {
  return {
    container: {
      get() {
        throw new Error('evolution tools should use the named lifecycle service contract');
      },
    },
    serviceContracts: {
      lifecycle: {
        getKnowledgeLifecycleService: () => null,
        getProposalRepository: () => null,
        getEvolutionGateway: () => evolutionGateway,
        getConsolidationAdvisor: () => null,
      },
    },
    projectRoot: '/test/project',
  };
}

describe('proposeEvolution', () => {
  it('should have correct tool metadata', () => {
    expect(proposeEvolution.name).toBe('propose_evolution');
    expect(proposeEvolution.parameters.required).toContain('recipeId');
    expect(proposeEvolution.parameters.required).toContain('type');
    expect(proposeEvolution.parameters.required).toContain('description');
    expect(proposeEvolution.parameters.required).toContain('evidence');
    expect(proposeEvolution.parameters.required).toContain('confidence');
  });

  it('should submit update via EvolutionGateway and return result', async () => {
    const gateway = createMockGateway();
    const ctx = makeContext({ evolutionGateway: gateway });

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

    expect(gateway.submit).toHaveBeenCalledOnce();
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipeId: 'recipe-abc',
        action: 'update',
        source: 'decay-scan',
      })
    );
    expect(result.status).toBe('proposed');
    expect(result.proposalId).toBe('prop-001');
    expect(result.recipeId).toBe('recipe-abc');
  });

  it('should use lifecycle service contract before container lookup', async () => {
    const gateway = createMockGateway();
    const ctx = makeLifecycleContractContext(gateway);

    const result = await proposeEvolution.handler(
      {
        recipeId: 'recipe-contract',
        type: 'enhance',
        description: '通过 contract 提交进化提案',
        evidence: { sourceStatus: 'modified', suggestedChanges: '更新描述' },
        confidence: 0.7,
      },
      ctx
    );

    expect(result.status).toBe('proposed');
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipeId: 'recipe-contract',
        action: 'update',
      })
    );
  });

  it('should clamp confidence to 0-1 range', async () => {
    const gateway = createMockGateway();
    const ctx = makeContext({ evolutionGateway: gateway });

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
    expect(gateway.submit.mock.calls[0][0].confidence).toBe(1);

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
    expect(gateway.submit.mock.calls[1][0].confidence).toBe(0);
  });

  it('should return error when EvolutionGateway unavailable', async () => {
    const ctx = makeContext();
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

  it('should return error when gateway returns error outcome', async () => {
    const gateway = createMockGateway('error');
    const ctx = makeContext({ evolutionGateway: gateway });

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

  it('should return skipped when gateway returns skipped outcome', async () => {
    const gateway = createMockGateway('skipped');
    const ctx = makeContext({ evolutionGateway: gateway });

    const result = await proposeEvolution.handler(
      {
        recipeId: 'recipe-dup',
        type: 'enhance',
        description: 'test',
        evidence: { sourceStatus: 'modified', suggestedChanges: 'changes' },
        confidence: 0.8,
      },
      ctx
    );
    expect(result.status).toBe('skipped');
    expect(result.recipeId).toBe('recipe-dup');
  });

  it('should return upgraded when gateway returns proposal-upgraded outcome', async () => {
    const gateway = createMockGateway('proposal-upgraded', 'prop-existing');
    const ctx = makeContext({ evolutionGateway: gateway });

    const result = await proposeEvolution.handler(
      {
        recipeId: 'recipe-upg',
        type: 'enhance',
        description: 'richer evidence',
        evidence: { sourceStatus: 'modified', suggestedChanges: 'detailed changes' },
        confidence: 0.9,
      },
      ctx
    );
    expect(result.status).toBe('upgraded');
    expect(result.proposalId).toBe('prop-existing');
    expect(result.recipeId).toBe('recipe-upg');
  });
});

describe('confirmDeprecation', () => {
  it('should have correct tool metadata', () => {
    expect(confirmDeprecation.name).toBe('confirm_deprecation');
    expect(confirmDeprecation.parameters.required).toContain('recipeId');
    expect(confirmDeprecation.parameters.required).toContain('reason');
  });

  it('should submit deprecate via EvolutionGateway with high confidence', async () => {
    const gateway = createMockGateway('immediately-executed');
    const ctx = makeContext({ evolutionGateway: gateway });

    const result = await confirmDeprecation.handler(
      { recipeId: 'recipe-abc', reason: '源文件已删除' },
      ctx
    );

    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipeId: 'recipe-abc',
        action: 'deprecate',
        confidence: 0.9,
        source: 'decay-scan',
      })
    );
    expect(result.status).toBe('deprecated');
    expect(result.recipeId).toBe('recipe-abc');
    expect(result.reason).toBe('源文件已删除');
  });

  it('should return error when EvolutionGateway unavailable', async () => {
    const ctx = makeContext();
    const result = await confirmDeprecation.handler(
      { recipeId: 'recipe-abc', reason: 'test' },
      ctx
    );
    expect(result.status).toBe('error');
  });
});

describe('skipEvolution', () => {
  it('should have correct tool metadata', () => {
    expect(skipEvolution.name).toBe('skip_evolution');
    expect(skipEvolution.parameters.required).toContain('recipeId');
    expect(skipEvolution.parameters.required).toContain('reason');
  });

  it('should submit valid via EvolutionGateway and return skipped status', async () => {
    const gateway = createMockGateway('verified');
    const ctx = makeContext({ evolutionGateway: gateway });

    const result = await skipEvolution.handler({ recipeId: 'recipe-xyz', reason: '信息不足' }, ctx);

    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipeId: 'recipe-xyz',
        action: 'valid',
        source: 'decay-scan',
      })
    );
    expect(result.status).toBe('skipped');
    expect(result.recipeId).toBe('recipe-xyz');
    expect(result.reason).toBe('信息不足');
  });

  it('should return skipped even when gateway unavailable', async () => {
    const ctx = makeContext();
    const result = await skipEvolution.handler({ recipeId: 'recipe-xyz', reason: 'test' }, ctx);

    expect(result.status).toBe('skipped');
    expect(result.recipeId).toBe('recipe-xyz');
  });
});
