import { describe, expect, test, vi } from 'vitest';
import type { DimensionDef, ProjectSnapshot } from '../../lib/types/project-snapshot.js';
import type { PipelineFillView } from '../../lib/types/snapshot-views.js';
import { ColdStartBaselinePipeline } from '../../lib/workflows/scan/lifecycle/ColdStartBaselinePipeline.js';
import type { ScanPlan } from '../../lib/workflows/scan/ScanTypes.js';

function makeView(): PipelineFillView {
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
    snapshot: { projectRoot: '/repo', allFiles: [] } as ProjectSnapshot,
    ctx: { container: { get: () => null } },
    bootstrapSession: null,
    targetFileMap: {},
    projectRoot: '/repo',
    scanPlan,
  };
}

const dimensions: DimensionDef[] = [{ id: 'architecture', label: 'Architecture', description: '' }];

describe('ColdStartBaselinePipeline', () => {
  test('executes dimensions through the injected cold-start workflow', async () => {
    const workflow = {
      run: vi.fn(async () => ({
        mode: 'cold-start' as const,
        execution: { status: 'completed' as const, summary: { snapshotId: 'snap_1' } },
      })),
    };
    const pipeline = new ColdStartBaselinePipeline(
      workflow as ConstructorParameters<typeof ColdStartBaselinePipeline>[0]
    );
    const view = makeView();

    const result = await pipeline.executeDimensions({
      view,
      dimensions,
      plan: view.scanPlan ?? undefined,
    });

    expect(result.execution.summary).toEqual({ snapshotId: 'snap_1' });
    expect(workflow.run).toHaveBeenCalledWith({ view, dimensions, plan: view.scanPlan });
  });

  test('projects execution output into a baseline result without owning persistence', () => {
    const pipeline = new ColdStartBaselinePipeline();

    const baseline = pipeline.projectBaseline({
      scanRunId: 'scan-1',
      execution: {
        status: 'completed',
        summary: {
          snapshotId: 'snap_1',
          candidatesCreated: 2,
          skillsCreated: 1,
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
    });

    expect(baseline).toMatchObject({
      mode: 'cold-start',
      baselineRunId: 'scan-1',
      baselineSnapshotId: 'snap_1',
      candidates: { created: 2 },
      skills: { created: 1 },
      coverage: { dimensionCoverageRatio: 1, fileCoverageRatio: 0.5 },
    });
  });
});
