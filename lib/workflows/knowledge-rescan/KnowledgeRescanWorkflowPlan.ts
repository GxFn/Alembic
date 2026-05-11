import type { DimensionDef } from '#types/project-snapshot.js';
import type {
  ProjectAnalysisMaterializationPlan,
  ProjectAnalysisPreparationOptions,
  ProjectAnalysisScanOptions,
} from '#workflows/capabilities/project-intelligence/ProjectIntelligenceCapability.js';
import type { KnowledgeRescanWorkflowIntent } from './KnowledgeRescanIntent.js';

export interface KnowledgeRescanWorkflowPlan {
  intent: KnowledgeRescanWorkflowIntent;
  cleanup: {
    policy: 'none' | 'force-rescan' | 'rescan-clean';
    projectRoot: string;
  };
  projectAnalysis: {
    projectRoot: string;
    prepare: ProjectAnalysisPreparationOptions;
    scan: ProjectAnalysisScanOptions;
    materialize: ProjectAnalysisMaterializationPlan;
  };
  response: {
    tool: 'alembic_rescan';
  };
}

export function buildKnowledgeRescanWorkflowPlan({
  intent,
  projectRoot,
  dataRoot,
}: {
  intent: KnowledgeRescanWorkflowIntent;
  projectRoot: string;
  dataRoot: string;
}): KnowledgeRescanWorkflowPlan {
  const prepare: ProjectAnalysisPreparationOptions = {};
  const scan: ProjectAnalysisScanOptions = {
    maxFiles: intent.projectAnalysis.maxFiles,
    contentMaxLines: intent.projectAnalysis.contentMaxLines,
    sourceTag: intent.projectAnalysis.sourceTag,
    summaryPrefix: intent.projectAnalysis.summaryPrefix,
    generateReport: true,
    generateAstContext: intent.projectAnalysis.generateAstContext,
    incremental: intent.analysisMode === 'incremental',
    logPrefix: 'Rescan',
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
      policy: intent.cleanupPolicy,
      projectRoot: dataRoot,
    },
    projectAnalysis: {
      projectRoot,
      prepare,
      scan,
      materialize,
    },
    response: { tool: 'alembic_rescan' },
  };
}

export function selectKnowledgeRescanDimensions(
  dimensions: readonly DimensionDef[],
  intent: KnowledgeRescanWorkflowIntent
): DimensionDef[] {
  const allDimensions = [...dimensions];
  if (!intent.dimensionIds?.length) {
    return allDimensions;
  }
  const requestedIds = new Set(intent.dimensionIds);
  return allDimensions.filter((dimension) => requestedIds.has(dimension.id));
}
