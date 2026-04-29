import { getInternalAgentRequiredFields } from '#domain/knowledge/FieldSpec.js';
import { envelope } from '#external/mcp/envelope.js';
import type { CleanupResult } from '#service/cleanup/CleanupService.js';
import type {
  DimensionDef,
  GuardAuditFileEntry,
  LanguageProfile,
  MissionBriefingResult,
  PhaseReport,
  ProjectSnapshot,
} from '#types/project-snapshot.js';
import { buildInternalNextSteps } from '#workflows/capabilities/execution/external-agent/mission-briefing/BootstrapDimensionText.js';
import { inferTargetRole } from '#workflows/capabilities/presentation/TargetClassifier.js';
import {
  buildProjectLanguageExtension,
  buildProjectTargetFileMap,
  summarizeProjectPanorama,
} from '#workflows/capabilities/project-intelligence/ProjectIntelligenceViews.js';

export type ColdStartTargetFileMap = Record<string, Array<Record<string, unknown>>>;

export function presentInternalColdStartEmptyProject({
  report,
  responseTimeMs,
}: {
  report: unknown;
  responseTimeMs: number;
}) {
  return envelope({
    success: true,
    data: { report, message: 'No source files found, nothing to bootstrap' },
    meta: { tool: 'alembic_bootstrap', responseTimeMs },
  });
}

export function presentExternalColdStartEmptyProject({
  responseTimeMs,
}: {
  responseTimeMs: number;
}) {
  return envelope({
    success: true,
    data: { message: 'No source files found. Nothing to bootstrap.' },
    meta: { tool: 'alembic_bootstrap', responseTimeMs },
  });
}

export function buildInternalColdStartTargetFileMap(
  snapshot: ProjectSnapshot,
  contentMaxLines: number
): ColdStartTargetFileMap {
  return buildProjectTargetFileMap(
    snapshot.allFiles as unknown as Array<{
      name: string;
      relativePath: string;
      targetName: string;
      content: string;
    }>,
    contentMaxLines,
    true
  ) as unknown as ColdStartTargetFileMap;
}

export function buildInternalColdStartReport({
  snapshot,
  maxFiles,
  skipGuard,
}: {
  snapshot: ProjectSnapshot;
  maxFiles: number;
  skipGuard: boolean;
}) {
  const typedPhaseReport: PhaseReport = snapshot.phaseReport ?? { phases: {}, startTime: 0 };
  const callGraph = typedPhaseReport.phases?.callGraph;
  const phaseCallGraphResult = callGraph?.result as Record<string, unknown> | undefined;

  return {
    phases: {
      fileCollection: {
        discoverer: snapshot.discoverer.id,
        discovererName: snapshot.discoverer.displayName,
        targets: snapshot.allTargets.length,
        files: snapshot.allFiles.length,
        truncated: snapshot.allFiles.length >= maxFiles,
      },
      incrementalEvaluation: undefined,
      astAnalysis: {
        classes: snapshot.ast?.classes?.length || 0,
        protocols: snapshot.ast?.protocols?.length || 0,
        categories: snapshot.ast?.categories?.length || 0,
        patterns: Object.keys(snapshot.ast?.patternStats || {}),
      },
      codeEntityGraph: typedPhaseReport.phases?.entityGraph || {
        entityCount: 0,
        edgeCount: 0,
        ms: 0,
      },
      callGraph: callGraph
        ? {
            entities: phaseCallGraphResult?.entitiesUpserted || 0,
            edges: phaseCallGraphResult?.edgesCreated || 0,
            ms: callGraph.ms || 0,
          }
        : { entities: 0, edges: 0, ms: 0 },
      dependencyGraph: { edgesWritten: snapshot.depEdgesWritten || 0 },
      enhancementPacks: {
        matched: snapshot.enhancementPackInfo,
        extraDimensions: snapshot.enhancementPackInfo.length,
        guardRules: snapshot.enhancementGuardRules?.length || 0,
        patterns: snapshot.enhancementPatterns?.length || 0,
      },
      guardAudit: {
        totalViolations: snapshot.guardAudit?.summary?.totalViolations || 0,
        filesWithViolations: ((snapshot.guardAudit?.files || []) as GuardAuditFileEntry[]).filter(
          (file) => file.violations.length > 0
        ).length,
        skipped: skipGuard,
        enhancementRulesInjected: snapshot.enhancementGuardRules?.length || 0,
      },
    },
    totals: {
      files: snapshot.allFiles.length,
      graphEdges: snapshot.depEdgesWritten || 0,
      guardViolations: snapshot.guardAudit?.summary?.totalViolations || 0,
    },
  };
}

