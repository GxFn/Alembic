import type { ScanRunRecord } from '#repo/scan/ScanRunRepository.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import {
  ColdStartWorkflow,
  type ColdStartWorkflowResult,
} from '#workflows/cold-start/dimension-execution/ColdStartWorkflow.js';
import { ColdStartBaselinePipeline } from '#workflows/scan/lifecycle/ColdStartBaselinePipeline.js';
import type { ColdStartBaselineResult } from '#workflows/scan/lifecycle/ColdStartBaselineProjection.js';
import type { ColdStartScanContext } from '#workflows/scan/lifecycle/ColdStartScanContext.js';
import {
  ScanRunTracker,
  type ScanRunTrackerContainer,
} from '#workflows/scan/lifecycle/ScanRunTracker.js';

interface ColdStartLifecycleContext {
  container?: ScanRunTrackerContainer;
  logger?: { warn(...args: unknown[]): void };
}

export interface ColdStartLifecycleResult extends ColdStartWorkflowResult {
  baseline: ColdStartBaselineResult;
  run: ScanRunRecord | null;
}

export function completeColdStartLifecycleRun(
  ctx: ColdStartLifecycleContext,
  scanContext: ColdStartScanContext | null,
  summary: Record<string, unknown>
): ColdStartScanContext | null {
  const tracker = ctx.container
    ? ScanRunTracker.fromContainer(ctx.container, ctx.logger)
    : new ScanRunTracker();
  const baseline = resolveColdStartBaselinePipeline(ctx.container).projectBaseline({
    scanContext,
    summary,
  });
  const run = completeBaselineRun(tracker, scanContext?.run?.id, baseline);
  return run && scanContext ? { ...scanContext, run } : scanContext;
}

export async function runColdStartLifecycleFill(
  view: PipelineFillView,
  dimensions: DimensionDef[]
): Promise<ColdStartLifecycleResult> {
  const ctx = view.ctx as ColdStartLifecycleContext;
  const tracker = ctx.container
    ? ScanRunTracker.fromContainer(ctx.container, ctx.logger)
    : new ScanRunTracker();
  const scanRunId = view.scanRunId ?? null;

  try {
    const baselinePipeline = resolveColdStartBaselinePipeline(ctx.container);
    const result = await baselinePipeline.executeDimensions({
      view,
      dimensions,
      plan: view.scanPlan ?? undefined,
    });
    if (result.execution.status === 'ai-unavailable') {
      const run = tracker.fail(scanRunId, 'AI Provider not available', result.execution.summary);
      const baseline = baselinePipeline.projectBaseline({ scanRunId, execution: result.execution });
      return { ...result, baseline, run };
    }
    const baseline = baselinePipeline.projectBaseline({
      scanRunId,
      execution: result.execution,
    });
    const run = completeBaselineRun(tracker, scanRunId, baseline);
    return { ...result, baseline, run };
  } catch (err: unknown) {
    tracker.fail(scanRunId, err, {
      stage: 'bootstrap-dimension-fill',
      dimensions: dimensions.length,
    });
    throw err;
  }
}

function completeBaselineRun(
  tracker: ScanRunTracker,
  scanRunId: string | null | undefined,
  baseline: ColdStartBaselineResult
): ScanRunRecord | null {
  return baseline.baselineSnapshotId
    ? tracker.complete(scanRunId, baseline, { baselineSnapshotId: baseline.baselineSnapshotId })
    : tracker.complete(scanRunId, baseline);
}

function resolveColdStartWorkflow(
  container: ScanRunTrackerContainer | undefined
): ColdStartWorkflow {
  try {
    const workflow = container?.get?.('coldStartWorkflow') as ColdStartWorkflow | undefined;
    return workflow && typeof workflow.run === 'function' ? workflow : new ColdStartWorkflow();
  } catch {
    return new ColdStartWorkflow();
  }
}

function resolveColdStartBaselinePipeline(
  container: ScanRunTrackerContainer | undefined
): ColdStartBaselinePipeline {
  try {
    const pipeline = container?.get?.('coldStartBaselinePipeline') as
      | ColdStartBaselinePipeline
      | undefined;
    if (
      pipeline &&
      typeof pipeline.executeDimensions === 'function' &&
      typeof pipeline.projectBaseline === 'function'
    ) {
      return pipeline;
    }
  } catch {
    /* fall through to local pipeline */
  }
  return new ColdStartBaselinePipeline(resolveColdStartWorkflow(container));
}
