/**
 * EvolutionGateway.test.ts — 进化决策网关单元测试
 *
 * 重点覆盖：
 *   - Dedup 时 evidence 升级（Bug #1 修复）
 *   - 基本 submit 路由（update / deprecate / valid）
 */

import { describe, expect, it, vi } from 'vitest';
import { EvolutionGateway } from '../../lib/service/evolution/EvolutionGateway.js';

/* ── Mock factories ── */

function createMockProposalRepo(opts: { hasDuplicate?: boolean } = {}) {
  const store = new Map<string, Record<string, unknown>>();
  let createCount = 0;

  return {
    create: vi.fn((input: Record<string, unknown>) => {
      if (opts.hasDuplicate) {
        return null;
      }
      createCount++;
      const record = {
        id: `ep-${Date.now()}-${createCount}`,
        type: input.type,
        targetRecipeId: input.targetRecipeId,
        status: 'observing',
        evidence: input.evidence ?? [],
        confidence: input.confidence,
        source: input.source,
        description: input.description ?? '',
        relatedRecipeIds: input.relatedRecipeIds ?? [],
        proposedAt: Date.now(),
        expiresAt: input.expiresAt ?? 0,
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
      };
      store.set(record.id, record);
      return record;
    }),
    findByTarget: vi.fn((_targetRecipeId: string) => {
      return [...store.values()];
    }),
    updateEvidence: vi.fn((_id: string, _evidence: Record<string, unknown>[]) => true),
    markExecuted: vi.fn(() => true),
    markRejected: vi.fn(() => true),
    find: vi.fn(() => []),
    findById: vi.fn(() => null),
    startObserving: vi.fn(() => true),
    markExpired: vi.fn(() => true),
    _store: store,
  };
}

function createMockLifecycle() {
  return {
    transition: vi.fn(async () => ({ success: true })),
  };
}

function createMockKnowledgeRepo() {
  return {
    findById: vi.fn(async (id: string) => ({
      id,
      title: `Recipe ${id}`,
      stats: {},
    })),
    updateStats: vi.fn(async () => {}),
  };
}

function createGateway(
  overrides: {
    proposalRepo?: ReturnType<typeof createMockProposalRepo>;
    lifecycle?: ReturnType<typeof createMockLifecycle>;
    knowledgeRepo?: ReturnType<typeof createMockKnowledgeRepo>;
  } = {}
) {
  const proposalRepo = overrides.proposalRepo ?? createMockProposalRepo();
  const lifecycle = overrides.lifecycle ?? createMockLifecycle();
  const knowledgeRepo = overrides.knowledgeRepo ?? createMockKnowledgeRepo();

  const gateway = new EvolutionGateway(
    proposalRepo as never,
    lifecycle as never,
    knowledgeRepo as never
  );

  return { gateway, proposalRepo, lifecycle, knowledgeRepo };
}

/* ── Tests ── */

