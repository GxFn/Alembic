/**
 * Snapshot Views — 面向消费者的衍生视图
 *
 * 核心理念：消费者不应直接操作 ProjectSnapshot 的每一个字段。
 * View Factory 提供针对特定消费场景的轻量级投影。
 *
 * @module types/snapshot-views
 */

import type { EvolutionPrescreen } from '../external/mcp/handlers/evolution-prescreen.js';
import type {
  AstSummary,
  BootstrapSessionShape,
  CallGraphResult,
  CodeEntityGraphResult,
  DependencyGraph,
  ExistingRecipeInfo,
  GuardAudit,
  LocalPackageModule,
  ProjectSnapshot,
  SnapshotFile,
  SnapshotTarget,
} from './project-snapshot.js';

// ─── H4: SessionCacheShape ───────────────────────────────────

/**
 * BootstrapSession.snapshotCache 的类型化形状。
 *
 * 替代之前 `Record<string, unknown>` 的擦除类型，
 * 消费端（dimension-complete-external、wiki-external）不再需要 `as` 手动转型。
 *
 */
export interface SessionCacheShape {
  readonly allFiles: readonly SnapshotFile[];
  readonly astProjectSummary: AstSummary | null;
  readonly codeEntityResult: CodeEntityGraphResult | null;
  readonly callGraphResult: CallGraphResult | null;
  readonly depGraphData: DependencyGraph | null;
  readonly guardAudit: GuardAudit | null;
  readonly langStats: Record<string, number>;
  readonly primaryLang: string;
  readonly targetsSummary: readonly SnapshotTarget[];
  readonly localPackageModules: readonly LocalPackageModule[];
}

// ─── 视图 0: PipelineFillView ────────────────────────────────

/** handler → dispatchPipelineFill → orchestrator 的统一入参 */
export interface PipelineFillView {
  /** 完整的项目快照（类型化、不可变） */
  readonly snapshot: ProjectSnapshot;
  /** 运行时上下文（DI container、logger 等）— 使用 Record 以兼容各种 McpContext 子类型 */
  readonly ctx: Record<string, unknown>;
  /** 当前 bootstrap session（可选，rescan 场景可能为 null） */
  readonly bootstrapSession: BootstrapSessionShape | null;
  /** handler 构建的 target→files 映射 */
  readonly targetFileMap: Record<string, unknown[]>;
  /** 项目根路径 */
  readonly projectRoot: string;
  /** 已有 recipes（rescan 去重用） */
  readonly existingRecipes?: ExistingRecipeInfo[];
  /** 进化前置过滤结果（rescan 模式，Phase A 已完成时提供） */
  readonly evolutionPrescreen?: EvolutionPrescreen;
}

// ─── 视图 1: toResponseData ──────────────────────────────────

/**
 * 从 ProjectSnapshot 提取通用的 MCP 响应数据摘要。
 *
 * 注意：这只包含通用字段。各 handler 需要的特有字段
 * （如 cleanup、bootstrapSession、rescan 等）仍然需要在 handler 中单独拼装。
 */
export function toResponseData(snapshot: ProjectSnapshot): Record<string, unknown> {
  return {
    filesScanned: snapshot.allFiles.length,
    targets: snapshot.targetsSummary,
    primaryLanguage: snapshot.language.primaryLang,
    languageStats: snapshot.language.stats,
    secondaryLanguages: snapshot.language.secondary,
    isMultiLang: snapshot.language.isMultiLang,
    astSummary: snapshot.ast
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
    guardSummary: snapshot.guardAudit
      ? {
          totalViolations: snapshot.guardAudit.summary?.totalViolations || 0,
          errors: snapshot.guardAudit.summary?.errors || 0,
          warnings: snapshot.guardAudit.summary?.warnings || 0,
        }
      : null,
    dependencyGraph: snapshot.dependencyGraph
      ? {
          nodes: (snapshot.dependencyGraph.nodes || []).map((n) => {
            if (typeof n === 'string') {
              return { id: n, label: n };
            }
            return { id: n.id, label: n.label };
          }),
          edges: snapshot.dependencyGraph.edges || [],
        }
      : null,
    dimensionCount: snapshot.activeDimensions.length,
    enhancementPacks:
      snapshot.enhancementPackInfo.length > 0
        ? {
            matched: snapshot.enhancementPackInfo,
            patterns: snapshot.enhancementPatterns,
            guardRules: snapshot.enhancementGuardRules.length,
          }
        : null,
    localPackageModules:
      snapshot.localPackageModules.length > 0 ? snapshot.localPackageModules : null,
    warnings: snapshot.warnings.length > 0 ? snapshot.warnings : undefined,
  };
}

// ─── 视图 2: toSessionCache ──────────────────────────────────

/**
 * 从 ProjectSnapshot 提取 BootstrapSession 的 phase cache 数据。
 *
 * 替代当前 handler 中手动拼装的 setSnapshotCache({...}) 调用。
 */
export function toSessionCache(snapshot: ProjectSnapshot): SessionCacheShape {
  return {
    allFiles: snapshot.allFiles,
    astProjectSummary: snapshot.ast,
    codeEntityResult: snapshot.codeEntityGraph,
    callGraphResult: snapshot.callGraph,
    depGraphData: snapshot.dependencyGraph,
    guardAudit: snapshot.guardAudit,
    langStats: snapshot.language.stats,
    primaryLang: snapshot.language.primaryLang,
    targetsSummary: snapshot.targetsSummary,
    localPackageModules: snapshot.localPackageModules,
  };
}