export function presentInternalColdStartResponse({
  cleanupResult,
  snapshot,
  report,
  targetFileMap,
  dimensions,
  cachedSessionId,
  taskCount,
  bootstrapSession,
  responseTimeMs,
}: {
  cleanupResult: CleanupResult;
  snapshot: ProjectSnapshot;
  report: Record<string, unknown>;
  targetFileMap: ColdStartTargetFileMap;
  dimensions: DimensionDef[];
  cachedSessionId: string | null;
  taskCount: number;
  bootstrapSession: { toJSON(): Record<string, unknown> } | null;
  responseTimeMs: number;
}) {
  const responseData: Record<string, unknown> = {
    cleanup: presentFullResetCleanup(cleanupResult),
    report,
    targets: buildInternalColdStartTargets(snapshot, targetFileMap),
    filesByTarget: buildInternalColdStartFilesByTarget(targetFileMap),
    dependencyGraph: presentDependencyGraph(snapshot),
    languageStats: snapshot.language.stats,
    primaryLanguage: snapshot.language.primaryLang,
    secondaryLanguages: (snapshot.langProfile as LanguageProfile).secondary,
    isMultiLang: (snapshot.langProfile as LanguageProfile).isMultiLang,
    languageExtension: buildProjectLanguageExtension(snapshot.language.primaryLang),
    guardSummary: presentGuardSummary(snapshot),
    guardViolationFiles: presentGuardViolationFiles(snapshot),
    analysisFramework: {
      dimensions,
      skillWorthyDimensions: dimensions
        .filter((dimension) => dimension.skillWorthy)
        .map((d) => d.id),
      candidateOnlyDimensions: dimensions
        .filter((dimension) => !dimension.skillWorthy)
        .map((d) => d.id),
      candidateRequiredFields: getInternalAgentRequiredFields(),
      submissionTool: 'alembic_submit_knowledge_batch',
      expectedOutput: `候选知识（微观代码维度：code-pattern/best-practice/event-and-data-flow + 语言条件扫描）+ Project Skills（宏观叙事维度：code-standard/architecture/project-profile/agent-guidelines + 语言条件扫描）— 共 ${dimensions.length} 个维度`,
    },
    astContext: snapshot.astContext || null,
    astSummary: presentAstSummary(snapshot),
    enhancementPacks:
      snapshot.enhancementPackInfo.length > 0
        ? {
            matched: snapshot.enhancementPackInfo,
            patterns: snapshot.enhancementPatterns,
            guardRules: snapshot.enhancementGuardRules.length,
          }
        : null,
    codeEntityGraph: snapshot.codeEntityGraph
      ? {
          totalEntities: snapshot.codeEntityGraph.entityCount || 0,
          totalEdges: snapshot.codeEntityGraph.edgeCount || 0,
        }
      : null,
    callGraph: snapshot.callGraph
      ? {
          entitiesUpserted: snapshot.callGraph.entitiesUpserted || 0,
          edgesCreated: snapshot.callGraph.edgesCreated || 0,
        }
      : null,
    panorama: snapshot.panorama ? summarizeProjectPanorama(snapshot.panorama) : null,
    localPackageModules:
      snapshot.localPackageModules.length > 0 ? snapshot.localPackageModules : null,
    warnings: snapshot.warnings.length > 0 ? snapshot.warnings : undefined,
    nextSteps: buildInternalNextSteps(dimensions),
    bootstrapSession: bootstrapSession ? bootstrapSession.toJSON() : null,
    bootstrapCandidates: { created: 0, failed: 0, errors: [], status: 'filling' },
    autoSkills: { created: 0, failed: 0, skills: [], errors: [], status: 'filling' },
    message: `Bootstrap 骨架已创建: ${snapshot.allFiles.length} files, ${snapshot.allTargets.length} targets, ${taskCount} 个维度任务已排队，正在后台逐一填充...`,
  };

  if (cachedSessionId) {
    responseData.sessionId = cachedSessionId;
  }

  return envelope({
    success: true,
    data: responseData,
    meta: { tool: 'alembic_bootstrap', responseTimeMs },
  });
}

