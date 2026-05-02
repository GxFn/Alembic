import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type {
  CandidateResults,
  DimensionCandidateData,
  DimensionStat,
} from '#workflows/capabilities/execution/internal-agent/BootstrapConsumers.js';
import type { DimensionContext } from '#workflows/capabilities/execution/internal-agent/DimensionContext.js';
import {
  applyRestoredDimensionState,
  type DimensionCheckpoint,
  resolveIncrementalSkippedDimensions,
  restoreCheckpointDimensions,
  syncRestoredSessionStoreDigests,
} from '#workflows/capabilities/persistence/DimensionCheckpoint.js';
import type { SessionStore } from '../../lib/agent/memory/SessionStore.js';
import type { IncrementalPlan } from '../../lib/external/mcp/handlers/types.js';
import type { BootstrapEventEmitter } from '../../lib/service/bootstrap/BootstrapEventEmitter.js';

function makePlan(partial: Partial<IncrementalPlan>): IncrementalPlan {
  return {
    canIncremental: true,
    mode: 'incremental',
    affectedDimensions: [],
    skippedDimensions: [],
    previousSnapshot: null,
    diff: null,
    reason: 'test',
    restoredEpisodic: null,
    ...partial,
  };
}

describe('DimensionRestoreState', () => {
  test('syncs restored SessionStore digests into DimensionContext', () => {
    const addDimensionDigest = vi.fn();

    const restoredDims = syncRestoredSessionStoreDigests({
      sessionStore: {
        getCompletedDimensions: () => ['api'],
        getDimensionReport: () => ({ digest: { summary: 'api done' } }),
      } as unknown as SessionStore,
      dimContext: { addDimensionDigest } as unknown as DimensionContext,
    });

    expect(restoredDims).toEqual(['api']);
    expect(addDimensionDigest).toHaveBeenCalledWith('api', { summary: 'api done' });
  });

  test('resolves incremental skipped dimensions and emits completion events', () => {
    const emitDimensionComplete = vi.fn();

    const skipped = resolveIncrementalSkippedDimensions({
      isIncremental: true,
      incrementalPlan: makePlan({
        affectedDimensions: ['api'],
        skippedDimensions: ['ui', 'data'],
      }),
      activeDimIds: ['api', 'ui', 'security'],
      emitter: { emitDimensionComplete } as unknown as BootstrapEventEmitter,
    });

    expect(skipped).toEqual(['ui']);
    expect(emitDimensionComplete).toHaveBeenCalledWith('ui', {
      type: 'incremental-restored',
      reason: 'no-change-detected',
    });
  });

  test('loads active checkpoints and restores checkpoint side effects', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alembic-checkpoint-'));
    const checkpointDir = path.join(dataRoot, '.asd', 'bootstrap-checkpoint');
    await fs.mkdir(checkpointDir, { recursive: true });
    await fs.writeFile(
      path.join(checkpointDir, 'api.json'),
      JSON.stringify({
        dimId: 'api',
        completedAt: Date.now(),
        digest: { summary: 'checkpoint digest' },
        candidateCount: 2,
      })
    );

    const addDimensionDigest = vi.fn();
    const emitDimensionComplete = vi.fn();
    const { completedCheckpoints, skippedDims } = await restoreCheckpointDimensions({
      dataRoot,
      activeDimIds: ['api'],
      dimContext: { addDimensionDigest } as unknown as DimensionContext,
      sessionStore: { addDimensionDigest } as unknown as SessionStore,
      emitter: { emitDimensionComplete } as unknown as BootstrapEventEmitter,
    });

    expect(skippedDims).toEqual(['api']);
    expect(completedCheckpoints.get('api')?.candidateCount).toBe(2);
    expect(addDimensionDigest).toHaveBeenCalledWith('api', { summary: 'checkpoint digest' });
    expect(emitDimensionComplete).toHaveBeenCalledWith(
      'api',
      expect.objectContaining({ type: 'checkpoint-restored', candidateCount: 2 })
    );
  });

  test('applies incremental and checkpoint restored dimension stats', () => {
    const candidateResults: CandidateResults = { created: 0, failed: 0, errors: [] };
    const dimensionStats: Record<string, DimensionStat> = {};
    const dimensionCandidates: Record<string, DimensionCandidateData> = {};
    const storeDimensionReport = vi.fn();
    const checkpoints = new Map<string, DimensionCheckpoint>([
      [
        'api',
        {
          candidateCount: 2,
          rejectedCount: 1,
          analysisText: 'checkpoint analysis',
          referencedFilesList: ['src/api.ts'],
          tokenUsage: { input: 1, output: 2 },
        },
      ],
    ]);

    applyRestoredDimensionState({
      incrementalSkippedDims: ['ui'],
      checkpointSkippedDims: ['api', 'ui'],
      completedCheckpoints: checkpoints,
      sessionStore: {
        getDimensionReport: (dimId: string) =>
          dimId === 'ui'
            ? {
                analysisText: 'historical ui',
                referencedFiles: ['src/ui.ts'],
                candidatesSummary: [{ title: 'UI' }],
              }
            : null,
        storeDimensionReport,
      } as unknown as SessionStore,
      dimensionStats,
      candidateResults,
      dimensionCandidates,
    });

    expect(dimensionStats.ui).toMatchObject({
      candidateCount: 1,
      skipped: true,
      restoredFromIncremental: true,
    });
    expect(dimensionStats.api).toMatchObject({
      candidateCount: 2,
      rejectedCount: 1,
      skipped: true,
      restoredFromCheckpoint: true,
    });
    expect(candidateResults.created).toBe(2);
    expect(dimensionCandidates.api.analysisReport).toMatchObject({
      analysisText: 'checkpoint analysis',
      referencedFiles: ['src/api.ts'],
    });
    expect(storeDimensionReport).toHaveBeenCalledWith(
      'api',
      expect.objectContaining({ analysisText: 'checkpoint analysis' })
    );
  });
});
