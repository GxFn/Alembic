import {
  buildInternalNextSteps,
  type DimensionDef,
  type KnowledgeRescanExecutionDecision,
} from '@alembic/core/host-agent-workflows';
import type { BootstrapSessionShape } from '@alembic/core/types';
import type { ProjectContextWorkflowFacts } from './ProjectContextWorkflowFacts.js';

export function presentProjectContextColdStartEmptyProject(input: {
  facts: ProjectContextWorkflowFacts;
  responseTimeMs: number;
}) {
  return workflowEnvelope({
    data: {
      message: 'No source files found, nothing to bootstrap',
      projectContext: input.facts.projectContextSummary,
      report: input.facts.report,
    },
    meta: { tool: 'alembic_bootstrap', responseTimeMs: input.responseTimeMs },
  });
}

export function presentProjectContextColdStartResponse(input: {
  bootstrapSession: BootstrapSessionShape | null;
  cachedSessionId: string | null;
  cleanupResult: unknown;
  dimensions: DimensionDef[];
  facts: ProjectContextWorkflowFacts;
  responseTimeMs: number;
  selectionSummary?: unknown;
  taskCount: number;
}) {
  return workflowEnvelope({
    data: {
      analysisFramework: buildAnalysisFramework(input.dimensions, input.selectionSummary),
      autoSkills: { created: 0, failed: 0, skills: [], errors: [], status: 'filling' },
      bootstrapCandidates: { created: 0, failed: 0, errors: [], status: 'filling' },
      bootstrapSession: input.bootstrapSession ? input.bootstrapSession.toJSON() : null,
      cleanup: input.cleanupResult,
      dimensionSelection: input.selectionSummary ?? null,
      files: input.facts.fileCount,
      filesByTarget: input.facts.filesByTarget,
      languageStats: input.facts.languageStats,
      nextSteps: buildInternalNextSteps(input.dimensions),
      primaryLanguage: input.facts.primaryLang,
      projectContext: input.facts.projectContextSummary,
      report: input.facts.report,
      secondaryLanguages: input.facts.secondaryLanguages,
      targets: input.facts.allTargets,
      taskCount: input.taskCount,
      warnings: input.facts.warnings.length > 0 ? input.facts.warnings : undefined,
      ...(input.cachedSessionId ? { sessionId: input.cachedSessionId } : {}),
      message: `Bootstrap 骨架已创建: ${input.facts.fileCount} files, ${input.facts.targetCount} targets, ${input.taskCount} 个维度任务已排队，项目事实来自 ProjectContext，正在后台逐一填充...`,
    },
    meta: { tool: 'alembic_bootstrap', responseTimeMs: input.responseTimeMs },
  });
}

export function presentProjectContextRescanResponse(input: {
  auditSummary: unknown;
  bootstrapSession: BootstrapSessionShape | null;
  cleanResult: Record<string, unknown>;
  evolutionAudit?: Record<string, unknown> | null;
  facts: ProjectContextWorkflowFacts;
  gapPlan: {
    executionDimensions: DimensionDef[];
    produceDimensions: DimensionDef[];
    gapDimensions: DimensionDef[];
    skippedDimensions: DimensionDef[];
    requestedDimensions: DimensionDef[];
    targetPerDimension: number;
    executionReasons?: unknown;
    executionDecisions?: KnowledgeRescanExecutionDecision[];
    coverageByDimension?: Record<string, number>;
  };
  miningMode?: 'deepMining' | 'moduleMining' | 'per-module' | null;
  moduleMining?: Record<string, unknown> | null;
  inlineFill?: {
    coverageSkippedDimensions: number;
    coverageWrittenCells: number;
    newRecipesThisRound: number;
  } | null;
  reason?: string | null;
  recipeSnapshot: { count: number };
  responseTimeMs: number;
  sessionId: string | null;
  produceSession?: Record<string, unknown> | null;
}) {
  const executionDimensionCount = input.gapPlan.executionDimensions.length;
  const produceSession = input.produceSession ?? null;
  const inlineFill = input.inlineFill ?? null;
  const produceSessionRequired = isRecord(produceSession) && produceSession.required === true;
  const produceSessionBlocked =
    produceSessionRequired && produceSession.status === 'no-produce-session';
  const asyncFill = !produceSessionRequired && executionDimensionCount > 0 && !inlineFill;
  return workflowEnvelope({
    data: {
      asyncFill,
      bootstrapSession: input.bootstrapSession ? input.bootstrapSession.toJSON() : null,
      evolutionAudit: input.evolutionAudit ?? null,
      files: input.facts.fileCount,
      gapAnalysis: {
        executionDimensions: executionDimensionCount,
        executionReasons: input.gapPlan.executionReasons ?? [],
        gapDimensions: input.gapPlan.gapDimensions.length,
        produceDimensions: input.gapPlan.produceDimensions.length,
        skippedDimensions: input.gapPlan.skippedDimensions.map((dimension) => dimension.id),
        targetPerDimension: input.gapPlan.targetPerDimension,
        totalDimensions: input.gapPlan.requestedDimensions.length,
      },
      languageStats: input.facts.languageStats,
      miningMode: input.miningMode ?? null,
      moduleMining: input.moduleMining ?? null,
      ...(inlineFill
        ? {
            coverageLedger: {
              skippedDimensions: inlineFill.coverageSkippedDimensions,
              writtenCells: inlineFill.coverageWrittenCells,
            },
            newRecipesThisRound: inlineFill.newRecipesThisRound,
          }
        : {}),
      primaryLanguage: input.facts.primaryLang,
      projectContext: input.facts.projectContextSummary,
      produceSession,
      reason: input.reason ?? null,
      relevanceAudit: input.auditSummary,
      rescan: {
        cleanedFiles: input.cleanResult.deletedFiles ?? 0,
        cleanedTables: Array.isArray(input.cleanResult.clearedTables)
          ? input.cleanResult.clearedTables.length
          : 0,
        preservedRecipes: input.recipeSnapshot.count,
        reason: input.reason ?? null,
      },
      sessionId: input.sessionId,
      status: asyncFill ? 'filling' : 'complete',
      targets: input.facts.targetCount,
      warnings: input.facts.warnings.length > 0 ? input.facts.warnings : undefined,
    },
    errorCode: produceSessionBlocked ? 'NO_PRODUCE_SESSION' : null,
    message: produceSessionBlocked
      ? 'No controller-authorized produce session could be opened for this rescan.'
      : undefined,
    meta: { tool: 'alembic_rescan', responseTimeMs: input.responseTimeMs },
    success: !produceSessionBlocked,
  });
}

function buildAnalysisFramework(dimensions: readonly DimensionDef[], selectionSummary: unknown) {
  return {
    candidateOnlyDimensions: dimensions
      .filter((dimension) => !dimension.skillWorthy)
      .map((dimension) => dimension.id),
    dimensionSelection: selectionSummary ?? null,
    dimensions,
    expectedOutput:
      '候选知识与 Project Skills 由内置 AI 维度执行生成；项目事实由 ProjectContext refs/results 提供。',
    skillWorthyDimensions: dimensions
      .filter((dimension) => dimension.skillWorthy)
      .map((dimension) => dimension.id),
    submissionTool: 'knowledge',
  };
}

function workflowEnvelope(input: {
  data: Record<string, unknown>;
  errorCode?: string | null;
  message?: string;
  meta: Record<string, unknown>;
  success?: boolean;
}) {
  return {
    data: input.data,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.message ? { message: input.message } : {}),
    meta: input.meta,
    success: input.success ?? true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
