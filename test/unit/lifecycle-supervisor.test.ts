/**
 * LifecycleStateMachine 单元测试
 *
 * Mock Repo + LifecycleEventRepo + SignalBus，验证:
 *   - 合法/非法转移
 *   - Entry/Exit Actions
 *   - TransitionEvent 记录
 *   - 超时检测
 *   - 健康摘要
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleStateMachine } from '../../lib/service/evolution/LifecycleStateMachine.js';

/* ── Mock factories ── */

function createMockRepo(
  recipeData?: Record<
    string,
    { lifecycle: string; stats: Record<string, unknown>; updatedAt: number }
  >
) {
  const data = recipeData ?? {
    'r-001': {
      lifecycle: 'active',
      stats: {},
      updatedAt: Date.now(),
    },
  };

  const lifecycleUpdates: { id: string; lifecycle: string }[] = [];
  const statsUpdates: { id: string; stats: Record<string, unknown> }[] = [];

  const getEntry = (id: string) => {
    const base = data[id];
    if (!base) {
      return null;
    }
    const lcUpdate = lifecycleUpdates.findLast((u) => u.id === id);
    const stUpdate = statsUpdates.findLast((u) => u.id === id);
    return {
      id,
      lifecycle: lcUpdate ? lcUpdate.lifecycle : base.lifecycle,
      stats: stUpdate ? stUpdate.stats : base.stats,
      updatedAt: base.updatedAt,
    };
  };

  return {
    lifecycleUpdates,
    statsUpdates,
    findById: vi.fn(async (id: string) => getEntry(id)),
    update: vi.fn(async (id: string, updateData: Record<string, unknown>) => {
      if (updateData.stats) {
        statsUpdates.push({ id, stats: updateData.stats as Record<string, unknown> });
      }
    }),
    updateLifecycle: vi.fn(async (id: string, lifecycle: string) => {
      lifecycleUpdates.push({ id, lifecycle });
    }),
    findAllByLifecycles: vi.fn(async (lifecycles: string[]) => {
      return Object.entries(data)
        .filter(([entryId, v]) => {
          const update = lifecycleUpdates.findLast((u) => u.id === entryId);
          const currentLifecycle = update ? update.lifecycle : v.lifecycle;
          return lifecycles.includes(currentLifecycle);
        })
        .map(([entryId, v]) => {
          const lcUpdate = lifecycleUpdates.findLast((u) => u.id === entryId);
          const stUpdate = statsUpdates.findLast((u) => u.id === entryId);
          return {
            id: entryId,
            lifecycle: lcUpdate ? lcUpdate.lifecycle : v.lifecycle,
            stats: stUpdate ? stUpdate.stats : v.stats,
            updatedAt: v.updatedAt,
          };
        });
    }),
    countGroupByLifecycle: vi.fn(async () => {
      const counts: Record<string, number> = {};
      for (const [entryId, v] of Object.entries(data)) {
        const update = lifecycleUpdates.findLast((u) => u.id === entryId);
        const lifecycle = update ? update.lifecycle : v.lifecycle;
        counts[lifecycle] = (counts[lifecycle] ?? 0) + 1;
      }
      return counts;
    }),
  };
}

function createMockRawDb() {
  const insertedEvents: Record<string, unknown>[] = [];

  return {
    insertedEvents,
    record: vi.fn((input: Record<string, unknown>) => {
      insertedEvents.push({
        id: input.id,
        recipeId: input.recipeId,
        fromState: input.fromState,
        toState: input.toState,
        trigger: input.trigger,
        operatorId: input.operatorId,
        evidenceJson: input.evidence ? JSON.stringify(input.evidence) : null,
        proposalId: input.proposalId,
        createdAt: input.createdAt,
      });
    }),
    getHistory: vi.fn(() => []),
    countSince: vi.fn(() => 0),
    topTriggersSince: vi.fn(() => []),
    countByTrigger: vi.fn(() => 0),
    countByTriggers: vi.fn(() => 0),
  };
}

function createMockSignalBus() {
  return {
    send: vi.fn(),
    subscribe: vi.fn(),
  };
}

