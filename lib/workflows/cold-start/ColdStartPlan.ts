import type { ProjectSnapshot } from '#types/project-snapshot.js';
import type {
  ProjectAnalysisMaterializationPlan,
  ProjectAnalysisPreparationOptions,
  ProjectAnalysisScanOptions,
} from '#workflows/capabilities/project-intelligence/ProjectIntelligenceCapability.js';
import type { ColdStartWorkflowIntent } from './ColdStartIntent.js';

export interface ColdStartWorkflowPlan {
  intent: ColdStartWorkflowIntent;
  cleanup: {
    policy: 'full-reset';
    projectRoot: string;
    dataRoot: string;
  };
  projectAnalysis: {
    projectRoot: string;
    prepare: ProjectAnalysisPreparationOptions;
    scan: ProjectAnalysisScanOptions;
    materialize: ProjectAnalysisMaterializationPlan;
  };
  response: {
    tool: 'alembic_bootstrap';
  };
}

export function buildColdStartWorkflowPlan({
  intent,
  projectRoot,
  dataRoot,
}: {
  intent: ColdStartWorkflowIntent;
  projectRoot: string;
  dataRoot: string;
}): ColdStartWorkflowPlan {
  const prepare: ProjectAnalysisPreparationOptions = {
    clearOldData: true,
    ...(intent.executor === 'external-agent' ? { dataRoot } : {}),
  };
  const scan: ProjectAnalysisScanOptions = {
    maxFiles: intent.projectAnalysis.maxFiles,
    contentMaxLines: intent.projectAnalysis.contentMaxLines,
    skipGuard: intent.projectAnalysis.skipGuard,
    sourceTag: intent.projectAnalysis.sourceTag,
    summaryPrefix: intent.projectAnalysis.summaryPrefix,
    generateReport: true,
    generateAstContext: intent.projectAnalysis.generateAstContext,
    incremental: false,
  };
  const materialize: ProjectAnalysisMaterializationPlan = {
    codeEntityGraph: true,
    callGraph: true,
    dependencyEdges: true,
    moduleEntities: true,
    guardViolations: true,
    panorama: true,
  };

  return {
    intent,
    cleanup: {
      policy: 'full-reset',
      projectRoot: intent.executor === 'external-agent' ? dataRoot : projectRoot,
      dataRoot,
    },
    projectAnalysis: {
      projectRoot,
      prepare,
      scan,
      materialize,
    },
    response: { tool: 'alembic_bootstrap' },
  };
}

export function selectColdStartDimensions(
  snapshot: ProjectSnapshot,
  intent: ColdStartWorkflowIntent
) {
  const dimensions = [...snapshot.activeDimensions];
  if (!intent.dimensionIds?.length) {
    return dimensions;
  }
  const requestedIds = new Set(intent.dimensionIds);
  return dimensions.filter((dimension) => requestedIds.has(dimension.id));
}