describe('EvolutionGateway', () => {
  describe('submit — basic routing', () => {
    it('valid → updates lastVerifiedAt', async () => {
      const { gateway, knowledgeRepo } = createGateway();

      const result = await gateway.submit({
        recipeId: 'r1',
        action: 'valid',
        source: 'decay-scan',
        confidence: 0.5,
      });

      expect(result.outcome).toBe('verified');
      expect(knowledgeRepo.updateStats).toHaveBeenCalled();
    });

    it('valid → rejects active automated proposals for the recipe', async () => {
      const proposalRepo = createMockProposalRepo();
      const { gateway } = createGateway({ proposalRepo });

      await gateway.submit({
        recipeId: 'r1',
        action: 'update',
        source: 'rescan-evolution',
        confidence: 0.8,
        description: 'pattern modified',
        evidence: [{ modifiedPath: 'a.swift' }],
      });

      const result = await gateway.submit({
        recipeId: 'r1',
        action: 'valid',
        source: 'rescan-evolution',
        confidence: 0.9,
        reason: 'Agent verified current code still matches',
      });

      expect(result.outcome).toBe('verified');
      expect(proposalRepo.markRejected).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Agent verified current code still matches'),
        'rescan-evolution'
      );
    });

    it('update → creates proposal', async () => {
      const { gateway, proposalRepo } = createGateway();

      const result = await gateway.submit({
        recipeId: 'r1',
        action: 'update',
        source: 'file-change',
        confidence: 0.8,
        description: 'pattern modified',
        evidence: [{ modifiedPath: 'a.swift', score: 0.5 }],
      });

      expect(result.outcome).toBe('proposal-created');
      expect(result.proposalId).toBeDefined();
      expect(proposalRepo.create).toHaveBeenCalledOnce();
    });

    it('recipe not found → error', async () => {
      const knowledgeRepo = createMockKnowledgeRepo();
      knowledgeRepo.findById.mockResolvedValue(null);
      const { gateway } = createGateway({ knowledgeRepo });

      const result = await gateway.submit({
        recipeId: 'nonexistent',
        action: 'update',
        source: 'file-change',
        confidence: 0.8,
      });

      expect(result.outcome).toBe('error');
      expect(result.error).toContain('not found');
    });
  });

  describe('submit — dedup evidence upgrade', () => {
    it('should upgrade evidence when Agent proposal has suggestedChanges but existing does not', async () => {
      // Step 1: Create a proposal from file-change (no suggestedChanges)
      const proposalRepo = createMockProposalRepo();
      const { gateway } = createGateway({ proposalRepo });

      const fileChangeResult = await gateway.submit({
        recipeId: 'r1',
        action: 'update',
        source: 'file-change',
        confidence: 0.8,
        description: 'pattern modified',
        evidence: [{ modifiedPath: 'a.swift', score: 0.5, matchedTokens: ['Foo'] }],
      });
      expect(fileChangeResult.outcome).toBe('proposal-created');
      const existingId = fileChangeResult.proposalId!;

      // Step 2: Now make create() return null (dedup), findByTarget returns the existing
      proposalRepo.create.mockReturnValue(null);

      const agentResult = await gateway.submit({
        recipeId: 'r1',
        action: 'update',
        source: 'decay-scan',
        confidence: 0.9,
        description: 'Agent verified changes',
        evidence: [
          {
            sourceStatus: 'modified',
            suggestedChanges:
              '{"patchVersion":1,"changes":[{"field":"coreCode","action":"replace","newValue":"updated code"}]}',
            verifiedBy: 'evolution-agent',
            verifiedAt: Date.now(),
          },
        ],
      });

      expect(agentResult.outcome).toBe('proposal-upgraded');
      expect(agentResult.proposalId).toBe(existingId);
      expect(proposalRepo.updateEvidence).toHaveBeenCalledOnce();

      // Verify merged evidence contains both original and new
      const mergedEvidence = proposalRepo.updateEvidence.mock.calls[0][1] as Record<
        string,
        unknown
      >[];
      expect(mergedEvidence).toHaveLength(2);
      expect(mergedEvidence[0]).toHaveProperty('modifiedPath', 'a.swift');
      expect(mergedEvidence[1]).toHaveProperty('suggestedChanges');
    });

    it('should return skipped when dedup but new evidence has no suggestedChanges either', async () => {
      const proposalRepo = createMockProposalRepo();
      const { gateway } = createGateway({ proposalRepo });

      // Create initial proposal
      await gateway.submit({
        recipeId: 'r1',
        action: 'update',
        source: 'file-change',
        confidence: 0.8,
        evidence: [{ modifiedPath: 'a.swift', score: 0.5 }],
      });

      // Dedup trigger — new evidence also lacks suggestedChanges
      proposalRepo.create.mockReturnValue(null);

      const result = await gateway.submit({
        recipeId: 'r1',
        action: 'update',
        source: 'file-change',
        confidence: 0.8,
        evidence: [{ modifiedPath: 'b.swift', score: 0.3 }],
      });

      expect(result.outcome).toBe('skipped');
      expect(proposalRepo.updateEvidence).not.toHaveBeenCalled();
    });

    it('should return skipped when dedup but no new evidence provided', async () => {
      const proposalRepo = createMockProposalRepo({ hasDuplicate: true });
      const { gateway } = createGateway({ proposalRepo });

      const result = await gateway.submit({
        recipeId: 'r1',
        action: 'update',
        source: 'file-change',
        confidence: 0.8,
      });

      expect(result.outcome).toBe('skipped');
    });

    it('should not upgrade when existing already has suggestedChanges', async () => {
      const proposalRepo = createMockProposalRepo();
      const { gateway } = createGateway({ proposalRepo });

      // Create initial proposal WITH suggestedChanges
      await gateway.submit({
        recipeId: 'r1',
        action: 'update',
        source: 'decay-scan',
        confidence: 0.9,
        evidence: [{ suggestedChanges: 'existing patch', verifiedBy: 'agent' }],
      });

      proposalRepo.create.mockReturnValue(null);

      const result = await gateway.submit({
        recipeId: 'r1',
        action: 'update',
        source: 'decay-scan',
        confidence: 0.9,
        evidence: [{ suggestedChanges: 'newer patch' }],
      });

      expect(result.outcome).toBe('skipped');
      expect(proposalRepo.updateEvidence).not.toHaveBeenCalled();
    });
  });

  describe('submit — deprecate', () => {
    it('high confidence + agent source → immediate execution', async () => {
      const { gateway, lifecycle } = createGateway();

      const result = await gateway.submit({
        recipeId: 'r1',
        action: 'deprecate',
        source: 'ide-agent',
        confidence: 0.9,
        reason: 'source deleted',
      });

      expect(result.outcome).toBe('immediately-executed');
      expect(lifecycle.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          targetState: 'deprecated',
        })
      );
    });

    it('low confidence → creates proposal instead', async () => {
      const { gateway, proposalRepo } = createGateway();

      const result = await gateway.submit({
        recipeId: 'r1',
        action: 'deprecate',
        source: 'metabolism',
        confidence: 0.5,
      });

      expect(result.outcome).toBe('proposal-created');
      expect(proposalRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'deprecate' })
      );
    });

    it('guard rejects immediate deprecate → falls back to proposal', async () => {
      const lifecycle = createMockLifecycle();
      lifecycle.transition.mockResolvedValue({ success: false, error: 'guard rejected' });
      const { gateway, proposalRepo } = createGateway({ lifecycle });

      const result = await gateway.submit({
        recipeId: 'r1',
        action: 'deprecate',
        source: 'ide-agent',
        confidence: 0.9,
        reason: 'deleted',
      });

      expect(result.outcome).toBe('proposal-created');
      expect(proposalRepo.create).toHaveBeenCalled();
    });
  });
});
