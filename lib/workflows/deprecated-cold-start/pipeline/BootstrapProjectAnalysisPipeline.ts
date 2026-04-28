import type { ProjectSnapshot } from '#types/project-snapshot.js';
import { buildProjectSnapshot } from '#types/project-snapshot-builder.js';
import { runAllPhases } from '#workflows/deprecated-cold-start/phases/BootstrapPhaseRunner.js';

export type BootstrapPhaseResults = Awaited<ReturnType<typeof runAllPhases>>;
type ProjectAnalysisContext = Parameters<typeof runAllPhases>[1];

export interface RunBootstrapProjectAnalysisOptions {
  projectRoot: string;
  ctx: ProjectAnalysisContext;
  sourceTag: string;
  phaseOptions?: Parameters<typeof runAllPhases>[2];
}

export interface BootstrapProjectAnalysisResult {
  phaseResults: BootstrapPhaseResults;
  snapshot: ProjectSnapshot;
}

export async function runBootstrapProjectAnalysis({
  projectRoot,
  ctx,
  sourceTag,
  phaseOptions = {},
}: RunBootstrapProjectAnalysisOptions): Promise<BootstrapProjectAnalysisResult> {
  const resolvedSourceTag = phaseOptions.sourceTag ?? sourceTag;
  const phaseResults = await runAllPhases(projectRoot, ctx, {
    ...phaseOptions,
    sourceTag: resolvedSourceTag,
  });
  const snapshot = buildProjectSnapshot({
    projectRoot,
    sourceTag: resolvedSourceTag,
    ...phaseResults,
    report: phaseResults.report,
  });
  return { phaseResults, snapshot };
}