function createMockProposalRepo() {
  return {
    find: vi.fn(() => []),
    findByTarget: vi.fn(() => []),
    stats: vi.fn(() => ({ pending: 0, observing: 0, executed: 0, rejected: 0, expired: 0 })),
  };
}

/* ── Tests ── */

describe('LifecycleStateMachine', () => {
  let mockRepo: ReturnType<typeof createMockRepo>;
  let mockLifecycleEventRepo: ReturnType<typeof createMockRawDb>;
  let signalBus: ReturnType<typeof createMockSignalBus>;
  let mockProposalRepo: ReturnType<typeof createMockProposalRepo>;
  let supervisor: LifecycleStateMachine;

  beforeEach(() => {
    mockRepo = createMockRepo();
    mockLifecycleEventRepo = createMockRawDb();
    signalBus = createMockSignalBus();
    mockProposalRepo = createMockProposalRepo();
    supervisor = new LifecycleStateMachine(
      mockRepo as never,
      mockLifecycleEventRepo as never,
      signalBus as never,
      mockProposalRepo as never
    );
  });

  describe('transition — valid transitions', () => {
    it('allows active → evolving', async () => {
      const result = await supervisor.transition({
        recipeId: 'r-001',
        targetState: 'evolving',
        trigger: 'proposal-attach',
        evidence: { reason: 'enhance proposal' },
      });

      expect(result.success).toBe(true);
      expect(result.fromState).toBe('active');
      expect(result.toState).toBe('evolving');
      expect(result.event).toBeDefined();
      expect(result.event!.trigger).toBe('proposal-attach');
    });

    it('allows active → decaying', async () => {
      const result = await supervisor.transition({
        recipeId: 'r-001',
        targetState: 'decaying',
        trigger: 'decay-detection',
        evidence: { reason: 'score dropped to 40', decayScore: 40 },
      });

      expect(result.success).toBe(true);
      expect(result.fromState).toBe('active');
      expect(result.toState).toBe('decaying');
    });

    it('allows active → deprecated', async () => {
      const result = await supervisor.transition({
        recipeId: 'r-001',
        targetState: 'deprecated',
        trigger: 'manual-deprecation',
        evidence: { reason: 'no longer needed' },
      });

      expect(result.success).toBe(true);
      expect(result.toState).toBe('deprecated');
    });
  });

  describe('transition — invalid transitions', () => {
    it('rejects active → pending (not in valid transitions)', async () => {
      const result = await supervisor.transition({
        recipeId: 'r-001',
        targetState: 'pending',
        trigger: 'confidence-route',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid transition');
    });

    it('rejects transition for non-existent recipe', async () => {
      const result = await supervisor.transition({
        recipeId: 'r-nonexistent',
        targetState: 'evolving',
        trigger: 'proposal-attach',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Recipe not found');
    });
  });

  describe('transition — entry/exit actions', () => {
    it('records evolvingStartedAt on entry to evolving', async () => {
      await supervisor.transition({
        recipeId: 'r-001',
        targetState: 'evolving',
        trigger: 'proposal-attach',
        proposalId: 'ep-123',
      });

      // Entry action is the LAST stats update (after exit action)
      const statsUpdate = mockRepo.statsUpdates.findLast((u) => u.id === 'r-001');
      expect(statsUpdate).toBeDefined();
      expect(statsUpdate!.stats.evolvingStartedAt).toBeTypeOf('number');
      expect(statsUpdate!.stats.evolvingProposalId).toBe('ep-123');
    });

    it('records lastActiveAt when leaving active', async () => {
      await supervisor.transition({
        recipeId: 'r-001',
        targetState: 'evolving',
        trigger: 'proposal-attach',
      });

      // First stats update should be exit action (lastActiveAt)
      const exitUpdate = mockRepo.statsUpdates[0];
      expect(exitUpdate).toBeDefined();
      expect(exitUpdate.stats.lastActiveAt).toBeTypeOf('number');
    });
  });

  describe('transition — event recording', () => {
    it('records a TransitionEvent in DB', async () => {
      await supervisor.transition({
        recipeId: 'r-001',
        targetState: 'evolving',
        trigger: 'proposal-attach',
        evidence: { reason: 'test' },
        proposalId: 'ep-001',
        operatorId: 'agent',
      });

      expect(mockLifecycleEventRepo.insertedEvents).toHaveLength(1);
      const event = mockLifecycleEventRepo.insertedEvents[0];
      expect(event.recipeId).toBe('r-001');
      expect(event.fromState).toBe('active');
      expect(event.toState).toBe('evolving');
      expect(event.trigger).toBe('proposal-attach');
      expect(event.operatorId).toBe('agent');
      expect(event.proposalId).toBe('ep-001');
    });

    it('emits lifecycle signal', async () => {
      await supervisor.transition({
        recipeId: 'r-001',
        targetState: 'evolving',
        trigger: 'proposal-attach',
      });

      expect(signalBus.send).toHaveBeenCalledWith(
        'lifecycle',
        'LifecycleStateMachine',
        0.5,
        expect.objectContaining({
          target: 'r-001',
          metadata: expect.objectContaining({
            fromState: 'active',
            toState: 'evolving',
            trigger: 'proposal-attach',
          }),
        })
      );
    });
  });

  describe('transition — evolving → staging (new path)', () => {
    it('allows evolving → staging after content patch', async () => {
      mockRepo = createMockRepo({
        'r-002': {
          lifecycle: 'evolving',
          stats: { evolvingStartedAt: Date.now() },
          updatedAt: Date.now(),
        },
      });
      mockLifecycleEventRepo = createMockRawDb();
      supervisor = new LifecycleStateMachine(
        mockRepo as never,
        mockLifecycleEventRepo as never,
        signalBus as never,
        mockProposalRepo as never
      );

      const result = await supervisor.transition({
        recipeId: 'r-002',
        targetState: 'staging',
        trigger: 'content-patch-complete',
        evidence: { reason: 'ContentPatcher applied 3 fields' },
      });

      expect(result.success).toBe(true);
      expect(result.fromState).toBe('evolving');
      expect(result.toState).toBe('staging');
    });
  });

  describe('checkTimeouts', () => {
    it('times out evolving recipes older than 7 days', async () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      mockRepo = createMockRepo({
        'r-evolving': {
          lifecycle: 'evolving',
          stats: { evolvingStartedAt: eightDaysAgo },
          updatedAt: eightDaysAgo,
        },
      });
      mockLifecycleEventRepo = createMockRawDb();
      supervisor = new LifecycleStateMachine(
        mockRepo as never,
        mockLifecycleEventRepo as never,
        signalBus as never,
        mockProposalRepo as never
      );

      const result = await supervisor.checkTimeouts();

      expect(result.timedOut).toHaveLength(1);
      expect(result.timedOut[0].fromState).toBe('evolving');
      expect(result.timedOut[0].toState).toBe('active');
    });

    it('does not time out recent evolving recipes', async () => {
      mockRepo = createMockRepo({
        'r-evolving': {
          lifecycle: 'evolving',
          stats: { evolvingStartedAt: Date.now() - 1000 },
          updatedAt: Date.now(),
        },
      });
      mockLifecycleEventRepo = createMockRawDb();
      supervisor = new LifecycleStateMachine(
        mockRepo as never,
        mockLifecycleEventRepo as never,
        signalBus as never,
        mockProposalRepo as never
      );

      const result = await supervisor.checkTimeouts();

      expect(result.timedOut).toHaveLength(0);
    });
  });

  describe('getHistory', () => {
    it('returns empty array when no events', () => {
      const history = supervisor.getHistory('r-001');
      expect(history).toEqual([]);
    });
  });

  describe('getHealth', () => {
    it('returns state distribution', async () => {
      const summary = await supervisor.getHealth();
      expect(summary.stateDistribution).toBeDefined();
      expect(summary.stateDistribution.active).toBe(1);
    });

    it('returns intermediate state stuck info', async () => {
      const summary = await supervisor.getHealth();
      expect(summary.intermediateStates).toBeDefined();
      expect(summary.intermediateStates.stuckEvolving).toBeDefined();
    });

    it('returns proposal metrics', async () => {
      const summary = await supervisor.getHealth();
      expect(summary.proposalMetrics).toBeDefined();
      expect(summary.proposalMetrics.executionRate).toBeTypeOf('number');
    });
  });
});
