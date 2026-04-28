import { describe, expect, test, vi } from 'vitest';
import type { ScanRunRecord } from '../../lib/repository/scan/ScanRunRepository.js';
import type { DimensionDef, ProjectSnapshot } from '../../lib/types/project-snapshot.js';
import type { PipelineFillView } from '../../lib/types/snapshot-views.js';
import {
  completeColdStartLifecycleRun,
  runColdStartLifecycleFill,
} from '../../lib/workflows/scan/lifecycle/ColdStartLifecycleRunner.js';
import type { ScanPlan } from '../../lib/workflows/scan/ScanTypes.js';

function makeRun(overrides: Partial<ScanRunRecord> = {}): ScanRunRecord {
  return {
    id: 'scan-1',
    projectRoot: '/repo',
    mode: 'cold-start',
    depth: 'standard',
    status: 'running',
    reason: 'build baseline',
    activeDimensions: ['architecture'],
    scope: { dimensions: ['architecture'] },
    changeSet: null,
    budgets: {},
    summary: {},
    errorMessage: null,
    parentSnapshotId: null,
    baselineSnapshotId: null,
    startedAt: 100,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function makeView(services: Record<string, unknown>, scanRunId = 'scan-1'): PipelineFillView {
  const snapshot = {
    projectRoot: '/repo',
    sourceTag: 'bootstrap',
    isEmpty: false,
    activeDimensions: [{ id: 'architecture', label: 'Architecture', description: '' }],
    allFiles: [],
    language: { primaryLang: 'typescript', stats: {}, filesByLang: {} },
    incrementalPlan: null,
  } as ProjectSnapshot;
  const scanPlan = {
    mode: 'cold-start',
    depth: 'standard',
    reason: 'build baseline',
    activeDimensions: ['architecture'],
    skippedDimensions: [],
    scope: { dimensions: ['architecture'] },
    fallback: null,
    budgets: {
      maxFiles: 10,
      maxKnowledgeItems: 20,
      maxTotalChars: 30_000,
      maxAgentIterations: 30,
    },
  } satisfies ScanPlan;

  return {
    snapshot,
    ctx: { container: { get: (name: string) => services[name] } },
    bootstrapSession: null,
    targetFileMap: {},
    projectRoot: '/repo',
    scanPlan,
    scanRunId,
    scanEvidencePack: null,
  };
}

const dimensions: DimensionDef[] = [{ id: 'architecture', label: 'Architecture', description: '' }];

describe('runColdStartLifecycleFill', () => {
  test('completes an existing cold-start scan context for handler-only paths', () => {
    const running = makeRun();
    const completed = makeRun({ status: 'completed', summary: { baselineRunId: 'scan-1' } });
    const scanRunRepository = { create: vi.fn(), complete: vi.fn(() => completed) };
    const view = makeView({ scanRunRepository });
    if (!view.scanPlan) {
      throw new Error('scan plan missing');
    }
    const scanContext = {
      plan: view.scanPlan,
      evidencePack: null,
      evidenceSummary: null,
      run: running,
      evidencePackRecord: null,
    };

    const result = completeColdStartLifecycleRun(
      view.ctx as Parameters<typeof completeColdStartLifecycleRun>[0],
      scanContext,
      { missionBriefing: true }
    );

    expect(result?.run).toBe(completed);
    expect(scanRunRepository.complete).toHaveBeenCalledWith(
      'scan-1',
      expect.objectContaining({
        mode: 'cold-start',
        baselineRunId: 'scan-1',
        executionStatus: 'handler-complete',
        recommendations: [],
      })
    );
  });

  test('completes the scan run with the workflow execution summary', async () => {
    const completed = makeRun({
      status: 'completed',
      baselineSnapshotId: 'snap_1',
      summary: { baselineRunId: 'scan-1', baselineSnapshotId: 'snap_1' },
    });
    const coldStartWorkflow = {
      run: vi.fn(async () => ({
        mode: 'cold-start' as const,
        plan: undefined,
        execution: {
          status: 'completed' as const,
          summary: {
            snapshotId: 'snap_1',
            candidatesCreated: 3,
            candidatesFailed: 1,
            skillsCreated: 1,
            skillsFailed: 0,
            totalTimeMs: 120,
            totalToolCalls: 8,
            totalTokenUsage: { input: 10, output: 20 },
            incremental: false,
            coverage: {
              dimensionsTotal: 2,
              dimensionsActive: 2,
              dimensionsSkipped: 0,
              dimensionsIncrementalSkipped: 0,
              dimensionsWithCandidates: 1,
              dimensionsWithAnalysis: 2,
              filesTotal: 4,
              referencedFiles: 2,
              referencedFileMentions: 3,
            },
          },
        },
      })),
    };
    const scanRunRepository = { create: vi.fn(), complete: vi.fn(() => completed) };
    const services = { coldStartWorkflow, scanRunRepository };

    const result = await runColdStartLifecycleFill(makeView(services), dimensions);

    expect(result.run).toBe(completed);
    expect(result.baseline).toMatchObject({
      baselineRunId: 'scan-1',
      baselineSnapshotId: 'snap_1',
      candidates: { created: 3, failed: 1 },
      skills: { created: 1, failed: 0 },
      coverage: { dimensionCoverageRatio: 1, fileCoverageRatio: 0.5 },
    });
    expect(coldStartWorkflow.run).toHaveBeenCalledWith(
      expect.objectContaining({ dimensions, plan: expect.objectContaining({ mode: 'cold-start' }) })
    );
    expect(scanRunRepository.complete).toHaveBeenCalledWith(
      'scan-1',
      expect.objectContaining({ baselineSnapshotId: 'snap_1' }),
      { baselineSnapshotId: 'snap_1' }
    );
  });

  test('marks the scan run failed when bootstrap cannot access AI', async () => {
    const failed = makeRun({ status: 'failed', errorMessage: 'AI Provider not available' });
    const coldStartWorkflow = {
      run: vi.fn(async () => ({
        mode: 'cold-start' as const,
        plan: undefined,
        execution: {
          status: 'ai-unavailable' as const,
          summary: { stage: 'bootstrap-ai-provider', dimensions: 1 },
        },
      })),
    };
    const scanRunRepository = { create: vi.fn(), fail: vi.fn(() => failed) };
    const services = { coldStartWorkflow, scanRunRepository };

    const result = await runColdStartLifecycleFill(makeView(services), dimensions);

    expect(result.run).toBe(failed);
    expect(result.baseline.executionStatus).toBe('ai-unavailable');
    expect(scanRunRepository.fail).toHaveBeenCalledWith('scan-1', 'AI Provider not available', {
      stage: 'bootstrap-ai-provider',
      dimensions: 1,
    });
  });

  test('marks the scan run failed when the workflow throws', async () => {
    const failed = makeRun({ status: 'failed', errorMessage: 'boom' });
    const coldStartWorkflow = {
      run: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const scanRunRepository = { create: vi.fn(), fail: vi.fn(() => failed) };
    const services = { coldStartWorkflow, scanRunRepository };

    await expect(runColdStartLifecycleFill(makeView(services), dimensions)).rejects.toThrow('boom');
    expect(scanRunRepository.fail).toHaveBeenCalledWith('scan-1', 'boom', {
      stage: 'bootstrap-dimension-fill',
      dimensions: 1,
    });
  });
});
