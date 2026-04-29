import { describe, expect, test, vi } from 'vitest';
import {
  consolidateSemanticMemory,
  type SemanticMemoryCompletionDependencies,
} from '#workflows/capabilities/completion/SemanticMemoryCompletionStep.js';
import type { WorkflowSemanticMemoryConsolidationResult } from '#workflows/capabilities/completion/WorkflowCompletionTypes.js';

function makeResult(
  partial: Partial<WorkflowSemanticMemoryConsolidationResult> = {}
): WorkflowSemanticMemoryConsolidationResult {
  return {
    total: { added: 1, updated: 2, merged: 3, skipped: 4 },
    durationMs: 10,
    ...partial,
  };
}

describe('SemanticMemoryCompletionStep', () => {
  test('returns null when database is unavailable', async () => {
    const result = await consolidateSemanticMemory({
      ctx: { container: { get: () => null } },
      dataRoot: '/tmp',
      session: { id: 'session-1', sessionStore: createSessionStore() },
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result).toBeNull();
  });

  test('consolidates SessionStore into semantic memory with injected dependencies', async () => {
    const db = createDb();
    const semanticMemory = {
      getStats: () => ({
        total: 6,
        avgImportance: 7,
        byType: { fact: 1 },
        bySource: { bootstrap: 1 },
      }),
    };
    const consolidate = vi.fn(() =>
      makeResult({
        perDimension: { api: 2, ui: 1 },
        importanceDistribution: { 1: 1, 5: 2 },
      })
    );
    const createPersistentMemory = vi.fn(() => semanticMemory);
    const createConsolidator = vi.fn(() => ({ consolidate }));
    const sessionStore = createSessionStore();
    const dependencies: SemanticMemoryCompletionDependencies = {
      createPersistentMemory,
      createConsolidator,
    };

    const result = await consolidateSemanticMemory({
      ctx: { container: { get: (name: string) => (name === 'database' ? db : null) } },
      dataRoot: '/tmp',
      session: { id: 'session-1', sessionStore },
      log: { info: vi.fn(), warn: vi.fn() },
      dependencies,
    });

    expect(result?.total).toEqual({ added: 1, updated: 2, merged: 3, skipped: 4 });
    expect(createPersistentMemory).toHaveBeenCalledWith(db, '/tmp', expect.any(Object));
    expect(createConsolidator).toHaveBeenCalledWith(semanticMemory, expect.any(Object));
    expect(consolidate).toHaveBeenCalledWith(sessionStore, {
      bootstrapSession: 'session-1',
      clearPrevious: true,
    });
  });

  test('returns null when consolidation throws', async () => {
    const result = await consolidateSemanticMemory({
      ctx: { container: { get: () => createDb() } },
      dataRoot: '/tmp',
      session: { id: 'session-1', sessionStore: createSessionStore() },
      log: { info: vi.fn(), warn: vi.fn() },
      dependencies: {
        createPersistentMemory: () => ({}),
        createConsolidator: () => ({
          consolidate: () => {
            throw new Error('boom');
          },
        }),
      },
    });

    expect(result).toBeNull();
  });
});

function createDb() {
  return {
    prepare: vi.fn(),
    exec: vi.fn(),
    transaction: vi.fn(),
  };
}

function createSessionStore() {
  return {
    getCompletedDimensions: () => [],
    getDimensionReport: () => undefined,
    toJSON: () => ({}),
  };
}
