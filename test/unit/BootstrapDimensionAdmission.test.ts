import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { SessionStore } from '#agent/memory/SessionStore.js';
import {
  buildBootstrapDimensionAdmissionDecisions,
  resolveBootstrapDimensionAdmissions,
} from '#workflows/capabilities/execution/internal-agent/BootstrapDimensionAdmission.js';
import type { BootstrapRescanContext } from '#workflows/capabilities/execution/internal-agent/BootstrapRescanState.js';
import type { DimensionContext } from '#workflows/capabilities/execution/internal-agent/DimensionContext.js';
import type { IncrementalPlan } from '../../lib/external/mcp/handlers/types.js';
import type { BootstrapEventEmitter } from '../../lib/service/bootstrap/BootstrapEventEmitter.js';

function makeIncrementalPlan(partial: Partial<IncrementalPlan> = {}): IncrementalPlan {
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

describe('BootstrapDimensionAdmission', () => {
  test('builds one admission decision per active dimension', () => {
    const decisions = buildBootstrapDimensionAdmissionDecisions({
      activeDimIds: ['api', 'ui', 'security'],
      incrementalSkippedDims: ['ui'],
      checkpointSkippedDims: ['api'],
      rescanForceExecuteDimIds: ['security'],
    });

    expect(decisions).toMatchObject({
      api: {
        status: 'checkpoint-restored',
        reason: 'dimension checkpoint is still valid',
      },
      ui: {
        status: 'incremental-restored',
        reason: 'no-change-detected',
      },
      security: {
        status: 'run',
        reason: 'rescan execution decision requires run',
        forcedByRescan: true,
      },
    });
  });

  test('keeps rescan-forced dimensions runnable when file diff would skip them', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alembic-admission-'));
    const emitDimensionComplete = vi.fn();
    const rescanContext = {
      existingRecipes: [],
      decayingRecipes: [],
      occupiedTriggers: [],
      coverageByDim: {},
      executionDecisions: {
        api: {
          dimensionId: 'api',
          mode: 'produce',
          createBudget: 2,
          existingCount: 0,
          gap: 2,
          existingRecipes: [],
          decayingRecipes: [],
          reasons: [{ kind: 'coverage-gap' }],
          shouldExecute: true,
        },
      },
    } as unknown as BootstrapRescanContext;

    const admissions = await resolveBootstrapDimensionAdmissions({
      dataRoot,
      activeDimIds: ['api', 'ui'],
      isIncremental: true,
      incrementalPlan: makeIncrementalPlan({
        affectedDimensions: [],
        skippedDimensions: ['api', 'ui'],
      }),
      rescanContext,
      dimContext: {} as DimensionContext,
      sessionStore: {} as SessionStore,
      emitter: { emitDimensionComplete } as unknown as BootstrapEventEmitter,
    });

    expect(admissions.decisions.api).toMatchObject({
      status: 'run',
      forcedByRescan: true,
    });
    expect(admissions.decisions.ui).toMatchObject({ status: 'incremental-restored' });
    expect(admissions.skippedDimIds).toEqual(['ui']);
    expect(admissions.incrementalSkippedDims).toEqual(['ui']);
    expect(emitDimensionComplete).toHaveBeenCalledWith('ui', {
      type: 'incremental-restored',
      reason: 'no-change-detected',
    });

    await fs.rm(dataRoot, { recursive: true, force: true });
  });
});
