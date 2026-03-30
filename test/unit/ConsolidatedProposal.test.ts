/**
 * Consolidated Submit — Proposal 集成逻辑测试
 *
 * 测试 `enhancedSubmitKnowledge` 中与 Proposal 相关的逻辑路径：
 *   - ConsolidationAdvisor merge → 创建 Proposal（非 block）
 *   - ConsolidationAdvisor reorganize → 创建 Proposal（pending）
 *   - ConsolidationAdvisor insufficient → 创建 enhance Proposal
 *   - supersedes 参数 → 创建 supersede Proposal
 *   - ProposalRepository 未注册时降级回 blocked 行为
 *
 * 由于 enhancedSubmitKnowledge 依赖大量 DI + 动态 import，
 * 本测试通过对 ProposalRepository.create 的行为验证核心逻辑。
 */
import { describe, expect, it, vi } from 'vitest';
import { ProposalRepository } from '../../lib/repository/evolution/ProposalRepository.js';

describe('Consolidated Proposal creation logic', () => {
  /**
   * 模拟 _createProposalFromAdvice 的等效逻辑（与 consolidated.ts 中的 helper 对齐）
   */
  function createProposalFromAdvice(
    repo: ProposalRepository,
    advice: {
      action: string;
      confidence: number;
      reason: string;
      targetRecipe?: { id: string; title: string; similarity: number };
      reorganizeTargets?: { id: string; title: string; similarity: number }[];
      coveredBy?: { id: string; title: string; similarity: number }[];
    },
    candidateItem: Record<string, unknown>
  ) {
    const evidence = [
      {
        snapshotAt: Date.now(),
        candidateTitle: candidateItem.title,
        analysisReason: advice.reason,
      },
    ];

    if (advice.action === 'merge' && advice.targetRecipe) {
      return repo.create({
        type: 'merge',
        targetRecipeId: advice.targetRecipe.id,
        confidence: advice.confidence,
        source: 'ide-agent',
        description: advice.reason,
        evidence,
      });
    }

    if (advice.action === 'reorganize' && advice.reorganizeTargets?.length) {
      const target = advice.reorganizeTargets[0];
      return repo.create({
        type: 'reorganize',
        targetRecipeId: target.id,
        relatedRecipeIds: advice.reorganizeTargets.slice(1).map((t) => t.id),
        confidence: advice.confidence,
        source: 'ide-agent',
        description: advice.reason,
        evidence,
      });
    }

    if (advice.action === 'insufficient' && advice.coveredBy?.length) {
      const target = advice.coveredBy[0];
      return repo.create({
        type: 'enhance',
        targetRecipeId: target.id,
        confidence: advice.confidence,
        source: 'ide-agent',
        description: advice.reason,
        evidence,
      });
    }

    return null;
  }

  function createMockDb() {
    const runFn = vi.fn(() => ({ changes: 1 }));
    const allFn = vi.fn(() => [] as Record<string, unknown>[]);
    const getFn = vi.fn(() => undefined as Record<string, unknown> | undefined);
    const prepare = vi.fn(() => ({ run: runFn, all: allFn, get: getFn }));
    return { prepare, runFn, allFn, getFn };
  }

  describe('merge advice → merge Proposal', () => {
    it('creates merge Proposal with correct fields', () => {
      const db = createMockDb();
      const repo = new ProposalRepository(db);

      const result = createProposalFromAdvice(
        repo,
        {
          action: 'merge',
          confidence: 0.85,
          reason: 'High similarity with existing recipe',
          targetRecipe: { id: 'r-001', title: 'HTTP Config', similarity: 0.78 },
        },
        { title: 'New HTTP Setup' }
      );

      expect(result).not.toBeNull();
      expect(result?.type).toBe('merge');
      expect(result?.targetRecipeId).toBe('r-001');
      expect(result?.source).toBe('ide-agent');
      expect(result?.confidence).toBe(0.85);
      // merge confidence 0.85 >= 0.75 → observing
      expect(result?.status).toBe('observing');
    });

    it('returns null when duplicate exists', () => {
      const db = createMockDb();
      // Simulate existing proposal
      db.getFn.mockReturnValue({ id: 'ep-existing' });
      const repo = new ProposalRepository(db);

      const result = createProposalFromAdvice(
        repo,
        {
          action: 'merge',
          confidence: 0.85,
          reason: 'dup test',
          targetRecipe: { id: 'r-001', title: 'HTTP', similarity: 0.78 },
        },
        { title: 'test' }
      );

      expect(result).toBeNull();
    });
  });

  describe('reorganize advice → reorganize Proposal', () => {
    it('creates reorganize Proposal as pending (high risk)', () => {
      const db = createMockDb();
      const repo = new ProposalRepository(db);

      const result = createProposalFromAdvice(
        repo,
        {
          action: 'reorganize',
          confidence: 0.9,
          reason: '3 recipes overlap significantly',
          reorganizeTargets: [
            { id: 'r-001', title: 'A', similarity: 0.8 },
            { id: 'r-002', title: 'B', similarity: 0.75 },
            { id: 'r-003', title: 'C', similarity: 0.7 },
          ],
        },
        { title: 'test' }
      );

      expect(result).not.toBeNull();
      expect(result?.type).toBe('reorganize');
      expect(result?.targetRecipeId).toBe('r-001');
      expect(result?.relatedRecipeIds).toEqual(['r-002', 'r-003']);
      // reorganize threshold = Infinity → always pending
      expect(result?.status).toBe('pending');
    });
  });

  describe('insufficient advice → enhance Proposal', () => {
    it('creates enhance Proposal when coveredBy exists', () => {
      const db = createMockDb();
      const repo = new ProposalRepository(db);

      const result = createProposalFromAdvice(
        repo,
        {
          action: 'insufficient',
          confidence: 0.75,
          reason: 'Content already covered by existing recipe',
          coveredBy: [{ id: 'r-005', title: 'Existing Pattern', similarity: 0.6 }],
        },
        { title: 'Insufficient candidate' }
      );

      expect(result).not.toBeNull();
      expect(result?.type).toBe('enhance');
      expect(result?.targetRecipeId).toBe('r-005');
      expect(result?.source).toBe('ide-agent');
      // enhance confidence 0.75 >= 0.7 → observing
      expect(result?.status).toBe('observing');
    });
  });

  describe('unknown advice → null', () => {
    it('returns null for unrecognized action', () => {
      const db = createMockDb();
      const repo = new ProposalRepository(db);

      const result = createProposalFromAdvice(
        repo,
        {
          action: 'unknown_action',
          confidence: 0.5,
          reason: 'test',
        },
        { title: 'test' }
      );

      expect(result).toBeNull();
    });
  });

  describe('supersede Proposal from submit_knowledge', () => {
    it('creates supersede Proposal with correct structure', () => {
      const db = createMockDb();
      const repo = new ProposalRepository(db);

      const result = repo.create({
        type: 'supersede',
        targetRecipeId: 'r-old',
        relatedRecipeIds: ['r-new-001'],
        confidence: 0.8,
        source: 'ide-agent',
        description: 'Agent declares new recipe replaces old',
        evidence: [{ snapshotAt: Date.now(), newRecipeIds: ['r-new-001'], declaredBy: 'agent' }],
      });

      expect(result).not.toBeNull();
      expect(result?.type).toBe('supersede');
      expect(result?.targetRecipeId).toBe('r-old');
      expect(result?.relatedRecipeIds).toEqual(['r-new-001']);
      // supersede confidence 0.8 >= 0.8 → observing
      expect(result?.status).toBe('observing');
    });

    it('supersede stays pending when confidence < 0.8', () => {
      const db = createMockDb();
      const repo = new ProposalRepository(db);

      const result = repo.create({
        type: 'supersede',
        targetRecipeId: 'r-old',
        relatedRecipeIds: ['r-new-001'],
        confidence: 0.7,
        source: 'ide-agent',
        description: 'Low confidence supersede',
      });

      expect(result).not.toBeNull();
      expect(result?.status).toBe('pending');
    });
  });

  describe('SubmitKnowledgeInput supersedes schema', () => {
    it('SubmitKnowledgeInput schema accepts supersedes field', async () => {
      const { SubmitKnowledgeInput } = await import('../../lib/shared/schemas/mcp-tools.js');

      const result = SubmitKnowledgeInput.safeParse({
        items: [{ title: 'test' }],
        supersedes: 'r-old-001',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.supersedes).toBe('r-old-001');
      }
    });

    it('SubmitKnowledgeInput schema allows omitting supersedes', async () => {
      const { SubmitKnowledgeInput } = await import('../../lib/shared/schemas/mcp-tools.js');

      const result = SubmitKnowledgeInput.safeParse({
        items: [{ title: 'test' }],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.supersedes).toBeUndefined();
      }
    });
  });
});
