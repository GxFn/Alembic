import Logger from '#infra/logging/Logger.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import type { PipelineFillView } from '#types/snapshot-views.js';
import { initializeBootstrapRuntime } from '#workflows/capabilities/execution/internal-agent/context/BootstrapRuntimeInitializer.js';
import { finalizeInternalDimensionFill as finalizeInternalDimensionExecution } from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillFinalizer.js';
import {
  emitInternalDimensionFillAiUnavailable as emitInternalDimensionExecutionAiUnavailable,
  prepareInternalDimensionFillRun as prepareInternalDimensionExecutionRun,
} from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillPreparation.js';
import { runInternalDimensionAgentSession } from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillSessionRunner.js';
import type {
  BootstrapWorkflowContainer as InternalDimensionExecutionContainer,
  BootstrapWorkflowContext as InternalDimensionExecutionContext,
} from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillTypes.js';
import { fillDimensionsMock } from '#workflows/capabilities/execution/internal-agent/mock/MockBootstrapPipeline.js';

const logger = Logger.getInstance();

export type { InternalDimensionExecutionContainer, InternalDimensionExecutionContext };

export async function runInternalDimensionExecution(
  view: PipelineFillView,
  dimensions: DimensionDef[]
) {
  const preparation = prepareInternalDimensionExecutionRun(view, dimensions);

  if (
    (!preparation.agentService || !preparation.systemRunContextFactory) &&
    !preparation.isMockMode
  ) {
    emitInternalDimensionExecutionAiUnavailable(preparation);
    return;
  }

  if (preparation.isMockMode) {
    logger.info('[InternalDimensionExecution] Mock AI detected — routing to mock-pipeline');
    await fillDimensionsMock(view, dimensions);
    return;
  }

  const runtime = await initializeBootstrapRuntime({
    container: preparation.ctx.container,
    projectRoot: preparation.projectRoot,
    dataRoot: preparation.dataRoot,
    primaryLang: preparation.primaryLang,
    allFiles: preparation.allFiles,
    targetFileMap: preparation.targetFileMap,
    depGraphData: preparation.depGraphData,
    astProjectSummary: preparation.astProjectSummary as Record<string, unknown> | null,
    guardAudit: preparation.guardAudit as Record<string, unknown> | null,
    isIncremental: preparation.isIncremental,
    incrementalPlan: preparation.incrementalPlan,
  });

  const startedAtMs = Date.now();
  const sessionResult = await runInternalDimensionAgentSession({ preparation, runtime });
  await finalizeInternalDimensionExecution({ preparation, runtime, sessionResult, startedAtMs });
}

export async function clearSnapshots(
  projectRoot: string,
  ctx: {
    container: InternalDimensionExecutionContainer;
    logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  }
) {
  try {
    const db = ctx.container.get('database');
    if (db) {
      const { FileDiffSnapshotStore } = await import(
        '#workflows/capabilities/project-intelligence/FileDiffSnapshotStore.js'
      );
      const snap = new FileDiffSnapshotStore(db, { logger: ctx.logger });
      snap.clearProject(projectRoot);
      ctx.logger.info('[Workflow] Cleared file-diff snapshots — forcing full rebuild');
    }
  } catch (err: unknown) {
    ctx.logger.warn(
      `[Workflow] clearSnapshots failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export { clearDimensionCheckpoints as clearCheckpoints } from '#workflows/capabilities/persistence/checkpoint/DimensionCheckpointStore.js';

export default runInternalDimensionExecution;
