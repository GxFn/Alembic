/**
 * SourceRefReconciler — SignalBus 集成测试
 *
 * 验证 SourceRefReconciler 在发现 stale sourceRefs 时通过 SignalBus 发射 quality 信号。
 */
import { describe, expect, it, vi } from 'vitest';
import { SourceRefReconciler } from '../../lib/service/knowledge/SourceRefReconciler.js';

/* ────────────────────── Mock Repos ────────────────────── */

function createMockRepos(options: {
  entries?: { id: string; reasoning: string }[];
  existingRefs?: { recipeId: string; sourcePath: string; status: string; verifiedAt: number }[];
  staleGroupRows?: { recipeId: string; staleCount: number; totalCount: number }[];
}) {
  const { entries = [], existingRefs = [], staleGroupRows = [] } = options;

  const sourceRefRepo = {
    isAccessible: () => true,
    findOne(recipeId: string, sourcePath: string) {
      return (
        existingRefs.find((r) => r.recipeId === recipeId && r.sourcePath === sourcePath) ?? null
      );
    },
    findByRecipeId(recipeId: string) {
      return existingRefs.filter((r) => r.recipeId === recipeId);
    },
    upsert: vi.fn(),
    updateStatus: vi.fn(),
    getStaleCountsByRecipe() {
      return staleGroupRows;
    },
    findStale() {
      return existingRefs.filter((r) => r.status === 'stale');
    },
    findRenamed() {
      return existingRefs.filter((r) => r.status === 'renamed');
    },
    replaceSourcePath: vi.fn(),
  };

  const knowledgeRepo = {
    findAllIdAndReasoning: async () => entries,
    findById: async (id: string) => entries.find((e) => e.id === id) ?? null,
  };

  return { sourceRefRepo, knowledgeRepo };
}

/* ────────────────────── Tests ────────────────────── */

describe('SourceRefReconciler SignalBus Integration', () => {
  it('should emit quality signals when stale refs are found', async () => {
    const signalBus = { send: vi.fn() };

    const { sourceRefRepo, knowledgeRepo } = createMockRepos({
      entries: [{ id: 'r1', reasoning: JSON.stringify({ sources: ['/nonexistent/file.ts'] }) }],
      staleGroupRows: [{ recipeId: 'r1', staleCount: 1, totalCount: 1 }],
    });

    const reconciler = new SourceRefReconciler(
      '/tmp/test-project',
      sourceRefRepo as never,
      knowledgeRepo as never,
      { signalBus: signalBus as never, ttlMs: 0 }
    );

    const report = await reconciler.reconcile({ force: true });

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

  it('should NOT emit signals when all refs are active', async () => {
    const signalBus = { send: vi.fn() };

    const { sourceRefRepo, knowledgeRepo } = createMockRepos({
      entries: [],
      staleGroupRows: [],
    });

    const reconciler = new SourceRefReconciler(
      '/tmp/test-project',
      sourceRefRepo as never,
      knowledgeRepo as never,
      { signalBus: signalBus as never }
    );

    const report = await reconciler.reconcile();

    expect(report.stale).toBe(0);
    expect(signalBus.send).not.toHaveBeenCalled();
  });

  it('should work without signalBus (backward compatible)', async () => {
    const { sourceRefRepo, knowledgeRepo } = createMockRepos({
      entries: [{ id: 'r1', reasoning: JSON.stringify({ sources: ['/nonexistent/file.ts'] }) }],
    });

    const reconciler = new SourceRefReconciler(
      '/tmp/test-project',
      sourceRefRepo as never,
      knowledgeRepo as never,
      { ttlMs: 0 }
    );

    // Should not throw
    const report = await reconciler.reconcile({ force: true });
    expect(report.recipesProcessed).toBe(1);
  });

  it('should emit staleRatio as signal value', async () => {
    const signalBus = { send: vi.fn() };

    const { sourceRefRepo, knowledgeRepo } = createMockRepos({
      entries: [
        {
          id: 'r1',
          reasoning: JSON.stringify({ sources: ['/a.ts', '/b.ts'] }),
        },
      ],
      staleGroupRows: [{ recipeId: 'r1', staleCount: 1, totalCount: 2 }],
    });

    const reconciler = new SourceRefReconciler(
      '/tmp/test-project',
      sourceRefRepo as never,
      knowledgeRepo as never,
      { signalBus: signalBus as never, ttlMs: 0 }
    );

    await reconciler.reconcile({ force: true });

    // staleRatio = 1/2 = 0.5
    expect(signalBus.send).toHaveBeenCalledWith(
      'quality',
      'SourceRefReconciler',
      0.5,
      expect.anything()
    );
  });
});
