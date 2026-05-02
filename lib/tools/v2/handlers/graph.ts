/**
 * @module tools/v2/handlers/graph
 *
 * 代码图谱查询工具 — 查询项目 AST 结构图谱和代码实体关系。
 * Actions: overview, query
 *
 * 统一了旧系统 7 个 AST 工具: get_class_info, get_class_hierarchy,
 * Actions: query (class/protocol/hierarchy/call-graph/category)
 */

import { estimateTokens, fail, ok, type ToolContext, type ToolResult } from '../types.js';

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (action) {
    case 'overview':
      return handleOverview(ctx);
    case 'query':
      return handleQuery(params, ctx);
    default:
      return fail(`Unknown graph action: ${action}`);
  }
}

/* ================================================================== */
/*  graph.overview                                                     */
/* ================================================================== */

async function handleOverview(ctx: ToolContext): Promise<ToolResult> {
  const graph = ctx.projectGraph as ProjectGraphLike | undefined;
  if (!graph) {
    return fail('Project graph not available');
  }

  try {
    const overview = graph.getOverview();
    if (!overview) {
      return ok({ message: 'Project graph is empty or not built yet' });
    }

    const formatted = formatOverview(overview);
    return ok(formatted, { tokensEstimate: estimateTokens(JSON.stringify(formatted)) });
  } catch (err: unknown) {
    return fail(`Overview failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatOverview(overview: GraphOverview): Record<string, unknown> {
  return {
    languages: overview.languages ?? [],
    totalFiles: overview.totalFiles ?? 0,
    totalDefinitions: overview.totalDefinitions ?? 0,
    summary: overview.summary ?? {},
    modules: overview.modules ?? [],
  };
}

/* ================================================================== */
/*  graph.query                                                        */
/* ================================================================== */

type QueryType =
  | 'class'
  | 'protocol'
  | 'hierarchy'
  | 'callers'
  | 'callees'
  | 'overrides'
  | 'extensions'
  | 'impact'
  | 'search';

const VALID_QUERY_TYPES = new Set<QueryType>([
  'class',
  'protocol',
  'hierarchy',
  'callers',
  'callees',
  'overrides',
  'extensions',
  'impact',
  'search',
]);

async function handleQuery(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const type = params.type as string;
  if (!type || !VALID_QUERY_TYPES.has(type as QueryType)) {
    return fail(`Invalid query type: ${type}. Valid: ${[...VALID_QUERY_TYPES].join(', ')}`);
  }

  const entity = params.entity as string | undefined;
  const limit = Math.min((params.limit as number) || 20, 100);

  const graph = ctx.projectGraph as ProjectGraphLike | undefined;
  const entityGraph = ctx.codeEntityGraph as CodeEntityGraphLike | undefined;

  if (!graph && !entityGraph) {
    return fail('Neither project graph nor code entity graph is available');
  }

  try {
    let result: unknown;

    switch (type as QueryType) {
      case 'class':
        if (!entity) {
          return fail('graph.query(class) requires entity');
        }
        result = graph?.getClassInfo?.(entity) ?? entityGraph?.queryEntity?.(entity, 'class');
        break;

      case 'protocol':
        if (!entity) {
          return fail('graph.query(protocol) requires entity');
        }
        result = graph?.getProtocolInfo?.(entity);
        break;

      case 'hierarchy':
        if (!entity) {
          return fail('graph.query(hierarchy) requires entity');
        }
        result = graph?.getClassHierarchy?.(entity);
        break;

      case 'callers':
        if (!entity) {
          return fail('graph.query(callers) requires entity');
        }
        result =
          graph?.getCallers?.(entity, limit) ??
          entityGraph?.queryCallGraph?.(entity, 'callers', limit);
        break;

      case 'callees':
        if (!entity) {
          return fail('graph.query(callees) requires entity');
        }
        result =
          graph?.getCallees?.(entity, limit) ??
          entityGraph?.queryCallGraph?.(entity, 'callees', limit);
        break;

      case 'overrides':
        if (!entity) {
          return fail('graph.query(overrides) requires entity');
        }
        result = graph?.getMethodOverrides?.(entity);
        break;

      case 'extensions':
        if (!entity) {
          return fail('graph.query(extensions) requires entity');
        }
        result = graph?.getCategoryMap?.(entity);
        break;

      case 'impact':
        if (!entity) {
          return fail('graph.query(impact) requires entity');
        }
        result = entityGraph?.impactAnalysis?.(entity, limit);
        break;

      case 'search':
        if (!entity) {
          return fail('graph.query(search) requires entity (search term)');
        }
        result = entityGraph?.search?.(entity, limit) ?? graph?.searchEntities?.(entity, limit);
        break;
    }

    if (result === undefined || result === null) {
      return ok({ type, entity, message: 'No results found' });
    }

    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return ok({ type, entity, result }, { tokensEstimate: estimateTokens(text) });
  } catch (err: unknown) {
    return fail(`Query(${type}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ================================================================== */
/*  DI Interface Types                                                 */
/* ================================================================== */

interface GraphOverview {
  languages?: string[];
  totalFiles?: number;
  totalDefinitions?: number;
  summary?: Record<string, unknown>;
  modules?: unknown[];
}

interface ProjectGraphLike {
  getOverview(): GraphOverview | null;
  getClassInfo?(name: string): unknown;
  getProtocolInfo?(name: string): unknown;
  getClassHierarchy?(name: string): unknown;
  getCallers?(name: string, limit: number): unknown;
  getCallees?(name: string, limit: number): unknown;
  getMethodOverrides?(name: string): unknown;
  getCategoryMap?(name: string): unknown;
  searchEntities?(query: string, limit: number): unknown;
}

interface CodeEntityGraphLike {
  queryEntity?(name: string, kind: string): unknown;
  queryCallGraph?(name: string, direction: string, limit: number): unknown;
  impactAnalysis?(name: string, limit: number): unknown;
  search?(query: string, limit: number): unknown;
}
