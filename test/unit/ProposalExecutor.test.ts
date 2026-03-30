/**
 * ProposalExecutor 单元测试
 *
 * Mock ProposalRepository + DB，验证各类型 Proposal 的执行判据和执行/拒绝逻辑。
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
    type: 'merge',
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
    find: vi.fn(() => []),
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

function createMockDb(
  recipeData?: Record<string, { stats: string; quality: string; lifecycle: string }>
) {
  const data = recipeData ?? {
    'r-001': {
      stats: JSON.stringify({
        guardHits: 10,
        searchHits: 20,
        hitsLast30d: 5,
        decayScore: 50,
        ruleFalsePositiveRate: 0.1,
      }),
      quality: JSON.stringify({ overall: 0.8 }),
      lifecycle: 'evolving',
    },
  };

  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('SELECT stats, quality')) {
        return {
          all: vi.fn(),
          get: vi.fn((...args: unknown[]) => {
            const id = args[0] as string;
            const row = data[id];
            return row ? { stats: row.stats, quality: row.quality } : undefined;
          }),
          run: vi.fn(() => ({ changes: 1 })),
        };
      }
      if (sql.includes('SELECT lifecycle')) {
        return {
          all: vi.fn(),
          get: vi.fn((...args: unknown[]) => {
            const id = args[0] as string;
            const row = data[id];
            return row ? { lifecycle: row.lifecycle } : undefined;
          }),
          run: vi.fn(() => ({ changes: 1 })),
        };
      }
      if (sql.includes('UPDATE knowledge_entries')) {
        return {
          all: vi.fn(),
          get: vi.fn(),
          run: vi.fn(() => ({ changes: 1 })),
        };
      }
      if (sql.includes('INSERT OR IGNORE INTO knowledge_edges')) {
        return {
          all: vi.fn(),
          get: vi.fn(),
          run: vi.fn(() => ({ changes: 1 })),
        };
      }
      return {
        all: vi.fn(() => []),
        get: vi.fn(() => undefined),
        run: vi.fn(() => ({ changes: 0 })),
      };
    }),
  };
}

function createMockSignalBus() {
  return {
    send: vi.fn(),
    subscribe: vi.fn(),
  };
}

describe('ProposalExecutor', () => {
  let db: ReturnType<typeof createMockDb>;
  let repo: ReturnType<typeof createMockRepo>;
  let signalBus: ReturnType<typeof createMockSignalBus>;
  let executor: ProposalExecutor;

  beforeEach(() => {
    db = createMockDb();
    repo = createMockRepo();
    signalBus = createMockSignalBus();
    executor = new ProposalExecutor(db, repo as unknown as ProposalRepository, {
      signalBus: signalBus as never,
    });
  });

  describe('checkAndExecute — empty', () => {
    it('returns empty result when no expired proposals', () => {
      repo.findExpiredObserving.mockReturnValue([]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();
      expect(result.executed).toHaveLength(0);
      expect(result.rejected).toHaveLength(0);
      expect(result.expired).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });
  });

  describe('checkAndExecute — merge', () => {
    it('executes merge when FP ok and has usage', () => {
      const proposal = makeProposal({ type: 'merge' });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]); // no old pending

      const result = executor.checkAndExecute();

      expect(result.executed).toHaveLength(1);
      expect(result.executed[0].type).toBe('merge');
      expect(repo.markExecuted).toHaveBeenCalledWith(proposal.id, expect.any(String));
      expect(signalBus.send).toHaveBeenCalledWith(
        'lifecycle',
        'ProposalExecutor',
        proposal.confidence,
        expect.objectContaining({ metadata: expect.objectContaining({ action: 'executed' }) })
      );
    });

    it('rejects merge when FP rate too high', () => {
      db = createMockDb({
        'r-001': {
          stats: JSON.stringify({
            guardHits: 10,
            searchHits: 20,
            hitsLast30d: 5,
            decayScore: 50,
            ruleFalsePositiveRate: 0.5, // > 0.4 threshold
          }),
          quality: JSON.stringify({ overall: 0.8 }),
          lifecycle: 'evolving',
        },
      });
      executor = new ProposalExecutor(db, repo as unknown as ProposalRepository, {
        signalBus: signalBus as never,
      });

      const proposal = makeProposal({ type: 'merge' });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('FP rate too high');
      expect(repo.markRejected).toHaveBeenCalled();
    });

    it('rejects merge when no usage during observation', () => {
      db = createMockDb({
        'r-001': {
          stats: JSON.stringify({
            guardHits: 0,
            searchHits: 0,
            hitsLast30d: 0,
            decayScore: 50,
            ruleFalsePositiveRate: 0.1,
          }),
          quality: JSON.stringify({ overall: 0.8 }),
          lifecycle: 'evolving',
        },
      });
      executor = new ProposalExecutor(db, repo as unknown as ProposalRepository, {
        signalBus: signalBus as never,
      });

      const proposal = makeProposal({ type: 'merge' });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('no usage during observation');
    });
  });

  describe('checkAndExecute — enhance', () => {
    it('executes enhance same as merge logic', () => {
      const proposal = makeProposal({ type: 'enhance' });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.executed).toHaveLength(1);
      expect(result.executed[0].type).toBe('enhance');
    });
  });

  describe('checkAndExecute — supersede', () => {
    it('executes supersede when new recipe is active and has enough usage', () => {
      db = createMockDb({
        'r-001': {
          stats: JSON.stringify({
            guardHits: 10,
            searchHits: 10,
            hitsLast30d: 5,
            decayScore: 50,
            ruleFalsePositiveRate: 0.1,
          }),
          quality: JSON.stringify({ overall: 0.7 }),
          lifecycle: 'active',
        },
        'r-new': {
          stats: JSON.stringify({
            guardHits: 8,
            searchHits: 7,
            hitsLast30d: 4,
            decayScore: 80,
            ruleFalsePositiveRate: 0.05,
          }),
          quality: JSON.stringify({ overall: 0.85 }),
          lifecycle: 'active',
        },
      });
      executor = new ProposalExecutor(db, repo as unknown as ProposalRepository, {
        signalBus: signalBus as never,
      });

      const proposal = makeProposal({
        type: 'supersede',
        targetRecipeId: 'r-001',
        relatedRecipeIds: ['r-new'],
      });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.executed).toHaveLength(1);
      expect(result.executed[0].type).toBe('supersede');
      expect(repo.markExecuted).toHaveBeenCalled();
    });

    it('rejects supersede when new recipe has insufficient usage', () => {
      db = createMockDb({
        'r-001': {
          stats: JSON.stringify({
            guardHits: 50,
            searchHits: 50,
            hitsLast30d: 10,
            decayScore: 50,
            ruleFalsePositiveRate: 0.1,
          }),
          quality: JSON.stringify({ overall: 0.7 }),
          lifecycle: 'active',
        },
        'r-new': {
          stats: JSON.stringify({
            guardHits: 2,
            searchHits: 3,
            hitsLast30d: 1,
            decayScore: 80,
            ruleFalsePositiveRate: 0.05,
          }),
          quality: JSON.stringify({ overall: 0.85 }),
          lifecycle: 'active',
        },
      });
      executor = new ProposalExecutor(db, repo as unknown as ProposalRepository, {
        signalBus: signalBus as never,
      });

      const proposal = makeProposal({
        type: 'supersede',
        targetRecipeId: 'r-001',
        relatedRecipeIds: ['r-new'],
      });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('insufficient usage');
    });

    it('rejects supersede when no related recipe specified', () => {
      const proposal = makeProposal({
        type: 'supersede',
        relatedRecipeIds: [],
      });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('no related new recipe');
    });

    it('skips supersede when new recipe not yet active', () => {
      db = createMockDb({
        'r-001': {
          stats: JSON.stringify({
            guardHits: 10,
            searchHits: 10,
            hitsLast30d: 5,
            decayScore: 50,
            ruleFalsePositiveRate: 0.1,
          }),
          quality: JSON.stringify({ overall: 0.7 }),
          lifecycle: 'active',
        },
        'r-new': {
          stats: JSON.stringify({
            guardHits: 5,
            searchHits: 5,
            hitsLast30d: 2,
            decayScore: 80,
            ruleFalsePositiveRate: 0.05,
          }),
          quality: JSON.stringify({ overall: 0.85 }),
          lifecycle: 'staging', // not yet active
        },
      });
      executor = new ProposalExecutor(db, repo as unknown as ProposalRepository, {
        signalBus: signalBus as never,
      });

      const proposal = makeProposal({
        type: 'supersede',
        targetRecipeId: 'r-001',
        relatedRecipeIds: ['r-new'],
      });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain('not yet active');
    });
  });

  describe('checkAndExecute — deprecate', () => {
    it('executes deprecate (deprecated) when decayScore <= 19', () => {
      db = createMockDb({
        'r-001': {
          stats: JSON.stringify({
            guardHits: 0,
            searchHits: 0,
            hitsLast30d: 0,
            decayScore: 10,
            ruleFalsePositiveRate: 0,
          }),
          quality: JSON.stringify({ overall: 0.3 }),
          lifecycle: 'decaying',
        },
      });
      executor = new ProposalExecutor(db, repo as unknown as ProposalRepository, {
        signalBus: signalBus as never,
      });

      const proposal = makeProposal({
        type: 'deprecate',
        evidence: [{ snapshotAt: Date.now() - 7_000_000, metrics: { decayScore: 15 } }],
      });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.executed).toHaveLength(1);
      expect(repo.markExecuted).toHaveBeenCalledWith(
        proposal.id,
        expect.stringContaining('deprecated')
      );
    });

    it('executes deprecate (decaying) when decayScore 20-40', () => {
      db = createMockDb({
        'r-001': {
          stats: JSON.stringify({
            guardHits: 1,
            searchHits: 0,
            hitsLast30d: 0,
            decayScore: 30,
            ruleFalsePositiveRate: 0,
          }),
          quality: JSON.stringify({ overall: 0.5 }),
          lifecycle: 'decaying',
        },
      });
      executor = new ProposalExecutor(db, repo as unknown as ProposalRepository, {
        signalBus: signalBus as never,
      });

      const proposal = makeProposal({
        type: 'deprecate',
        evidence: [{ snapshotAt: Date.now() - 7_000_000, metrics: { decayScore: 35 } }],
      });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.executed).toHaveLength(1);
      expect(repo.markExecuted).toHaveBeenCalledWith(
        proposal.id,
        expect.stringContaining('decaying')
      );
    });

    it('rejects deprecate when decayScore recovered', () => {
      db = createMockDb({
        'r-001': {
          stats: JSON.stringify({
            guardHits: 5,
            searchHits: 10,
            hitsLast30d: 3,
            decayScore: 60, // recovered from 35
            ruleFalsePositiveRate: 0.05,
          }),
          quality: JSON.stringify({ overall: 0.7 }),
          lifecycle: 'decaying',
        },
      });
      executor = new ProposalExecutor(db, repo as unknown as ProposalRepository, {
        signalBus: signalBus as never,
      });

      const proposal = makeProposal({
        type: 'deprecate',
        evidence: [{ snapshotAt: Date.now() - 7_000_000, metrics: { decayScore: 35 } }],
      });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('recovered');
    });
  });

  describe('checkAndExecute — correction', () => {
    it('executes correction when recipe has usage', () => {
      const proposal = makeProposal({ type: 'correction' });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.executed).toHaveLength(1);
      expect(result.executed[0].type).toBe('correction');
    });

    it('rejects correction when no usage', () => {
      db = createMockDb({
        'r-001': {
          stats: JSON.stringify({
            guardHits: 0,
            searchHits: 0,
            hitsLast30d: 0,
            decayScore: 50,
            ruleFalsePositiveRate: 0,
          }),
          quality: JSON.stringify({ overall: 0.5 }),
          lifecycle: 'active',
        },
      });
      executor = new ProposalExecutor(db, repo as unknown as ProposalRepository, {
        signalBus: signalBus as never,
      });

      const proposal = makeProposal({ type: 'correction' });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toBe('no usage');
    });
  });

  describe('checkAndExecute — high risk types', () => {
    it('skips contradiction (high risk)', () => {
      const proposal = makeProposal({ type: 'contradiction' });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain('high-risk');
      expect(repo.markExecuted).not.toHaveBeenCalled();
    });

    it('skips reorganize (high risk)', () => {
      const proposal = makeProposal({ type: 'reorganize' });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain('high-risk');
    });
  });

  describe('checkAndExecute — old pending cleanup', () => {
    it('expires pending proposals older than 14 days', () => {
      repo.findExpiredObserving.mockReturnValue([]);
      repo.find.mockReturnValue([
        makeProposal({
          id: 'ep-old-1',
          status: 'pending',
          proposedAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
        }),
      ]);

      const result = executor.checkAndExecute();

      expect(result.expired).toHaveLength(1);
      expect(result.expired[0].id).toBe('ep-old-1');
      expect(repo.markExpired).toHaveBeenCalledWith('ep-old-1');
    });
  });

  describe('checkAndExecute — multiple proposals', () => {
    it('processes multiple proposals in one cycle', () => {
      const p1 = makeProposal({ id: 'ep-1', type: 'merge' });
      const p2 = makeProposal({ id: 'ep-2', type: 'enhance' });
      const p3 = makeProposal({ id: 'ep-3', type: 'contradiction' });

      repo.findExpiredObserving.mockReturnValue([p1, p2, p3]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.executed).toHaveLength(2); // merge + enhance
      expect(result.skipped).toHaveLength(1); // contradiction
    });
  });

  describe('signal emission', () => {
    it('emits lifecycle signal on executed', () => {
      const proposal = makeProposal({ type: 'merge' });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      executor.checkAndExecute();

      expect(signalBus.send).toHaveBeenCalledTimes(1);
      expect(signalBus.send).toHaveBeenCalledWith(
        'lifecycle',
        'ProposalExecutor',
        0.8,
        expect.objectContaining({
          target: 'r-001',
          metadata: expect.objectContaining({
            proposalId: 'ep-test-1',
            proposalType: 'merge',
            action: 'executed',
          }),
        })
      );
    });

    it('does not throw without signalBus', () => {
      const executorNoSignal = new ProposalExecutor(db, repo as unknown as ProposalRepository);
      const proposal = makeProposal({ type: 'merge' });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      expect(() => executorNoSignal.checkAndExecute()).not.toThrow();
    });
  });

  describe('recipe metric collection', () => {
    it('returns zero defaults when recipe not found', () => {
      db = createMockDb({}); // no recipes in DB
      executor = new ProposalExecutor(db, repo as unknown as ProposalRepository, {
        signalBus: signalBus as never,
      });

      const proposal = makeProposal({ type: 'merge', targetRecipeId: 'r-nonexistent' });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      // Should not throw, should reject due to no usage
      const result = executor.checkAndExecute();
      expect(result.rejected).toHaveLength(1);
    });
  });

  describe('snapshot extraction', () => {
    it('uses evidence snapshot for deprecate comparison', () => {
      // decayScore went from 35 (snapshot) to 50 (current) → recovered > 10 → reject
      db = createMockDb({
        'r-001': {
          stats: JSON.stringify({
            guardHits: 3,
            searchHits: 5,
            hitsLast30d: 2,
            decayScore: 50,
            ruleFalsePositiveRate: 0.05,
          }),
          quality: JSON.stringify({ overall: 0.7 }),
          lifecycle: 'decaying',
        },
      });
      executor = new ProposalExecutor(db, repo as unknown as ProposalRepository, {
        signalBus: signalBus as never,
      });

      const proposal = makeProposal({
        type: 'deprecate',
        evidence: [
          {
            snapshotAt: Date.now() - 7_000_000,
            metrics: { decayScore: 35, guardHits: 1, searchHits: 1 },
          },
        ],
      });
      repo.findExpiredObserving.mockReturnValue([proposal]);
      repo.find.mockReturnValue([]);

      const result = executor.checkAndExecute();

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('recovered');
    });
  });
});
