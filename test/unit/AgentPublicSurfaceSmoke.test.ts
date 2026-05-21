import { ExplorationTracker } from '@alembic/agent/context';
import { ActiveContext, MemoryCoordinator, SessionStore } from '@alembic/agent/memory';
import { AgentRuntime, BudgetController, MAX_TOOL_CALLS_PER_ITER } from '@alembic/agent/runtime';
import { describe, expect, it, vi } from 'vitest';

describe('Agent public surface smoke', () => {
  it('keeps runtime exports consumable without duplicating Agent loop tests', () => {
    expect(AgentRuntime).toBeDefined();
    expect(BudgetController).toBeDefined();
    expect(MAX_TOOL_CALLS_PER_ITER).toBeGreaterThan(0);
  });

  it('keeps memory and context contracts consumable from Alembic', () => {
    const memory = new MemoryCoordinator({ mode: 'bootstrap', totalMemoryBudget: 4000 });
    const active = new ActiveContext();
    const session = new SessionStore();
    const tracker = ExplorationTracker.resolve(
      { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
      { reset: true }
    );

    active.startRound(1);
    active.setThought('smoke');
    active.endRound();

    expect(memory.getBudgetAllocation()).toMatchObject({
      activeContext: 1800,
      sessionStore: 1400,
    });
    expect(active.toJSON().rounds[0]?.thought).toBe('smoke');
    expect(session).toBeDefined();
    expect(tracker).toBeDefined();
  });
});
