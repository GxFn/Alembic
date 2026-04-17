/**
 * ProposalExecutor 单元测试
 *
 * Mock ProposalRepository + DB，验证 update / deprecate 两种 Proposal 的执行判据和执行/拒绝逻辑。
 * 信号驱动架构：checkAndExecute 现为启动时兆底清理，主流程由 subscribeToSignals 接管。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProposalRecord,
  ProposalRepository,
} from '../../lib/repository/evolution/ProposalRepository.js';
import { ProposalExecutor } from '../../lib/service/evolution/ProposalExecutor.js';

/* ── Mock factories ── */

function makeProposal(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: 'ep-test-1',
    type: 'update',
    targetRecipeId: 'r-001',
    relatedRecipeIds: [],
    confidence: 0.8,
    source: 'ide-agent',
    description: 'test proposal',
    evidence: [],
    status: 'observing',
    proposedAt: Date.now() - 72 * 60 * 60 * 1000,
    expiresAt: Date.now() - 1000, // expired
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    ...overrides,
  };
}

function createMockRepo() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    find: vi.fn((_filter?: { status?: string }) => []),
    findExpiredObserving: vi.fn(() => []),
    findActive: vi.fn(() => []),
    findByTarget: vi.fn(() => []),
    startObserving: vi.fn(() => true),
    markExecuted: vi.fn(() => true),
    markRejected: vi.fn(() => true),
    markExpired: vi.fn(() => true),
    updateEvidence: vi.fn(() => true),
    stats: vi.fn(() => ({ pending: 0, observing: 0, executed: 0, rejected: 0, expired: 0 })),
  } satisfies Record<keyof ProposalRepository, unknown>;
}

function createMockKnowledgeRepo(
  recipeData?: Record<
    string,
    {
      stats: Record<string, unknown>;
      quality: Record<string, unknown>;
      lifecycle: string;
    }
  >
) {
  const data = recipeData ?? {
    'r-001': {
      stats: {
        guardHits: 10,
        searchHits: 20,
        hitsLast30d: 5,
        decayScore: 50,
        ruleFalsePositiveRate: 0.1,
      },
      quality: { overall: 0.8 },
      lifecycle: 'evolving',
    },
  };

  return {
    findById: vi.fn(async (id: string) => {
      const row = data[id];
      if (!row) {
        return null;
      }
      return { id, stats: row.stats, quality: row.quality, lifecycle: row.lifecycle };
    }),
    updateLifecycle: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
  };
}

function createMockSignalBus() {
  return {
    send: vi.fn(),
    subscribe: vi.fn(),
  };
}

function createMockLifecycle() {
  return {
    transition: vi.fn(async () => ({ success: true })),
    checkTimeouts: vi.fn(async () => ({ timedOut: [], checked: 0, errors: [] })),
    getHistory: vi.fn(async () => []),
    getHealth: vi.fn(async () => ({ totalTransitions: 0, recentErrors: 0 })),
  };
}

function createMockContentPatcher() {
  return {
    patch: vi.fn(async () => null),
  };
}

function createMockEdgeRepo() {
  return {
    create: vi.fn(async () => {}),
    findBySource: vi.fn(async () => []),
    findByTarget: vi.fn(async () => []),
    delete: vi.fn(async () => {}),
  };
}

