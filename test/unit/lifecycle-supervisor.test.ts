/**
 * RecipeLifecycleSupervisor 单元测试
 *
 * Mock DB + SignalBus，验证:
 *   - 合法/非法转移
 *   - Entry/Exit Actions
 *   - TransitionEvent 记录
 *   - 超时检测
 *   - 健康摘要
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecipeLifecycleSupervisor } from '../../lib/service/evolution/RecipeLifecycleSupervisor.js';

/* ── Mock factories ── */

function createMockDb(
  recipeData?: Record<string, { lifecycle: string; stats: string; updatedAt: number }>
) {
  const data = recipeData ?? {
    'r-001': {
      lifecycle: 'active',
      stats: JSON.stringify({}),
      updatedAt: Date.now(),
    },
  };

  // Track lifecycle updates
  const lifecycleUpdates: { id: string; lifecycle: string }[] = [];
  const statsUpdates: { id: string; stats: string }[] = [];
  const insertedEvents: Record<string, unknown>[] = [];

  return {
    lifecycleUpdates,
    statsUpdates,
    insertedEvents,
    prepare: vi.fn((sql: string) => {
      // SELECT lifecycle
      if (sql.includes('SELECT lifecycle FROM knowledge_entries')) {
        return {
          all: vi.fn(),
          get: vi.fn((...args: unknown[]) => {
            const id = args[0] as string;
            // Check if updated
            const update = lifecycleUpdates.findLast((u) => u.id === id);
            if (update) {
              return { lifecycle: update.lifecycle };
            }
            const row = data[id];
            return row ? { lifecycle: row.lifecycle } : undefined;
          }),
          run: vi.fn(() => ({ changes: 1 })),
        };
      }

      // SELECT stats
      if (sql.includes('SELECT stats FROM knowledge_entries')) {
        return {
          all: vi.fn(),
          get: vi.fn((...args: unknown[]) => {
            const id = args[0] as string;
            const statsUpdate = statsUpdates.findLast((u) => u.id === id);
            if (statsUpdate) {
              return { stats: statsUpdate.stats };
            }
            const row = data[id];
            return row ? { stats: row.stats } : undefined;
          }),
          run: vi.fn(() => ({ changes: 1 })),
        };
      }

      // SELECT updatedAt
      if (sql.includes('SELECT updatedAt')) {
        return {
          all: vi.fn(),
          get: vi.fn((...args: unknown[]) => {
            const id = args[0] as string;
            const row = data[id];
            return row ? { updatedAt: row.updatedAt } : undefined;
          }),
          run: vi.fn(() => ({ changes: 1 })),
        };
      }

      // SELECT id, stats FROM knowledge_entries WHERE lifecycle = ?
      if (sql.includes('SELECT id, stats FROM knowledge_entries WHERE lifecycle')) {
        return {
          all: vi.fn((...args: unknown[]) => {
            const state = args[0] as string;
            return Object.entries(data)
              .filter(([id, v]) => {
                const update = lifecycleUpdates.findLast((u) => u.id === id);
                const currentLifecycle = update ? update.lifecycle : v.lifecycle;
                return currentLifecycle === state;
              })
              .map(([id, v]) => {
                const su = statsUpdates.findLast((u) => u.id === id);
                return { id, stats: su ? su.stats : v.stats };
              });
          }),
          get: vi.fn(),
          run: vi.fn(() => ({ changes: 1 })),
        };
      }

      // SELECT lifecycle, COUNT(*)
      if (sql.includes('SELECT lifecycle, COUNT(*)')) {
        return {
          all: vi.fn(() => {
            const counts: Record<string, number> = {};
            for (const [, v] of Object.entries(data)) {
              counts[v.lifecycle] = (counts[v.lifecycle] ?? 0) + 1;
            }
            return Object.entries(counts).map(([lifecycle, cnt]) => ({ lifecycle, cnt }));
          }),
          get: vi.fn(),
          run: vi.fn(() => ({ changes: 1 })),
        };
      }

      // UPDATE knowledge_entries SET lifecycle
      if (sql.includes('UPDATE knowledge_entries SET lifecycle')) {
        return {
          all: vi.fn(),
          get: vi.fn(),
          run: vi.fn((...args: unknown[]) => {
            const lifecycle = args[0] as string;
            const id = args[2] as string;
            lifecycleUpdates.push({ id, lifecycle });
            return { changes: 1 };
          }),
        };
      }

      // UPDATE knowledge_entries SET stats
      if (sql.includes('UPDATE knowledge_entries SET stats')) {
        return {
          all: vi.fn(),
          get: vi.fn(),
          run: vi.fn((...args: unknown[]) => {
            const stats = args[0] as string;
            const id = args[1] as string;
            statsUpdates.push({ id, stats });
            return { changes: 1 };
          }),
        };
      }

      // UPDATE knowledge_entries SET stats
      if (sql.includes('UPDATE knowledge_entries SET stats')) {
        return {
          all: vi.fn(),
          get: vi.fn(),
          run: vi.fn((...args: unknown[]) => {
            const stats = args[0] as string;
            const id = args[1] as string;
            statsUpdates.push({ id, stats });
            return { changes: 1 };
          }),
        };
      }

      // INSERT INTO lifecycle_transition_events
      if (sql.includes('INSERT INTO lifecycle_transition_events')) {
        return {
          all: vi.fn(),
          get: vi.fn(),
          run: vi.fn((...args: unknown[]) => {
            insertedEvents.push({
              id: args[0],
              recipeId: args[1],
              fromState: args[2],
              toState: args[3],
              trigger: args[4],
              operatorId: args[5],
              evidenceJson: args[6],
              proposalId: args[7],
              createdAt: args[8],
            });
            return { changes: 1 };
          }),
        };
      }

      // SELECT ... FROM lifecycle_transition_events
      if (sql.includes('FROM lifecycle_transition_events')) {
        return {
          all: vi.fn(() => []),
          get: vi.fn(() => ({ cnt: 0 })),
          run: vi.fn(() => ({ changes: 0 })),
        };
      }

      // SELECT ... FROM evolution_proposals
      if (sql.includes('FROM evolution_proposals')) {
        return {
          all: vi.fn(() => []),
          get: vi.fn(),
          run: vi.fn(() => ({ changes: 0 })),
        };
      }

      // Default
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

/* ── Tests ── */

describe('RecipeLifecycleSupervisor', () => {
  let db: ReturnType<typeof createMockDb>;
  let signalBus: ReturnType<typeof createMockSignalBus>;
  let supervisor: RecipeLifecycleSupervisor;

  beforeEach(() => {
    db = createMockDb();
    signalBus = createMockSignalBus();
    supervisor = new RecipeLifecycleSupervisor(db, { signalBus: signalBus as never });
  });

  describe('transition — valid transitions', () => {
    it('allows active → evolving', () => {
      const result = supervisor.transition({
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

    it('allows active → decaying', () => {
      const result = supervisor.transition({
        recipeId: 'r-001',
        targetState: 'decaying',
        trigger: 'decay-detection',
        evidence: { reason: 'score dropped to 40', decayScore: 40 },
      });

      expect(result.success).toBe(true);
      expect(result.fromState).toBe('active');
      expect(result.toState).toBe('decaying');
    });

    it('allows active → deprecated', () => {
      const result = supervisor.transition({
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
    it('rejects active → pending (not in valid transitions)', () => {
      const result = supervisor.transition({
        recipeId: 'r-001',
        targetState: 'pending',
        trigger: 'confidence-route',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid transition');
    });

    it('rejects transition for non-existent recipe', () => {
      const result = supervisor.transition({
        recipeId: 'r-nonexistent',
        targetState: 'evolving',
        trigger: 'proposal-attach',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Recipe not found');
    });
  });

  describe('transition — entry/exit actions', () => {
    it('records evolvingStartedAt on entry to evolving', () => {
      supervisor.transition({
        recipeId: 'r-001',
        targetState: 'evolving',
        trigger: 'proposal-attach',
        proposalId: 'ep-123',
      });

      // Entry action is the LAST stats update (after exit action)
      const statsUpdate = db.statsUpdates.findLast((u) => u.id === 'r-001');
      expect(statsUpdate).toBeDefined();
      const stats = JSON.parse(statsUpdate!.stats);
      expect(stats.evolvingStartedAt).toBeTypeOf('number');
      expect(stats.evolvingProposalId).toBe('ep-123');
    });

    it('records lastActiveAt when leaving active', () => {
      supervisor.transition({
        recipeId: 'r-001',
        targetState: 'evolving',
        trigger: 'proposal-attach',
      });

      // First stats update should be exit action (lastActiveAt)
      const exitUpdate = db.statsUpdates[0];
      expect(exitUpdate).toBeDefined();
      const stats = JSON.parse(exitUpdate.stats);
      expect(stats.lastActiveAt).toBeTypeOf('number');
    });
  });

  describe('transition — event recording', () => {
    it('records a TransitionEvent in DB', () => {
      supervisor.transition({
        recipeId: 'r-001',
        targetState: 'evolving',
        trigger: 'proposal-attach',
        evidence: { reason: 'test' },
        proposalId: 'ep-001',
        operatorId: 'agent',
      });

      expect(db.insertedEvents).toHaveLength(1);
      const event = db.insertedEvents[0];
      expect(event.recipeId).toBe('r-001');
      expect(event.fromState).toBe('active');
      expect(event.toState).toBe('evolving');
      expect(event.trigger).toBe('proposal-attach');
      expect(event.operatorId).toBe('agent');
      expect(event.proposalId).toBe('ep-001');
    });

    it('emits lifecycle signal', () => {
      supervisor.transition({
        recipeId: 'r-001',
        targetState: 'evolving',
        trigger: 'proposal-attach',
      });

      expect(signalBus.send).toHaveBeenCalledWith(
        'lifecycle',
        'RecipeLifecycleSupervisor',
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
    it('allows evolving → staging after content patch', () => {
      db = createMockDb({
        'r-002': {
          lifecycle: 'evolving',
          stats: JSON.stringify({ evolvingStartedAt: Date.now() }),
          updatedAt: Date.now(),
        },
      });
      supervisor = new RecipeLifecycleSupervisor(db, { signalBus: signalBus as never });

      const result = supervisor.transition({
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
    it('times out evolving recipes older than 7 days', () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      db = createMockDb({
        'r-evolving': {
          lifecycle: 'evolving',
          stats: JSON.stringify({ evolvingStartedAt: eightDaysAgo }),
          updatedAt: eightDaysAgo,
        },
      });
      supervisor = new RecipeLifecycleSupervisor(db, { signalBus: signalBus as never });

      const result = supervisor.checkTimeouts();

      expect(result.timedOut).toHaveLength(1);
      expect(result.timedOut[0].fromState).toBe('evolving');
      expect(result.timedOut[0].toState).toBe('active');
    });

    it('does not time out recent evolving recipes', () => {
      db = createMockDb({
        'r-evolving': {
          lifecycle: 'evolving',
          stats: JSON.stringify({ evolvingStartedAt: Date.now() - 1000 }),
          updatedAt: Date.now(),
        },
      });
      supervisor = new RecipeLifecycleSupervisor(db, { signalBus: signalBus as never });

      const result = supervisor.checkTimeouts();

      expect(result.timedOut).toHaveLength(0);
    });
  });

  describe('getTransitionHistory', () => {
    it('returns empty array when no events', () => {
      const history = supervisor.getTransitionHistory('r-001');
      expect(history).toEqual([]);
    });
  });

  describe('getHealthSummary', () => {
    it('returns state distribution', () => {
      const summary = supervisor.getHealthSummary();
      expect(summary.stateDistribution).toBeDefined();
      expect(summary.stateDistribution.active).toBe(1);
    });

    it('returns intermediate state stuck info', () => {
      const summary = supervisor.getHealthSummary();
      expect(summary.intermediateStates).toBeDefined();
      expect(summary.intermediateStates.stuckEvolving).toBeDefined();
    });

    it('returns proposal metrics', () => {
      const summary = supervisor.getHealthSummary();
      expect(summary.proposalMetrics).toBeDefined();
      expect(summary.proposalMetrics.executionRate).toBeTypeOf('number');
    });
  });
});
