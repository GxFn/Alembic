import { envelope } from '#external/mcp/envelope.js';
import type { CleanupResult, RecipeSnapshot } from '#service/cleanup/CleanupService.js';
import type { DimensionDef, GuardAudit, ProjectSnapshot } from '#types/project-snapshot.js';
import type {
  ExternalRescanEvidencePlan,
  InternalRescanGapPlan,
  RelevanceAuditSummary,
} from '#workflows/capabilities/planning/knowledge/KnowledgeRescanPlanner.js';
import { summarizePanorama as summarizeProjectPanorama } from '#workflows/capabilities/presentation/PanoramaSummaryPresenter.js';
import { buildTargetFileMap as buildProjectTargetFileMap } from '#workflows/capabilities/presentation/TargetFileMapBuilder.js';

export type KnowledgeRescanTargetFileMap = Record<string, Array<Record<string, unknown>>>;

export function presentInternalKnowledgeRescanEmptyProject({
  responseTimeMs,
}: {
  responseTimeMs: number;
}) {
  return envelope({
    success: true,
    data: { message: 'No source files found. Nothing to rescan.' },
    meta: { tool: 'alembic_rescan', responseTimeMs },
  });
}

export function presentExternalKnowledgeRescanEmptyProject({
  responseTimeMs,
}: {
  responseTimeMs: number;
}) {
  return envelope({
    success: true,
    data: { message: 'No source files found. Nothing to rescan.' },
    meta: { tool: 'alembic_rescan', responseTimeMs },
  });
}

export function buildInternalKnowledgeRescanTargetFileMap(
  snapshot: ProjectSnapshot,
  contentMaxLines: number
): KnowledgeRescanTargetFileMap {
  return buildProjectTargetFileMap(
    snapshot.allFiles as unknown as Array<{
      name: string;
      relativePath: string;
      targetName: string;
      content: string;
    }>,
    contentMaxLines
  ) as unknown as KnowledgeRescanTargetFileMap;
}

export function presentInternalKnowledgeRescanResponse({
  recipeSnapshot,
  cleanResult,
  auditSummary,
  gapPlan,
  snapshot,
  bootstrapSession,
  sessionId,
  reason,
  responseTimeMs,
}: {
  recipeSnapshot: RecipeSnapshot;
  cleanResult: CleanupResult;
  auditSummary: RelevanceAuditSummary;
  gapPlan: InternalRescanGapPlan;
  snapshot: ProjectSnapshot;
  bootstrapSession: { toJSON(): Record<string, unknown> } | null;
  sessionId: string | null;
  reason?: string | null;
  responseTimeMs: number;
}) {
  const executionDimensionCount = gapPlan.executionDimensions.length;
  const responseData = {
    rescan: {
      preservedRecipes: recipeSnapshot.count,
      cleanedTables: cleanResult.clearedTables.length,
      cleanedFiles: cleanResult.deletedFiles,
      reason: reason || null,
    },
    relevanceAudit: presentRelevanceAudit(auditSummary),
    gapAnalysis: {
      totalDimensions: gapPlan.requestedDimensions.length,
      executionDimensions: executionDimensionCount,
      produceDimensions: gapPlan.produceDimensions.length,
      gapDimensions: gapPlan.gapDimensions.length,
      skippedDimensions: gapPlan.skippedDimensions.map((dimension) => dimension.id),
      targetPerDimension: gapPlan.targetPerDimension,
      executionReasons: gapPlan.executionReasons,
      executionDecisions: gapPlan.executionDecisions.map((decision) => ({
        dimensionId: decision.dimensionId,
        mode: decision.mode,
        existing: decision.existingCount,
        gap: decision.gap,
        createBudget: decision.createBudget,
        reasons: decision.reasons.map((reason) => reason.kind),
      })),
      gaps: gapPlan.gapDimensions.map((dimension) => ({
        dimensionId: dimension.id,
        label: dimension.label,
        existing: gapPlan.coverageByDimension[dimension.id] || 0,
        gap: Math.max(
          0,
          gapPlan.targetPerDimension - (gapPlan.coverageByDimension[dimension.id] || 0)
        ),
      })),
    },
    languageStats: snapshot.language.stats || null,
    primaryLanguage: snapshot.language.primaryLang,
    guardSummary: presentGuardSummary(snapshot.guardAudit),
    astSummary: snapshot.ast
      ? {
          classes: snapshot.ast.classes?.length || 0,
          protocols: snapshot.ast.protocols?.length || 0,
          categories: snapshot.ast.categories?.length || 0,
        }
      : null,
    codeEntityGraph: snapshot.codeEntityGraph
      ? {
          totalEntities:
            snapshot.codeEntityGraph.entityCount ?? snapshot.codeEntityGraph.entitiesUpserted ?? 0,
          totalEdges:
            snapshot.codeEntityGraph.edgeCount ?? snapshot.codeEntityGraph.edgesCreated ?? 0,
        }
      : null,
    callGraph: snapshot.callGraph
      ? {
          entitiesUpserted: snapshot.callGraph.entitiesUpserted || 0,
          edgesCreated: snapshot.callGraph.edgesCreated || 0,
        }
      : null,
    panorama: snapshot.panorama ? summarizeProjectPanorama(snapshot.panorama) : null,
    bootstrapSession: bootstrapSession ? bootstrapSession.toJSON() : null,
    sessionId,
    asyncFill: executionDimensionCount > 0,
    status: executionDimensionCount > 0 ? 'filling' : 'complete',
    files: snapshot.allFiles.length,
    targets: snapshot.allTargets.length,
  };

  return envelope({
    success: true,
    data: responseData,
    message:
      executionDimensionCount > 0
        ? `知识重扫骨架已创建：保留 ${recipeSnapshot.count} 个 Recipe，${executionDimensionCount} 个维度需要处理，正在后台填充...`
        : `知识重扫完成：保留 ${recipeSnapshot.count} 个 Recipe，所有维度已充分覆盖。`,
    meta: { tool: 'alembic_rescan', responseTimeMs },
  });
}