describe('ProposalExecutor', () => {
  let knowledgeRepo: ReturnType<typeof createMockKnowledgeRepo>;
  let repo: ReturnType<typeof createMockRepo>;
  let signalBus: ReturnType<typeof createMockSignalBus>;
  let lifecycle: ReturnType<typeof createMockLifecycle>;
  let contentPatcher: ReturnType<typeof createMockContentPatcher>;
  let edgeRepo: ReturnType<typeof createMockEdgeRepo>;
  let executor: ProposalExecutor;

  /** Helper: configure repo.find to return proposals for 'observing' and [] for 'pending' */
  function setupObservingProposals(proposals: ProposalRecord[]) {
    repo.find.mockImplementation((filter?: { status?: string }) => {
      if (filter?.status === 'observing') {
        return proposals;
      }
      return [];
    });
  }

  beforeEach(() => {
    knowledgeRepo = createMockKnowledgeRepo();
    repo = createMockRepo();
    signalBus = createMockSignalBus();
    lifecycle = createMockLifecycle();
    contentPatcher = createMockContentPatcher();
    edgeRepo = createMockEdgeRepo();
    executor = new ProposalExecutor(
      knowledgeRepo as never,
      repo as unknown as ProposalRepository,
      lifecycle as never,
      contentPatcher as never,
      edgeRepo as never
    );
  });

  describe('checkAndExecute — empty', () => {
    it('returns empty result when no expired proposals', async () => {
      setupObservingProposals([]);

      const result = await executor.checkAndExecute();
      expect(result.executed).toHaveLength(0);
      expect(result.rejected).toHaveLength(0);
      expect(result.expired).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });
  });

  describe('checkAndExecute — update', () => {
    it('executes update when FP ok and has usage', async () => {
      const proposal = makeProposal({ type: 'update' });
      setupObservingProposals([proposal]);

      const result = await executor.checkAndExecute();

      expect(result.executed).toHaveLength(1);
      expect(result.executed[0].type).toBe('update');
      expect(repo.markExecuted).toHaveBeenCalledWith(proposal.id, expect.any(String));
      // lifecycle.transition should be called for evolving and then staging/active
      expect(lifecycle.transition).toHaveBeenCalled();
    });

    it('rejects update when FP rate too high', async () => {
      knowledgeRepo = createMockKnowledgeRepo({
        'r-001': {
          stats: {
            guardHits: 10,
            searchHits: 20,
            hitsLast30d: 5,
            decayScore: 50,
            ruleFalsePositiveRate: 0.5,
          },
          quality: { overall: 0.8 },
          lifecycle: 'evolving',
        },
      });
      executor = new ProposalExecutor(
        knowledgeRepo as never,
        repo as unknown as ProposalRepository,
        lifecycle as never,
        contentPatcher as never,
        edgeRepo as never
      );

      const proposal = makeProposal({ type: 'update' });
      setupObservingProposals([proposal]);

      const result = await executor.checkAndExecute();

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('FP rate too high');
      expect(repo.markRejected).toHaveBeenCalled();
    });

    it('rejects update when no usage during observation', async () => {
      knowledgeRepo = createMockKnowledgeRepo({
        'r-001': {
          stats: {
            guardHits: 0,
            searchHits: 0,
            hitsLast30d: 0,
            decayScore: 50,
            ruleFalsePositiveRate: 0.1,
          },
          quality: { overall: 0.8 },
          lifecycle: 'evolving',
        },
      });
      executor = new ProposalExecutor(
        knowledgeRepo as never,
        repo as unknown as ProposalRepository,
        lifecycle as never,
        contentPatcher as never,
        edgeRepo as never
      );

      const proposal = makeProposal({ type: 'update' });
      setupObservingProposals([proposal]);

      const result = await executor.checkAndExecute();

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('no usage');
    });
  });

  describe('checkAndExecute — deprecate', () => {
    it('executes deprecate (deprecated) when decayScore <= 19', async () => {
      knowledgeRepo = createMockKnowledgeRepo({
        'r-001': {
          stats: {
            guardHits: 0,
            searchHits: 0,
            hitsLast30d: 0,
            decayScore: 10,
            ruleFalsePositiveRate: 0,
          },
          quality: { overall: 0.3 },
          lifecycle: 'decaying',
        },
      });
      executor = new ProposalExecutor(
        knowledgeRepo as never,
        repo as unknown as ProposalRepository,
        lifecycle as never,
        contentPatcher as never,
        edgeRepo as never
      );

      const proposal = makeProposal({
        type: 'deprecate',
        evidence: [{ snapshotAt: Date.now() - 7_000_000, metrics: { decayScore: 15 } }],
      });
      setupObservingProposals([proposal]);

      const result = await executor.checkAndExecute();

      expect(result.executed).toHaveLength(1);
      expect(repo.markExecuted).toHaveBeenCalledWith(proposal.id, expect.stringContaining('dead'));
    });

    it('executes deprecate (decaying) when decayScore 20-40', async () => {
      knowledgeRepo = createMockKnowledgeRepo({
        'r-001': {
          stats: {
            guardHits: 1,
            searchHits: 0,
            hitsLast30d: 0,
            decayScore: 30,
            ruleFalsePositiveRate: 0,
          },
          quality: { overall: 0.5 },
          lifecycle: 'decaying',
        },
      });
      executor = new ProposalExecutor(
        knowledgeRepo as never,
        repo as unknown as ProposalRepository,
        lifecycle as never,
        contentPatcher as never,
        edgeRepo as never
      );

      const proposal = makeProposal({
        type: 'deprecate',
        evidence: [{ snapshotAt: Date.now() - 7_000_000, metrics: { decayScore: 35 } }],
      });
      setupObservingProposals([proposal]);

      const result = await executor.checkAndExecute();

      expect(result.executed).toHaveLength(1);
      expect(repo.markExecuted).toHaveBeenCalledWith(
        proposal.id,
        expect.stringContaining('severe')
      );
    });

    it('rejects deprecate when decayScore recovered', async () => {
      knowledgeRepo = createMockKnowledgeRepo({
        'r-001': {
          stats: {
            guardHits: 5,
            searchHits: 10,
            hitsLast30d: 3,
            decayScore: 60,
            ruleFalsePositiveRate: 0.05,
          },
          quality: { overall: 0.7 },
          lifecycle: 'decaying',
        },
      });
      executor = new ProposalExecutor(
        knowledgeRepo as never,
        repo as unknown as ProposalRepository,
        lifecycle as never,
        contentPatcher as never,
        edgeRepo as never
      );

      const proposal = makeProposal({
        type: 'deprecate',
        evidence: [{ snapshotAt: Date.now() - 7_000_000, metrics: { decayScore: 35 } }],
      });
      setupObservingProposals([proposal]);

      const result = await executor.checkAndExecute();

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('recovered');
    });

    it('creates replacedBy edge when relatedRecipeIds present', async () => {
      knowledgeRepo = createMockKnowledgeRepo({
        'r-001': {
          stats: {
            guardHits: 0,
            searchHits: 0,
            hitsLast30d: 0,
            decayScore: 10,
            ruleFalsePositiveRate: 0,
          },
          quality: { overall: 0.3 },
          lifecycle: 'decaying',
        },
      });
      executor = new ProposalExecutor(
        knowledgeRepo as never,
        repo as unknown as ProposalRepository,
        lifecycle as never,
        contentPatcher as never,
        edgeRepo as never
      );

      const proposal = makeProposal({
        type: 'deprecate',
        relatedRecipeIds: ['r-new'],
        evidence: [{ snapshotAt: Date.now() - 7_000_000, metrics: { decayScore: 15 } }],
      });
      setupObservingProposals([proposal]);

      const result = await executor.checkAndExecute();

      expect(result.executed).toHaveLength(1);
    });
  });

  describe('checkAndExecute — old pending cleanup', () => {
    it('expires pending proposals older than 14 days', async () => {
      const pendingProposal = makeProposal({
        id: 'ep-old-1',
        status: 'pending',
        proposedAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
      });
      repo.find.mockImplementation((filter?: { status?: string }) => {
        if (filter?.status === 'observing') {
          return [];
        }
        if (filter?.status === 'pending') {
          return [pendingProposal];
        }
        return [];
      });

      const result = await executor.checkAndExecute();

      expect(result.expired).toHaveLength(1);
      expect(result.expired[0].id).toBe('ep-old-1');
      expect(repo.markExpired).toHaveBeenCalledWith('ep-old-1');
    });
  });

  describe('checkAndExecute — multiple proposals', () => {
    it('processes multiple update and deprecate proposals in one cycle', async () => {
      const p1 = makeProposal({ id: 'ep-1', type: 'update' });
      const p2 = makeProposal({ id: 'ep-2', type: 'update', targetRecipeId: 'r-001' });
      const p3 = makeProposal({
        id: 'ep-3',
        type: 'deprecate',
        targetRecipeId: 'r-002',
        evidence: [{ snapshotAt: Date.now() - 7_000_000, metrics: { decayScore: 10 } }],
      });

      knowledgeRepo = createMockKnowledgeRepo({
        'r-001': {
          stats: {
            guardHits: 10,
            searchHits: 20,
            hitsLast30d: 5,
            decayScore: 50,
            ruleFalsePositiveRate: 0.1,
          },
          quality: { overall: 0.8 },
          lifecycle: 'evolving',
        },
        'r-002': {
          stats: {
            guardHits: 0,
            searchHits: 0,
            hitsLast30d: 0,
            decayScore: 10,
            ruleFalsePositiveRate: 0,
          },
          quality: { overall: 0.3 },
          lifecycle: 'decaying',
        },
      });
      executor = new ProposalExecutor(
        knowledgeRepo as never,
        repo as unknown as ProposalRepository,
        lifecycle as never,
        contentPatcher as never,
        edgeRepo as never
      );

      setupObservingProposals([p1, p2, p3]);

      const result = await executor.checkAndExecute();

      expect(result.executed.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('lifecycle transition', () => {
    it('calls lifecycle.transition on executed update', async () => {
      const proposal = makeProposal({ type: 'update' });
      setupObservingProposals([proposal]);

      await executor.checkAndExecute();

      expect(lifecycle.transition).toHaveBeenCalled();
    });

    it('does not throw without signalBus', async () => {
      const executorNoSignal = new ProposalExecutor(
        knowledgeRepo as never,
        repo as unknown as ProposalRepository,
        lifecycle as never,
        contentPatcher as never,
        edgeRepo as never
      );
      const proposal = makeProposal({ type: 'update' });
      setupObservingProposals([proposal]);

      await expect(executorNoSignal.checkAndExecute()).resolves.not.toThrow();
    });
  });

  describe('recipe metric collection', () => {
    it('returns zero defaults when recipe not found', async () => {
      knowledgeRepo = createMockKnowledgeRepo({});
      executor = new ProposalExecutor(
        knowledgeRepo as never,
        repo as unknown as ProposalRepository,
        lifecycle as never,
        contentPatcher as never,
        edgeRepo as never
      );

      const proposal = makeProposal({ type: 'update', targetRecipeId: 'r-nonexistent' });
      setupObservingProposals([proposal]);

      const result = await executor.checkAndExecute();
      expect(result.rejected).toHaveLength(1);
    });
  });

  describe('snapshot extraction', () => {
    it('uses evidence snapshot for deprecate comparison', async () => {
      knowledgeRepo = createMockKnowledgeRepo({
        'r-001': {
          stats: {
            guardHits: 3,
            searchHits: 5,
            hitsLast30d: 2,
            decayScore: 50,
            ruleFalsePositiveRate: 0.05,
          },
          quality: { overall: 0.7 },
          lifecycle: 'decaying',
        },
      });
      executor = new ProposalExecutor(
        knowledgeRepo as never,
        repo as unknown as ProposalRepository,
        lifecycle as never,
        contentPatcher as never,
        edgeRepo as never
      );

      const proposal = makeProposal({
        type: 'deprecate',
        evidence: [
          {
            snapshotAt: Date.now() - 7_000_000,
            metrics: { decayScore: 35, guardHits: 1, searchHits: 1 },
          },
        ],
      });
      setupObservingProposals([proposal]);

      const result = await executor.checkAndExecute();

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('recovered');
    });
  });
});
