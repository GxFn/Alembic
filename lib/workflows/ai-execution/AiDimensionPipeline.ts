import type { DimensionDef } from '@alembic/core/project-intelligence';
import type { PipelineFillView } from '@alembic/core/types';
import { finalizeAiDimensionPipeline as finalizeAiDimension } from './AiDimensionFinalizer.js';
import {
  emitAiDimensionAiUnavailable,
  prepareAiDimensionPipeline as prepareAiDimensionRun,
} from './AiDimensionPreparation.js';
import { runAiDimensionSession } from './AiDimensionSessionRunner.js';
import type {
  BootstrapWorkflowContainer as AiDimensionContainer,
  BootstrapWorkflowContext as AiDimensionContext,
} from './AiDimensionTypes.js';
import { initializeBootstrapRuntime } from './RuntimeInitializer.js';

export type { AiDimensionContainer, AiDimensionContext };

export async function runAiDimensionPipeline(view: PipelineFillView, dimensions: DimensionDef[]) {
  const preparation = prepareAiDimensionRun(view, dimensions);

  if (
    preparation.aiUnavailable ||
    !preparation.agentService ||
    !preparation.systemRunContextFactory
  ) {
    emitAiDimensionAiUnavailable(preparation);
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
    projectScopeSourceIdentities: preparation.projectScopeSourceIdentities,
  });

  const startedAtMs = Date.now();
  const sessionResult = await runAiDimensionSession({ preparation, runtime });
  await finalizeAiDimension({ preparation, runtime, sessionResult, startedAtMs });
}

export async function clearSnapshots(
  projectRoot: string,
  ctx: {
    container: AiDimensionContainer;
    logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  }
) {
  try {
    const db = ctx.container.get('database');
    if (db) {
      const { FileDiffSnapshotStore } = await import('@alembic/core/project-intelligence');
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

export { clearDimensionCheckpoints as clearCheckpoints } from '@alembic/core/host-agent-workflows';

export default runAiDimensionPipeline;
