import {
  type ProjectAnalysisMaterializationInput,
  type ProjectAnalysisMaterializationOptions,
  runAllPhases,
} from '#workflows/common-capabilities/project-analysis/ProjectAnalysisRunner.js';
import { prepareProjectAnalysisRun } from '#workflows/common-capabilities/project-analysis/ProjectAnalysisRunPreparation.js';

export type ProjectAnalysisContext = Parameters<typeof runAllPhases>[1];
export type ProjectAnalysisOptions = Parameters<typeof runAllPhases>[2];
export type ProjectAnalysisResult = Awaited<ReturnType<typeof runAllPhases>>;
export type ProjectAnalysisPreparationOptions = Pick<
  NonNullable<ProjectAnalysisOptions>,
  'clearOldData' | 'dataRoot'
>;
export type ProjectAnalysisScanOptions = Omit<
  NonNullable<ProjectAnalysisOptions>,
  'materialize' | 'clearOldData' | 'dataRoot'
>;
export type ProjectAnalysisMaterializationPlan = ProjectAnalysisMaterializationInput;
export type ProjectAnalysisMaterialization = ProjectAnalysisMaterializationOptions;

export interface ProjectAnalysisCapabilityRunInput {
  projectRoot: string;
  ctx: ProjectAnalysisContext;
  prepare?: ProjectAnalysisPreparationOptions;
  scan?: ProjectAnalysisScanOptions;
  materialize?: ProjectAnalysisMaterializationPlan;
}

export interface ProjectAnalysisCapabilityFacade {
  run(input: ProjectAnalysisCapabilityRunInput): Promise<ProjectAnalysisResult>;
}

export const ProjectAnalysisCapability: ProjectAnalysisCapabilityFacade = {
  async run({ projectRoot, ctx, prepare, scan, materialize }: ProjectAnalysisCapabilityRunInput) {
    const preparation = await prepareProjectAnalysisRun({
      projectRoot,
      ctx,
      options: prepare ?? {},
    });
    const result = await runAllPhases(projectRoot, ctx, {
      ...(scan ?? {}),
      materialize,
    });
    if (preparation.warnings.length === 0) {
      return result;
    }
    return { ...result, warnings: [...preparation.warnings, ...result.warnings] };
  },
};

export function collectProjectAnalysis(
  projectRoot: string,
  ctx: ProjectAnalysisContext,
  options: ProjectAnalysisOptions = {}
): Promise<ProjectAnalysisResult> {
  const { materialize, clearOldData, dataRoot, ...scan } = options;
  const prepare =
    clearOldData !== undefined || dataRoot !== undefined ? { clearOldData, dataRoot } : undefined;
  return ProjectAnalysisCapability.run({ projectRoot, ctx, prepare, scan, materialize });
}
