import type { DimensionDef } from '@alembic/core/types';
import { clearProjectContextFileSnapshots } from '../../../infrastructure/database/SqliteDatabaseAccess.js';
import type { ProjectContextFillView } from '../../../project-facts/ProjectContextWorkflowFacts.js';
import { finalizeAiDimensionPipeline as finalizeAiDimension } from './AiDimensionFinalizer.js';
import {
  emitAiDimensionAiUnavailable,
  prepareAiDimensionPipeline as prepareAiDimensionRun,
} from './AiDimensionPreparation.js';
import {
  type AiDimensionSessionResult,
  runAiDimensionSession,
} from './AiDimensionSessionRunner.js';
import type {
  GenerateWorkflowContainer as AiDimensionContainer,
  GenerateWorkflowContext as AiDimensionContext,
} from './AiDimensionTypes.js';
import { initializeGenerateRuntime } from './RuntimeInitializer.js';

export type { AiDimensionContainer, AiDimensionContext };

export interface AiDimensionPipelineResult {
  sessionResult: AiDimensionSessionResult | null;
  skippedReason?: 'ai-unavailable';
}

export async function runAiDimensionPipelineForResult(
  view: ProjectContextFillView,
  dimensions: DimensionDef[]
): Promise<AiDimensionPipelineResult> {
  const preparation = prepareAiDimensionRun(view, dimensions);

  if (
    preparation.aiUnavailable ||
    !preparation.agentService ||
    !preparation.systemRunContextFactory
  ) {
    emitAiDimensionAiUnavailable(preparation);
    return { sessionResult: null, skippedReason: 'ai-unavailable' };
  }

  const runtime = await initializeGenerateRuntime({
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
  return { sessionResult };
}

export async function runAiDimensionPipeline(
  view: ProjectContextFillView,
  dimensions: DimensionDef[]
) {
  await runAiDimensionPipelineForResult(view, dimensions);
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
    if (clearProjectContextFileSnapshots(db, projectRoot)) {
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
