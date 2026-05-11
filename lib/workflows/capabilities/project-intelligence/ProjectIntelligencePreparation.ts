import pathGuard from '#shared/PathGuard.js';

interface ProjectAnalysisPreparationLogger {
  info(...args: unknown[]): void;
}

interface ProjectAnalysisPreparationContext {
  logger: ProjectAnalysisPreparationLogger;
}

interface ProjectAnalysisPreparationOptions {
  clearOldData?: boolean;
  dataRoot?: string;
}

export interface ProjectAnalysisRunPreparationInput {
  projectRoot: string;
  ctx: ProjectAnalysisPreparationContext;
  options: ProjectAnalysisPreparationOptions;
}

export interface ProjectAnalysisRunPreparationResult {
  warnings: string[];
}

export async function prepareProjectAnalysisRun({
  projectRoot,
  ctx,
  options,
}: ProjectAnalysisRunPreparationInput): Promise<ProjectAnalysisRunPreparationResult> {
  const warnings: string[] = [];

  await ensureProjectAnalysisPathGuard(projectRoot);

  if (options.clearOldData) {
    const clearResult = await clearPreviousProjectAnalysisState({ projectRoot, ctx, options });
    warnings.push(...clearResult.warnings);
  }

  return { warnings };
}

async function ensureProjectAnalysisPathGuard(projectRoot: string): Promise<void> {
  if (pathGuard.configured) {
    return;
  }

  const { default: Bootstrap } = await import('../../../bootstrap.js');
  (Bootstrap as { configurePathGuard(root: string): void }).configurePathGuard(projectRoot);
}

async function clearPreviousProjectAnalysisState({
  projectRoot,
  ctx,
  options,
}: ProjectAnalysisRunPreparationInput): Promise<ProjectAnalysisRunPreparationResult> {
  const warnings: string[] = [];
  try {
    const clearRoot = options.dataRoot || projectRoot;
    const { clearCheckpoints, clearSnapshots } = await import(
      '#workflows/capabilities/execution/internal-agent/InternalDimensionExecutionPipeline.js'
    );
    await clearCheckpoints(clearRoot);
    await clearSnapshots(clearRoot, ctx as Parameters<typeof clearSnapshots>[1]);
    ctx.logger.info('[Bootstrap] Cleared old checkpoints and snapshots');
  } catch (err: unknown) {
    warnings.push(
      `clearOldData failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return { warnings };
}
