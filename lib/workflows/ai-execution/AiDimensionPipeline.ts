import type { DimensionDef } from '@alembic/core/types';
import type { ProjectContextFillView } from '../project-context/ProjectContextWorkflowFacts.js';
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

export async function runAiDimensionPipeline(
  view: ProjectContextFillView,
  dimensions: DimensionDef[]
) {
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
    const target = db as
      | { prepare?: (sql: string) => { run(...values: unknown[]): unknown } }
      | null
      | undefined;
    if (target?.prepare) {
      target
        .prepare('DELETE FROM project_context_file_snapshots WHERE project_root = ?')
        .run(projectRoot);
      ctx.logger.info('[Workflow] Cleared ProjectContext file snapshots — forcing full rebuild');
    }
  } catch (err: unknown) {
    ctx.logger.warn(
      `[Workflow] clearSnapshots failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export { clearDimensionCheckpoints as clearCheckpoints } from '@alembic/core/host-agent-workflows';

export default runAiDimensionPipeline;
