import type { BootstrapFile, IncrementalPlan } from '#types/workflows.js';
import { baseDimensions } from '#workflows/capabilities/planning/dimensions/BaseDimensions.js';
import type { PhaseReport } from '#workflows/capabilities/project-intelligence/ProjectIntelligenceRunner.js';

interface ProjectAnalysisIncrementalLogger {
  info(...args: unknown[]): void;
}

interface ProjectAnalysisIncrementalContext {
  container?: unknown;
  db?: unknown;
  logger: ProjectAnalysisIncrementalLogger;
}

interface ProjectAnalysisIncrementalContainer {
  get?: (name: string) => unknown;
  resolve?: (name: string) => unknown;
}

export interface ProjectAnalysisIncrementalEvaluationInput {
  enabled: boolean;
  projectRoot: string;
  ctx: ProjectAnalysisIncrementalContext;
  allFiles: BootstrapFile[];
  report: PhaseReport | null;
}

export interface ProjectAnalysisIncrementalEvaluationResult {
  incrementalPlan: IncrementalPlan | null;
  warnings: string[];
}

export async function evaluateProjectAnalysisIncrementalPlan({
  enabled,
  projectRoot,
  ctx,
  allFiles,
  report,
}: ProjectAnalysisIncrementalEvaluationInput): Promise<ProjectAnalysisIncrementalEvaluationResult> {
  const warnings: string[] = [];

  if (!enabled) {
    return { incrementalPlan: null, warnings };
  }

  try {
    const { FileDiffPlanner } = await import(
      '#workflows/capabilities/project-intelligence/FileDiffPlanner.js'
    );
    const db = resolveIncrementalDatabase(ctx);
    if (!db) {
      warnings.push('incremental: db not available, falling back to full');
      return { incrementalPlan: null, warnings };
    }

    const fileDiffPlanner = new FileDiffPlanner(db, projectRoot, { logger: ctx.logger });
    const dimensionIds = baseDimensions.map((dimension) => dimension.id);
    const incrementalPlan = fileDiffPlanner.evaluate(allFiles, dimensionIds) as IncrementalPlan;
    if (report) {
      report.phases.incremental = { plan: incrementalPlan };
    }
    ctx.logger.info(
      `[Bootstrap] Incremental mode: ${incrementalPlan.mode}, affected: ${incrementalPlan.affectedDimensions?.length || 0}`
    );
    return { incrementalPlan, warnings };
  } catch (err: unknown) {
    warnings.push(
      `incremental evaluation failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
    return { incrementalPlan: null, warnings };
  }
}

function resolveIncrementalDatabase(ctx: ProjectAnalysisIncrementalContext): unknown {
  const container = ctx.container;
  if (container && typeof container === 'object') {
    const containerLike = container as ProjectAnalysisIncrementalContainer;
    return (
      resolveContainerService(containerLike.get, 'database') ??
      resolveContainerService(containerLike.get, 'db') ??
      resolveContainerService(containerLike.resolve, 'database') ??
      resolveContainerService(containerLike.resolve, 'db') ??
      ctx.db
    );
  }
  return ctx.db;
}

function resolveContainerService(
  resolver:
    | ProjectAnalysisIncrementalContainer['get']
    | ProjectAnalysisIncrementalContainer['resolve'],
  name: string
) {
  if (typeof resolver !== 'function') {
    return undefined;
  }
  try {
    return resolver(name);
  } catch {
    return undefined;
  }
}
