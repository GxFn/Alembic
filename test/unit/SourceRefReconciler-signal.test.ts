/**
 * SourceRefReconciler — SignalBus 集成测试
 *
 * 验证 SourceRefReconciler 在发现 stale sourceRefs 时通过 SignalBus 发射 quality 信号。
 */
import { describe, expect, it, vi } from 'vitest';
import { SourceRefReconciler } from '../../lib/service/knowledge/SourceRefReconciler.js';

/* ────────────────────── Mock DB ────────────────────── */

function createMockDb(options: {
  entries?: { id: string; reasoning: string }[];
  existingRefs?: { recipe_id: string; source_path: string; status: string; verified_at: number }[];
  staleGroupRows?: { recipe_id: string; stale_count: number; total_count: number }[];
}) {
  const { entries = [], existingRefs = [], staleGroupRows = [] } = options;

  // Track calls for verification
  const insertCalls: unknown[][] = [];
  const updateCalls: unknown[][] = [];

  return {
    db: {
      prepare(sql: string) {
        return {
          all(..._params: unknown[]) {
            if (sql.includes('knowledge_entries') && sql.includes('reasoning')) {
              return entries;
            }
            if (sql.includes('GROUP BY recipe_id')) {
              return staleGroupRows;
            }
            return [];
          },
          get(...params: unknown[]) {
            if (sql.includes('SELECT 1 FROM recipe_source_refs LIMIT 1')) {
              return { '1': 1 }; // table exists
            }
            if (sql.includes('recipe_source_refs') && sql.includes('recipe_id = ?')) {
              const recipeId = params[0] as string;
              const sourcePath = params[1] as string;
              return existingRefs.find(
                (r) => r.recipe_id === recipeId && r.source_path === sourcePath
              );
            }
            return undefined;
          },
          run(...args: unknown[]) {
            if (sql.includes('INSERT')) {
              insertCalls.push(args);
            } else if (sql.includes('UPDATE')) {
              updateCalls.push(args);
            }
            return { changes: 1 };
          },
        };
      },
    },
    insertCalls,
    updateCalls,
  };
}

/* ────────────────────── Tests ────────────────────── */

describe('SourceRefReconciler SignalBus Integration', () => {
  it('should emit quality signals when stale refs are found', () => {
    const signalBus = { send: vi.fn() };

    const { db } = createMockDb({
      entries: [{ id: 'r1', reasoning: JSON.stringify({ sources: ['/nonexistent/file.ts'] }) }],
      staleGroupRows: [{ recipe_id: 'r1', stale_count: 1, total_count: 1 }],
    });

    const reconciler = new SourceRefReconciler('/tmp/test-project', db as never, {
      signalBus: signalBus as never,
      ttlMs: 0, // force recheck
    });

    const report = reconciler.reconcile({ force: true });

    // stale > 0 → should emit signals
    expect(report.stale).toBeGreaterThan(0);
    expect(signalBus.send).toHaveBeenCalledWith(
      'quality',
      'SourceRefReconciler',
      expect.any(Number),
      expect.objectContaining({
        target: 'r1',
        metadata: expect.objectContaining({
          reason: 'source_ref_stale',
          staleCount: 1,
          totalRefs: 1,
        }),
      })
    );
  });

  it('should NOT emit signals when all refs are active', () => {
    const signalBus = { send: vi.fn() };

    const { db } = createMockDb({
      entries: [],
      staleGroupRows: [],
    });

    const reconciler = new SourceRefReconciler('/tmp/test-project', db as never, {
      signalBus: signalBus as never,
    });

    const report = reconciler.reconcile();

    expect(report.stale).toBe(0);
    expect(signalBus.send).not.toHaveBeenCalled();
  });

  it('should work without signalBus (backward compatible)', () => {
    const { db } = createMockDb({
      entries: [{ id: 'r1', reasoning: JSON.stringify({ sources: ['/nonexistent/file.ts'] }) }],
    });

    const reconciler = new SourceRefReconciler('/tmp/test-project', db as never, {
      ttlMs: 0,
    });

    // Should not throw
    const report = reconciler.reconcile({ force: true });
    expect(report.recipesProcessed).toBe(1);
  });

  it('should emit staleRatio as signal value', () => {
    const signalBus = { send: vi.fn() };

    const { db } = createMockDb({
      entries: [
        {
          id: 'r1',
          reasoning: JSON.stringify({ sources: ['/a.ts', '/b.ts'] }),
        },
      ],
      staleGroupRows: [{ recipe_id: 'r1', stale_count: 1, total_count: 2 }],
    });

    const reconciler = new SourceRefReconciler('/tmp/test-project', db as never, {
      signalBus: signalBus as never,
      ttlMs: 0,
    });

    reconciler.reconcile({ force: true });

    // staleRatio = 1/2 = 0.5
    expect(signalBus.send).toHaveBeenCalledWith(
      'quality',
      'SourceRefReconciler',
      0.5,
      expect.anything()
    );
  });
});
