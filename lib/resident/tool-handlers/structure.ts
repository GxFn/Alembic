/**
 * MCP Handlers — 项目结构 & 知识图谱
 * getTargets, getTargetFiles, getTargetMetadata, graphQuery, graphImpact, graphPath, graphStats
 */

import {
  ProjectContext,
  type ProjectContextEnvelope,
  type ProjectContextRef,
  type ProjectContextResult,
  type RepoContext,
  type SourceSliceContext,
} from '@alembic/core/project-context';
import { LanguageService } from '@alembic/core/shared';
import { resolveProjectRoot } from '@alembic/core/workspace';
import { envelope } from '../tool-schema/envelope.js';
import { buildToolUsageProblem } from '../tool-schema/problem.js';
import type { McpContext } from '../tool-schema/types.js';

// ─── Local Types ──────────────────────────────────────────

export interface TargetInfo {
  name: string;
  packageName?: string;
  packagePath?: string;
  type?: string;
  language?: string;
  framework?: string;
  path?: string;
  targetDir?: string;
  info?: { path?: string; sources?: string; dependencies?: unknown[] };
  metadata?: { dependencies?: unknown[] };
  [key: string]: unknown;
}

interface StructureArgs {
  targetName?: string;
  includeSummary?: boolean;
  includeContent?: boolean;
  contentMaxLines?: number;
  maxFiles?: number;
  [key: string]: unknown;
}

interface GraphArgs {
  nodeId?: string;
  nodeType?: string;
  direction?: string;
  relation?: string;
  fromId?: string;
  toId?: string;
  fromType?: string;
  toType?: string;
  maxDepth?: number;
  methodName?: string;
  [key: string]: unknown;
}

