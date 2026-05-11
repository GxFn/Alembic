import { prepareProjectAnalysisRun } from '#workflows/capabilities/project-intelligence/ProjectIntelligencePreparation.js';
import {
  type ProjectAnalysisMaterializationInput,
  type ProjectAnalysisMaterializationOptions,
  runAllPhases,
} from '#workflows/capabilities/project-intelligence/ProjectIntelligenceRunner.js';

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

export interface ProjectIntelligenceCapabilityRunInput {
  projectRoot: string;
  ctx: ProjectAnalysisContext;
  prepare?: ProjectAnalysisPreparationOptions;
  scan?: ProjectAnalysisScanOptions;
  materialize?: ProjectAnalysisMaterializationPlan;
}

export interface ProjectIntelligenceCapabilityFacade {
  run(input: ProjectIntelligenceCapabilityRunInput): Promise<ProjectAnalysisResult>;
}

export const ProjectIntelligenceCapability: ProjectIntelligenceCapabilityFacade = {
  async run({
    projectRoot,
    ctx,
    prepare,
    scan,
    materialize,
  }: ProjectIntelligenceCapabilityRunInput) {
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

export type ProjectAnalysisCapabilityRunInput = ProjectIntelligenceCapabilityRunInput;
export type ProjectAnalysisCapabilityFacade = ProjectIntelligenceCapabilityFacade;
export const ProjectAnalysisCapability = ProjectIntelligenceCapability;

export function collectProjectAnalysis(
  projectRoot: string,
  ctx: ProjectAnalysisContext,
  options: ProjectAnalysisOptions = {}
): Promise<ProjectAnalysisResult> {
  const { materialize, clearOldData, dataRoot, ...scan } = options;
  const prepare =
    clearOldData !== undefined || dataRoot !== undefined ? { clearOldData, dataRoot } : undefined;
  return ProjectIntelligenceCapability.run({ projectRoot, ctx, prepare, scan, materialize });
}