export function presentExternalColdStartResponse({
  cleanupResult,
  briefing,
  dimensionCount,
  responseTimeMs,
}: {
  cleanupResult: CleanupResult;
  briefing: MissionBriefingResult;
  dimensionCount: number;
  responseTimeMs: number;
}) {
  return envelope({
    success: true,
    data: {
      cleanup: presentFullResetCleanup(cleanupResult),
      ...briefing,
    },
    message:
      `⚠️ Bootstrap 仅完成第一步（项目扫描），你必须继续完成全部 ${dimensionCount} 个维度的分析。` +
      `请立即按 executionPlan.tiers 的顺序，对每个维度执行：` +
      `(1) 用你的代码阅读能力分析该维度相关文件 → ` +
      `(2) 调用 alembic_submit_knowledge_batch 提交候选知识（**每维度最少 3 条，目标 5 条**，不同关注点拆为独立候选） → ` +
      `(3) 调用 alembic_dimension_complete 标记维度完成。` +
      `不要停下来等待用户确认，直接开始第一个维度。`,
    meta: { tool: 'alembic_bootstrap', responseTimeMs },
  });
}

function presentFullResetCleanup(cleanupResult: CleanupResult) {
  return {
    deletedRecipes: cleanupResult.deletedFiles,
    clearedTables: cleanupResult.clearedTables.length,
    dbCleared: true,
    errors: cleanupResult.errors,
    trash: cleanupResult.trash ?? null,
    purgedTrash: cleanupResult.purgedTrash ?? null,
  };
}

function buildInternalColdStartTargets(
  snapshot: ProjectSnapshot,
  targetFileMap: ColdStartTargetFileMap
) {
  return snapshot.targetsSummary.length > 0
    ? snapshot.targetsSummary
    : snapshot.allTargets.map((target) => ({
        name: target.name,
        type: target.type || 'target',
        packageName: target.packageName || undefined,
        inferredRole: target.inferredRole || inferTargetRole(target.name),
        fileCount: (targetFileMap[target.name] || []).length,
      }));
}

function buildInternalColdStartFilesByTarget(targetFileMap: ColdStartTargetFileMap) {
  return Object.fromEntries(
    Object.entries(targetFileMap).map(([target, files]) => {
      const sorted = [...files].sort(
        (a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0)
      );
      const top = sorted.slice(0, 10);
      return [
        target,
        {
          totalFiles: files.length,
          topFiles: top.map(stripFileContent),
          ...(files.length > 10 ? { truncated: true } : {}),
        },
      ];
    })
  );
}

function presentDependencyGraph(snapshot: ProjectSnapshot) {
  return snapshot.dependencyGraph
    ? {
        nodes: (snapshot.dependencyGraph.nodes || []).map((node) => ({
          id: typeof node === 'string' ? node : node.id,
          label: typeof node === 'string' ? node : node.label,
        })),
        edges: snapshot.dependencyGraph.edges || [],
      }
    : null;
}

function presentGuardSummary(snapshot: ProjectSnapshot) {
  return snapshot.guardAudit
    ? {
        totalViolations: snapshot.guardAudit.summary?.totalViolations || 0,
        errors: snapshot.guardAudit.summary?.errors || 0,
        warnings: snapshot.guardAudit.summary?.warnings || 0,
      }
    : null;
}

function presentGuardViolationFiles(snapshot: ProjectSnapshot) {
  return snapshot.guardAudit
    ? ((snapshot.guardAudit.files || []) as GuardAuditFileEntry[])
        .filter((file) => file.violations.length > 0)
        .map((file) => ({
          filePath: file.filePath,
          violations: file.violations.map((violation) => ({
            ruleId: violation.ruleId,
            severity: violation.severity,
            message: violation.message,
            line: violation.line,
          })),
        }))
    : [];
}

function presentAstSummary(snapshot: ProjectSnapshot) {
  return snapshot.ast
    ? {
        classes: snapshot.ast.classes?.length || 0,
        protocols: snapshot.ast.protocols?.length || 0,
        categories: snapshot.ast.categories?.length || 0,
        patterns: Object.keys(snapshot.ast.patternStats || {}),
        metrics: snapshot.ast.projectMetrics
          ? {
              totalMethods: snapshot.ast.projectMetrics.totalMethods,
              avgMethodsPerClass: snapshot.ast.projectMetrics.avgMethodsPerClass,
              maxNestingDepth: snapshot.ast.projectMetrics.maxNestingDepth,
              complexMethods: snapshot.ast.projectMetrics.complexMethods?.length || 0,
              longMethods: snapshot.ast.projectMetrics.longMethods?.length || 0,
            }
          : null,
      }
    : null;
}

function stripFileContent(file: Record<string, unknown>) {
  const metadata = { ...file };
  delete metadata.content;
  return metadata;
}
