import { describe, expect, test, vi } from 'vitest';
import {
  type ConsolidationResult,
  consumeBootstrapSemanticMemory,
} from '#workflows/deprecated-cold-start/consumers/BootstrapSemanticMemoryConsumer.js';
import type { SessionStore } from '../../lib/agent/memory/SessionStore.js';

function makeResult(partial: Partial<ConsolidationResult> = {}): ConsolidationResult {
  return {
    total: { added: 1, updated: 2, merged: 3, skipped: 4 },
    durationMs: 10,
    ...partial,
  };
}

describe('bootstrap semantic memory consumer', () => {
  test('returns null when database is unavailable', () => {
    const result = consumeBootstrapSemanticMemory({
      ctx: { container: { get: () => null } },
      dataRoot: '/tmp',
      sessionId: 'session-1',
      sessionStore: {} as SessionStore,
    });

    expect(result).toBeNull();
  });

  test('consolidates SessionStore into semantic memory with injected dependencies', () => {
    const db = { marker: 'db' };
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
    const sessionStore = { marker: 'session' } as unknown as SessionStore;

    const result = consumeBootstrapSemanticMemory({
      ctx: { container: { get: (name: string) => (name === 'database' ? db : null) } },
      dataRoot: '/tmp',
      sessionId: 'session-1',
      sessionStore,
      createPersistentMemory,
      createConsolidator,
    });

    expect(result?.total).toEqual({ added: 1, updated: 2, merged: 3, skipped: 4 });
    expect(createPersistentMemory).toHaveBeenCalledWith(db);
    expect(createConsolidator).toHaveBeenCalledWith(semanticMemory);
    expect(consolidate).toHaveBeenCalledWith(sessionStore, {
      bootstrapSession: 'session-1',
      clearPrevious: true,
    });
  });

  test('returns null when consolidation throws', () => {
    const result = consumeBootstrapSemanticMemory({
      ctx: { container: { get: () => ({ marker: 'db' }) } },
      dataRoot: '/tmp',
      sessionId: 'session-1',
      sessionStore: {} as SessionStore,
      createPersistentMemory: () => ({
        getStats: () => ({ total: 0, avgImportance: 0, byType: {}, bySource: {} }),
      }),
      createConsolidator: () => ({
        consolidate: () => {
          throw new Error('boom');
        },
      }),
    });

    expect(result).toBeNull();
  });
});