function readGraphArg(args: GraphArgs, key: 'nodeId' | 'fromId' | 'toId'): string | null {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Cross-field usage gate (MT3): the schema marks nodeId/fromId/toId optional
 * because requirements depend on `operation`; missing values answer with a
 * structured problem envelope instead of an opaque thrown Error.
 */
function graphArgProblemEnvelope(operation: string, missing: string[]) {
  return envelope({
    success: false,
    errorCode: 'GRAPH_ARG_MISSING',
    message: `operation=${operation} requires ${missing.join(' and ')}.`,
    problem: buildToolUsageProblem({
      code: 'GRAPH_ARG_MISSING',
      reasonCode: 'invalid-input',
      failingStep: 'graph-argument-validation',
      nextAction: `Provide ${missing.join(' and ')} and call alembic_graph again with operation=${operation}.`,
      retryable: true,
      fieldProblems: missing.map((field) => ({
        field,
        error: `${field} is required when operation=${operation}`,
      })),
    }),
    meta: { tool: 'alembic_graph' },
  });
}

/** 旧 discoverer 缓存已退休；保留测试入口为 no-op，避免测试工具依赖私有状态。 */
export function resetDiscovererCache() {
  /* no-op */
}

function _findTarget(targets: TargetInfo[], targetName: string): TargetInfo {
  const t = targets.find((t: TargetInfo) => t.name === targetName);
  if (!t) {
    throw new Error(`Target not found: ${targetName}`);
  }
  return t;
}

/** 推断语言 — 委托给 LanguageService */
function _inferLang(filename: string): string {
  return LanguageService.inferLang(filename);
}

/** 推断 Target 职责 */
function _inferTargetRole(targetName: string): string {
  const n = targetName.toLowerCase();
  if (/core|kit|shared|common|foundation|base/i.test(n)) {
    return 'core';
  }
  if (/service|manager|provider|repository|store/i.test(n)) {
    return 'service';
  }
  if (/ui|view|screen|component|widget/i.test(n)) {
    return 'ui';
  }
  if (/network|api|http|grpc|socket/i.test(n)) {
    return 'networking';
  }
  if (/storage|database|cache|persist|realm|coredata/i.test(n)) {
    return 'storage';
  }
  if (/test|spec|mock|stub|fake/i.test(n)) {
    return 'test';
  }
  if (/app|main|launch|entry/i.test(n)) {
    return 'app';
  }
  if (/router|coordinator|navigation/i.test(n)) {
    return 'routing';
  }
  if (/util|helper|extension|tool/i.test(n)) {
    return 'utility';
  }
  if (/model|entity|dto|schema/i.test(n)) {
    return 'model';
  }
  if (/auth|login|session|token/i.test(n)) {
    return 'auth';
  }
  if (/config|setting|environment|constant/i.test(n)) {
    return 'config';
  }
  return 'feature';
}

type ProjectContextRefCarrier = ProjectContextRef;

async function getResidentRepoContext(ctx: McpContext): Promise<RepoContext> {
  const projectRoot = resolveProjectRoot(ctx.container as { singletons?: Record<string, unknown> });
  const response = await ProjectContext.execute({
    kind: 'repo',
    payload: { includeMapSummary: true },
    project: {
      displayName: projectRoot.split(/[\\/]/).pop() || projectRoot,
      projectRoot,
      source: 'alembic-main-resident',
    },
    scope: { projectRoot },
  });
  if (isRepoContext(response.data)) {
    return response.data;
  }
  throw new Error(
    `ProjectContext repo context unavailable: ${projectContextUnavailableReason(response)}`
  );
}

async function getResidentSourceSlice(
  ctx: McpContext,
  filePath: string,
  contentMaxLines: number
): Promise<SourceSliceContext | null> {
  const projectRoot = resolveProjectRoot(ctx.container as { singletons?: Record<string, unknown> });
  const response = await ProjectContext.execute({
    kind: 'source-slice',
    payload: {
      endLine: contentMaxLines,
      filePath,
      includeText: true,
      startLine: 1,
    },
    project: {
      displayName: projectRoot.split(/[\\/]/).pop() || projectRoot,
      projectRoot,
      source: 'alembic-main-resident',
    },
    scope: { projectRoot },
  });
  return isSourceSliceContext(response.data) ? response.data : null;
}

function projectContextTargetToTargetInfo(target: RepoContext['targets'][number]): TargetInfo {
  return {
    name: target.name,
    type: target.kind ?? 'target',
    refs: target.refs,
    projectInformationSource: 'project-context',
  };
}

function isRepoContext(value: ProjectContextResult): value is RepoContext {
  return 'repo' in value && 'targets' in value && 'sourceRoots' in value;
}

function isSourceSliceContext(value: ProjectContextResult): value is SourceSliceContext {
  return 'file' in value && 'range' in value && 'nextRefs' in value;
}

function projectContextUnavailableReason(
  response: ProjectContextEnvelope<ProjectContextResult>
): string {
  const data = response.data;
  if ('available' in data && data.available === false) {
    return `${data.kind}: ${data.reason}`;
  }
  return response.errors?.map((error) => error.message).join('; ') || 'unexpected response';
}

function graphUnavailableEnvelope(message: string) {
  return envelope({
    success: false,
    errorCode: 'KNOWLEDGE_GRAPH_UNAVAILABLE',
    message,
    meta: { tool: 'alembic_graph', source: 'knowledgeGraphService' },
  });
}

function retiredCallContextEnvelope(methodName: string) {
  return envelope({
    success: false,
    errorCode: 'RETIRED_PROJECT_INFO_ROUTE',
    message:
      'alembic_call_context no longer reads CodeEntityGraph as a project-information provider. Use ProjectContext-backed file-flow, file-symbols, source-slice, or anchor-range requests for source context.',
    problem: buildToolUsageProblem({
      code: 'RETIRED_PROJECT_INFO_ROUTE',
      failingStep: 'call-context-project-information-route',
      nextAction:
        'Route method-level source questions through ProjectContext file-flow/file-symbols/source-slice/anchor-range instead of alembic_call_context.',
      reasonCode: 'capability-mismatch',
      retryable: false,
    }),
    meta: {
      methodName,
      projectInformationSource: 'project-context',
      retired: true,
      tool: 'alembic_call_context',
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: getTargets
// ═══════════════════════════════════════════════════════════

export async function getTargets(ctx: McpContext, args: StructureArgs = {}) {
  const repo = await getResidentRepoContext(ctx);
  const includeSummary = args.includeSummary !== false; // 默认 true
  const targets = repo.targets.map(projectContextTargetToTargetInfo);

  if (!includeSummary) {
    return envelope({ success: true, data: { targets }, meta: { tool: 'alembic_structure' } });
  }

  // 带摘要：每个 target 附加文件数、语言统计、推断职责
  const enriched: Array<{
    name: string;
    packageName: string | null;
    type: string;
    inferredRole: string;
    fileCount: number;
    languageStats: Record<string, number>;
  }> = [];
  const globalLangStats: Record<string, number> = {};
  let totalFiles = 0;

  for (const t of targets) {
    let fileCount = 0;
    const langStats: Record<string, number> = {};
    for (const ref of (t.refs as Array<{ scope?: { filePath?: string } }> | undefined) ?? []) {
      const filePath = ref.scope?.filePath;
      if (!filePath) {
        continue;
      }
      const lang = _inferLang(filePath);
      fileCount += 1;
      langStats[lang] = (langStats[lang] || 0) + 1;
      globalLangStats[lang] = (globalLangStats[lang] || 0) + 1;
    }
    totalFiles += fileCount;
    enriched.push({
      name: t.name,
      packageName: t.packageName || null,
      type: t.type || 'target',
      inferredRole: _inferTargetRole(t.name),
      fileCount,
      languageStats: langStats,
    });
  }

  return envelope({
    success: true,
    data: {
      targets: enriched,
      summary: { targetCount: targets.length, totalFiles, languageStats: globalLangStats },
    },
    meta: { tool: 'alembic_structure' },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: getTargetFiles
// ═══════════════════════════════════════════════════════════

export async function getTargetFiles(ctx: McpContext, args: StructureArgs) {
  if (!args.targetName) {
    throw new Error('targetName is required');
  }
  const repo = await getResidentRepoContext(ctx);
  const targets = repo.targets.map(projectContextTargetToTargetInfo);
  const target = _findTarget(targets, args.targetName);
  const rawFiles = ((target.refs as ProjectContextRefCarrier[] | undefined) ?? [])
    .map((ref) => ref.scope?.filePath)
    .filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0);

  const includeContent = args.includeContent || false;
  const contentMaxLines = args.contentMaxLines || 100;
  const maxFiles = args.maxFiles || 500;

  const files: Array<{
    name: string;
    path: string;
    relativePath: string;
    language: string;
    size: number;
    content?: string | null;
    totalLines?: number;
    truncated?: boolean;
  }> = [];
  for (const filePath of rawFiles) {
    if (files.length >= maxFiles) {
      break;
    }
    const name = filePath.split(/[\\/]/).pop() || filePath;
    const entry: {
      name: string;
      path: string;
      relativePath: string;
      language: string;
      size: number;
      content?: string | null;
      totalLines?: number;
      truncated?: boolean;
    } = {
      name,
      path: filePath,
      relativePath: filePath,
      language: _inferLang(name),
      size: 0,
    };
    if (includeContent) {
      const sourceSlice = await getResidentSourceSlice(ctx, filePath, contentMaxLines);
      entry.content = sourceSlice?.text ?? null;
      entry.totalLines = sourceSlice?.file.lineCount ?? 0;
      entry.truncated =
        typeof sourceSlice?.file.lineCount === 'number'
          ? sourceSlice.file.lineCount > contentMaxLines
          : false;
    }
    files.push(entry);
  }

  // 文件语言统计
  const langStats: Record<string, number> = {};
  for (const f of files) {
    langStats[f.language] = (langStats[f.language] || 0) + 1;
  }

  return envelope({
    success: true,
    data: {
      targetName: args.targetName,
      files,
      fileCount: files.length,
      totalAvailable: rawFiles.length,
      languageStats: langStats,
    },
    meta: { tool: 'alembic_structure' },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: getTargetMetadata
// ═══════════════════════════════════════════════════════════

export async function getTargetMetadata(ctx: McpContext, args: StructureArgs) {
  if (!args.targetName) {
    throw new Error('targetName is required');
  }
  const repo = await getResidentRepoContext(ctx);
  const targets = repo.targets.map(projectContextTargetToTargetInfo);
  const target = _findTarget(targets, args.targetName);

  // ── 基础元数据 ──
  const meta: Record<string, unknown> = {
    name: target.name,
    path: target.path || null,
    packageName: target.packageName || null,
    packagePath: target.packagePath || null,
    type: target.type || 'target',
    language: target.language || null,
    framework: target.framework || null,
    inferredRole: _inferTargetRole(target.name),
    targetDir: target.targetDir || null,
    sourcesPath: target.info?.path || null,
    sources: target.info?.sources || null,
    dependencies: target.info?.dependencies || target.metadata?.dependencies || [],
    projectInformationSource: 'project-context',
    refs: target.refs ?? [],
  };

  return envelope({ success: true, data: meta, meta: { tool: 'alembic_structure' } });
}

export async function graphQuery(ctx: McpContext, args: GraphArgs) {
  const graphService = ctx.container.get('knowledgeGraphService');
  if (!graphService) {
    return envelope({
      success: false,
      message: 'KnowledgeGraphService not available — knowledge_edges 表可能未初始化',
      meta: { tool: 'alembic_graph' },
    });
  }
  const nodeType = args.nodeType || 'recipe';
  const direction = args.direction || 'both';
  const nodeId = readGraphArg(args, 'nodeId');
  if (!nodeId) {
    return graphArgProblemEnvelope('query', ['nodeId']);
  }
  let data: unknown;
  try {
    if (args.relation) {
      data = await graphService.getRelated(nodeId, nodeType, args.relation);
    } else {
      data = await graphService.getEdges(nodeId, nodeType, direction);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message?.includes('no such table')) {
      return graphUnavailableEnvelope(
        'Knowledge graph edges are unavailable. Recipe relation fallback is retired for project-information routes.'
      );
    }
    throw err;
  }
  return envelope({ success: true, data, meta: { tool: 'alembic_graph' } });
}

export async function graphImpact(ctx: McpContext, args: GraphArgs) {
  const graphService = ctx.container.get('knowledgeGraphService');
  if (!graphService) {
    return envelope({
      success: false,
      message: 'KnowledgeGraphService not available — knowledge_edges 表可能未初始化',
      meta: { tool: 'alembic_graph' },
    });
  }
  const nodeType = args.nodeType || 'recipe';
  const nodeId = readGraphArg(args, 'nodeId');
  if (!nodeId) {
    return graphArgProblemEnvelope('impact', ['nodeId']);
  }
  let impacted: unknown[] = [];
  try {
    impacted = (await graphService.getImpactAnalysis(
      nodeId,
      nodeType,
      args.maxDepth ?? 3
    )) as unknown[];
  } catch (err: unknown) {
    if (err instanceof Error && err.message?.includes('no such table')) {
      return graphUnavailableEnvelope(
        'Knowledge graph impact analysis is unavailable. Recipe relation fallback is retired for project-information routes.'
      );
    }
    throw err;
  }
  return envelope({
    success: true,
    data: { nodeId, impactedCount: impacted.length, impacted },
    meta: { tool: 'alembic_graph' },
  });
}

// ─── graph_path — 路径查找 ─────────────────────────────────

export async function graphPath(ctx: McpContext, args: GraphArgs) {
  const fromId = readGraphArg(args, 'fromId');
  const toId = readGraphArg(args, 'toId');
  if (!fromId || !toId) {
    const missing = [...(fromId ? [] : ['fromId']), ...(toId ? [] : ['toId'])];
    return graphArgProblemEnvelope('path', missing);
  }
  const graphService = ctx.container.get('knowledgeGraphService');
  if (!graphService) {
    return envelope({
      success: false,
      message: 'KnowledgeGraphService not available',
      meta: { tool: 'alembic_graph' },
    });
  }
  const fromType = args.fromType || 'recipe';
  const toType = args.toType || 'recipe';
  const maxDepth = Math.min(Math.max(args.maxDepth ?? 5, 1), 10);
  let result: unknown;
  try {
    result = await graphService.findPath(fromId, fromType, toId, toType, maxDepth);
  } catch (err: unknown) {
    if (err instanceof Error && err.message?.includes('no such table')) {
      return graphUnavailableEnvelope(
        'Knowledge graph path search is unavailable. Recipe relation fallback is retired for project-information routes.'
      );
    }
    throw err;
  }
  return envelope({ success: true, data: result, meta: { tool: 'alembic_graph' } });
}

// ─── call_context — 调用链上下文 (Phase 5) ──────────────────

/**
 * alembic_call_context handler
 * 查询方法的调用者、被调用者、影响半径
 */
export async function callContext(ctx: McpContext, args: GraphArgs) {
  if (!args.methodName) {
    throw new Error('Missing required parameter: methodName');
  }

  return retiredCallContextEnvelope(args.methodName);
}

// ─── graph_stats — 图谱统计 ────────────────────────────────

export async function graphStats(ctx: McpContext) {
  const graphService = ctx.container.get('knowledgeGraphService');
  if (!graphService) {
    return envelope({
      success: false,
      message: 'KnowledgeGraphService not available',
      meta: { tool: 'alembic_graph' },
    });
  }
  let stats: unknown;
  try {
    stats = await graphService.getStats();
  } catch (err: unknown) {
    if (err instanceof Error && err.message?.includes('no such table')) {
      return envelope({
        success: true,
        data: {
          totalEdges: 0,
          byRelation: {},
          nodeTypes: [],
          note: 'knowledge_edges 表不存在，请运行数据库迁移',
        },
        meta: { tool: 'alembic_graph' },
      });
    }
    throw err;
  }
  return envelope({ success: true, data: stats, meta: { tool: 'alembic_graph' } });
}