export function presentExternalKnowledgeRescanResponse({
  recipeSnapshot,
  cleanResult,
  auditSummary,
  briefing,
  evidencePlan,
  dimensions,
  reason,
  responseTimeMs,
}: {
  recipeSnapshot: RecipeSnapshot;
  cleanResult: CleanupResult;
  auditSummary: RelevanceAuditSummary;
  briefing: Record<string, unknown>;
  evidencePlan: ExternalRescanEvidencePlan;
  dimensions: DimensionDef[];
  reason?: string | null;
  responseTimeMs: number;
}) {
  return envelope({
    success: true,
    data: {
      rescan: {
        preservedRecipes: recipeSnapshot.count,
        cleanedTables: cleanResult.clearedTables.length,
        cleanedFiles: cleanResult.deletedFiles,
        reason: reason || null,
      },
      relevanceAudit: presentRelevanceAudit(auditSummary),
      ...briefing,
    },
    message:
      `✅ Rescan 完成项目扫描，保留 ${recipeSnapshot.count} 个 Recipe（衰退 ${evidencePlan.decayCount} 个），` +
      `${evidencePlan.coveredDimensions}/${dimensions.length} 个维度已充分覆盖。` +
      `${evidencePlan.gapSummary}` +
      `对每个维度执行三步：` +
      `(1) alembic_evolve — 过滤 allRecipes 中本维度 Recipe，读源码验证后提交决策 → ` +
      `(2) knowledge({ action: "submit" }) — 仅对 executionMode=produce 且 createBudget>0 的维度提交未覆盖的新模式 → ` +
      `(3) alembic_dimension_complete — 标记维度完成。` +
      `注意: evidenceHints.constraints.occupiedTriggers 中的 trigger 已被占用，请勿重复。`,
    meta: { tool: 'alembic_rescan', responseTimeMs },
  });
}

function presentRelevanceAudit(auditSummary: RelevanceAuditSummary) {
  return {
    totalAudited: auditSummary.totalAudited,
    healthy: auditSummary.healthy,
    watch: auditSummary.watch,
    decay: auditSummary.decay,
    severe: auditSummary.severe,
    dead: auditSummary.dead,
    proposalsCreated: auditSummary.proposalsCreated,
    immediateDeprecated: auditSummary.immediateDeprecated,
  };
}

function presentGuardSummary(guardAudit: GuardAudit | null) {
  return guardAudit
    ? {
        totalViolations: guardAudit.summary?.totalViolations || 0,
        errors: guardAudit.summary?.errors || 0,
        warnings: guardAudit.summary?.warnings || 0,
      }
    : null;
}
