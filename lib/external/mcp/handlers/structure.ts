/**
 * MCP Handlers — 项目结构 & 知识图谱
 * getTargets, getTargetFiles, getTargetMetadata, graphQuery, graphImpact, graphPath, graphStats
 */

import fs from 'node:fs';
import path from 'node:path';
import * as Paths from '../../../infrastructure/config/Paths.js';
import { LanguageService } from '../../../shared/LanguageService.js';
import { envelope } from '../envelope.js';
import type { McpContext } from './types.js';

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

interface FileInfo {
  name: string;
  path: string;
  relativePath: string;
  size?: number;
  [key: string]: unknown;
}

interface DiscovererLike {
  load(projectRoot: string): Promise<void>;
  listTargets(): Promise<TargetInfo[]>;
  getTargetFiles(target: TargetInfo): Promise<FileInfo[]>;
  getDependencyGraph?(): unknown;
}

interface DiscovererCache {
  projectRoot: string;
  discoverer: DiscovererLike;
  targets: TargetInfo[];
}

interface GraphEdge {
  fromId?: string;
  toId?: string;
  fromType?: string;
  toType?: string;
  relation?: string;
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

// ─── Discoverer 缓存 ─────────────────────────────────────
// 同一 projectRoot 在模块生命期内只初始化一次
let _discovererCache: DiscovererCache | null = null; // { projectRoot, discoverer, targets }

async function _getLoadedDiscoverer() {
  const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();
  if (_discovererCache && _discovererCache.projectRoot === projectRoot) {
    return _discovererCache;
  }

  // 优先使用 DiscovererRegistry（多语言统一接口）
  const { getDiscovererRegistry } = await import('../../../core/discovery/index.js');
  const registry = getDiscovererRegistry();
  const discoverer = await registry.detect(projectRoot);
  await discoverer.load(projectRoot);
  const targets = (await discoverer.listTargets()) || [];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- structural duck-typing across module boundary
  _discovererCache = {
    projectRoot,
    discoverer: discoverer as unknown as DiscovererLike,
    targets: targets as unknown as TargetInfo[],
  };
  return _discovererCache;
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

// ═══════════════════════════════════════════════════════════
// Handler: getTargets
// ═══════════════════════════════════════════════════════════

export async function getTargets(ctx: McpContext, args: StructureArgs = {}) {
  const { discoverer, targets } = await _getLoadedDiscoverer();
  const includeSummary = args.includeSummary !== false; // 默认 true

  if (!includeSummary) {
    return envelope({ success: true, data: { targets }, meta: { tool: 'autosnippet_structure' } });
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
    try {
      const fileList = await discoverer.getTargetFiles(t);
      fileCount = fileList.length;
      for (const f of fileList) {
        const lang = _inferLang(f.name);
        langStats[lang] = (langStats[lang] || 0) + 1;
        globalLangStats[lang] = (globalLangStats[lang] || 0) + 1;
      }
    } catch {
      /* skip */
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
    meta: { tool: 'autosnippet_structure' },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: getTargetFiles
// ═══════════════════════════════════════════════════════════

export async function getTargetFiles(ctx: McpContext, args: StructureArgs) {
  if (!args.targetName) {
    throw new Error('targetName is required');
  }
  const { discoverer, targets } = await _getLoadedDiscoverer();
  const target = _findTarget(targets, args.targetName);

  // 使用 Discoverer.getTargetFiles — 统一接口定位源文件
  const rawFiles = await discoverer.getTargetFiles(target);

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
  for (const f of rawFiles) {
    if (files.length >= maxFiles) {
      break;
    }
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
      name: f.name,
      path: f.path,
      relativePath: f.relativePath,
      language: _inferLang(f.name),
      size: f.size || 0,
    };
    if (includeContent) {
      try {
        const raw = fs.readFileSync(f.path, 'utf8');
        const lines = raw.split('\n');
        entry.content = lines.slice(0, contentMaxLines).join('\n');
        entry.totalLines = lines.length;
        entry.truncated = lines.length > contentMaxLines;
      } catch {
        entry.content = null;
        entry.totalLines = 0;
        entry.truncated = false;
      }
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
    meta: { tool: 'autosnippet_structure' },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: getTargetMetadata
// ═══════════════════════════════════════════════════════════

export async function getTargetMetadata(ctx: McpContext, args: StructureArgs) {
  if (!args.targetName) {
    throw new Error('targetName is required');
  }
  const { targets } = await _getLoadedDiscoverer();
  const target = _findTarget(targets, args.targetName);
  const projectRoot = _discovererCache!.projectRoot;

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
  };

  // ── SPM 图谱 (spmmap.json) ──
  try {
    const knowledgeDir = Paths.getProjectKnowledgePath(projectRoot);
    const mapPath = path.join(knowledgeDir, 'AutoSnippet.spmmap.json');
    if (fs.existsSync(mapPath)) {
      const graph = JSON.parse(fs.readFileSync(mapPath, 'utf8'))?.graph || null;
      if (target.packageName && graph?.packages?.[target.packageName]) {
        const pkg = graph.packages[target.packageName];
        meta.packageDir = pkg.packageDir;
        meta.packageSwift = pkg.packageSwift;
        meta.packageTargets = pkg.targets || [];
      }
    }
  } catch {
    /* ignore */
  }

  // ── 知识图谱关系 (knowledge_edges) ──
  try {
    const graphService = ctx.container?.get('knowledgeGraphService');
    if (graphService) {
      const edges = graphService.getEdges(target.name, 'module', 'both');
      meta.graphEdges = {
        outgoing: (edges.outgoing || []).map((e: GraphEdge) => ({
          toId: e.toId,
          toType: e.toType,
          relation: e.relation,
        })),
        incoming: (edges.incoming || []).map((e: GraphEdge) => ({
          fromId: e.fromId,
          fromType: e.fromType,
          relation: e.relation,
        })),
      };
    }
  } catch {
    /* knowledge_edges may not exist */
  }

  return envelope({ success: true, data: meta, meta: { tool: 'autosnippet_structure' } });
}

export async function graphQuery(ctx: McpContext, args: GraphArgs) {
  const graphService = ctx.container.get('knowledgeGraphService');
  if (!graphService) {
    return envelope({
      success: false,
      message: 'KnowledgeGraphService not available — knowledge_edges 表可能未初始化',
      meta: { tool: 'autosnippet_graph' },
    });
  }
  const nodeType = args.nodeType || 'recipe';
  const direction = args.direction || 'both';
  let data: any;
  try {
    if (args.relation) {
      data = graphService.getRelated(args.nodeId!, nodeType, args.relation);
    } else {
      data = graphService.getEdges(args.nodeId!, nodeType, direction);
    }
  } catch (err: unknown) {
    // knowledge_edges 表不存在时 graceful 降级到 relations 字段
    if (err instanceof Error && err.message?.includes('no such table')) {
      data = await _fallbackRelationsFromRecipe(ctx, args.nodeId!, args.relation, direction);
      return envelope({
        success: true,
        data,
        meta: { tool: 'autosnippet_graph', source: 'relations-fallback' },
      });
    }
    throw err;
  }
  return envelope({ success: true, data, meta: { tool: 'autosnippet_graph' } });
}

export async function graphImpact(ctx: McpContext, args: GraphArgs) {
  const graphService = ctx.container.get('knowledgeGraphService');
  if (!graphService) {
    return envelope({
      success: false,
      message: 'KnowledgeGraphService not available — knowledge_edges 表可能未初始化',
      meta: { tool: 'autosnippet_graph' },
    });
  }
  const nodeType = args.nodeType || 'recipe';
  let impacted: any;
  try {
    impacted = graphService.getImpactAnalysis(args.nodeId!, nodeType, args.maxDepth ?? 3);
  } catch (err: unknown) {
    // knowledge_edges 表不存在时 graceful 降级
    if (err instanceof Error && err.message?.includes('no such table')) {
      impacted = await _fallbackImpactFromRecipe(ctx, args.nodeId!);
      return envelope({
        success: true,
        data: {
          nodeId: args.nodeId,
          impactedCount: impacted.length,
          impacted,
          degraded: true,
          degradedReason: 'knowledge_edges 表不存在，仅从 relations 字段反查',
        },
        meta: { tool: 'autosnippet_graph', source: 'relations-fallback' },
      });
    }
    throw err;
  }
  return envelope({
    success: true,
    data: { nodeId: args.nodeId, impactedCount: impacted.length, impacted },
    meta: { tool: 'autosnippet_graph' },
  });
}

/**
 * 降级：从 knowledge_entries.relations 提取关系（不依赖 knowledge_edges 表）
 */
async function _fallbackRelationsFromRecipe(
  ctx: McpContext,
  nodeId: string,
  relation: string | undefined,
  direction: string
) {
  try {
    const knowledgeService = ctx.container.get('knowledgeService');
    const entry = await knowledgeService.get(nodeId);
    if (!entry) {
      return { outgoing: [], incoming: [] };
    }

    const relJson =
      typeof entry.relations?.toJSON === 'function'
        ? entry.relations.toJSON()
        : entry.relations || {};
    const outgoing: {
      fromId: string;
      fromType: string;
      toId: string;
      toType: string;
      relation: string;
    }[] = [];
    if (direction === 'both' || direction === 'out') {
      for (const [relType, targets] of Object.entries(relJson)) {
        if (relation && relType !== relation) {
          continue;
        }
        for (const t of Array.isArray(targets) ? targets : []) {
          outgoing.push({
            fromId: nodeId,
            fromType: 'knowledge',
            toId: t.target || t.id || t,
            toType: 'knowledge',
            relation: relType,
          });
        }
      }
    }

    // 反向查找：其他条目中 relations 包含当前 nodeId
    const incoming: {
      fromId: string;
      fromType: string;
      toId: string;
      toType: string;
      relation: string;
    }[] = [];
    if (direction === 'both' || direction === 'in') {
      const knowledgeRepo = ctx.container.get('knowledgeRepository');
      const reverseRows = knowledgeRepo.db
        .prepare(`SELECT id, relations FROM knowledge_entries WHERE relations LIKE ? AND id != ?`)
        .all(`%${nodeId}%`, nodeId);
      for (const row of reverseRows) {
        try {
          const rels = JSON.parse(row.relations || '{}');
          for (const [relType, targets] of Object.entries(rels)) {
            if (relation && relType !== relation) {
              continue;
            }
            for (const t of Array.isArray(targets) ? targets : []) {
              const targetId = t.target || t.id || t;
              if (targetId === nodeId) {
                incoming.push({
                  fromId: row.id,
                  fromType: 'knowledge',
                  toId: nodeId,
                  toType: 'knowledge',
                  relation: relType,
                });
              }
            }
          }
        } catch {
          /* ignore parse error */
        }
      }
    }

    return { outgoing, incoming };
  } catch {
    return { outgoing: [], incoming: [] };
  }
}

/**
 * 降级：从 knowledge_entries.relations 反查受影响的条目
 */
async function _fallbackImpactFromRecipe(ctx: McpContext, nodeId: string) {
  try {
    const knowledgeRepo = ctx.container.get('knowledgeRepository');
    const rows = knowledgeRepo.db
      .prepare(
        `SELECT id, title, relations FROM knowledge_entries WHERE relations LIKE ? AND id != ?`
      )
      .all(`%${nodeId}%`, nodeId);

    const impacted: { id: string; title: string; type: string; relation: string; depth: number }[] =
      [];
    for (const row of rows) {
      try {
        const rels = JSON.parse(row.relations || '{}');
        for (const [relType, targets] of Object.entries(rels)) {
          for (const t of Array.isArray(targets) ? targets : []) {
            if ((t.target || t.id || t) === nodeId) {
              impacted.push({
                id: row.id,
                title: row.title,
                type: 'knowledge',
                relation: relType,
                depth: 1,
              });
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    return impacted;
  } catch {
    return [];
  }
}

// ─── graph_path — 路径查找 ─────────────────────────────────

export async function graphPath(ctx: McpContext, args: GraphArgs) {
  if (!args.fromId || !args.toId) {
    throw new Error('fromId and toId are required');
  }
  const graphService = ctx.container.get('knowledgeGraphService');
  if (!graphService) {
    return envelope({
      success: false,
      message: 'KnowledgeGraphService not available',
      meta: { tool: 'autosnippet_graph' },
    });
  }
  const fromType = args.fromType || 'recipe';
  const toType = args.toType || 'recipe';
  const maxDepth = Math.min(Math.max(args.maxDepth ?? 5, 1), 10);
  let result: any;
  try {
    result = graphService.findPath(args.fromId, fromType, args.toId, toType, maxDepth);
  } catch (err: unknown) {
    if (err instanceof Error && err.message?.includes('no such table')) {
      // 降级：用 relations 字段做单跳查找
      result = await _fallbackPathFromRecipe(ctx, args.fromId, args.toId);
      return envelope({
        success: true,
        data: result,
        meta: { tool: 'autosnippet_graph', source: 'relations-fallback' },
      });
    }
    throw err;
  }
  return envelope({ success: true, data: result, meta: { tool: 'autosnippet_graph' } });
}

/**
 * 降级路径查找：只能发现 1-hop 直接关系
 */
async function _fallbackPathFromRecipe(ctx: McpContext, fromId: string, toId: string) {
  try {
    const knowledgeService = ctx.container.get('knowledgeService');
    const entry = await knowledgeService.get(fromId);
    if (!entry) {
      return { found: false, path: [], depth: -1 };
    }

    const relJson =
      typeof entry.relations?.toJSON === 'function'
        ? entry.relations.toJSON()
        : entry.relations || {};
    for (const [relType, targets] of Object.entries(relJson)) {
      for (const t of Array.isArray(targets) ? targets : []) {
        const targetId = t.target || t.id || t;
        if (targetId === toId) {
          return {
            found: true,
            path: [
              {
                from: { id: fromId, type: 'knowledge' },
                to: { id: toId, type: 'knowledge' },
                relation: relType,
              },
            ],
            depth: 1,
          };
        }
      }
    }
    return { found: false, path: [], depth: -1 };
  } catch {
    return { found: false, path: [], depth: -1 };
  }
}

// ─── call_context — 调用链上下文 (Phase 5) ──────────────────

/**
 * autosnippet_call_context handler
 * 查询方法的调用者、被调用者、影响半径
 */
export async function callContext(ctx: McpContext, args: GraphArgs) {
  if (!args.methodName) {
    throw new Error('Missing required parameter: methodName');
  }

  const ceg = ctx.container.get('codeEntityGraph');
  if (!ceg) {
    return envelope({
      success: false,
      message: 'CodeEntityGraph not available — 请先运行 bootstrap',
      meta: { tool: 'autosnippet_call_context' },
    });
  }

  const direction = args.direction || 'both';
  const maxDepth = Math.min(Math.max(args.maxDepth ?? 2, 1), 5);
  const result: Record<string, unknown> = {};

  try {
    if (direction === 'callers' || direction === 'both') {
      result.callers = ceg.getCallers(args.methodName, maxDepth);
    }
    if (direction === 'callees' || direction === 'both') {
      result.callees = ceg.getCallees(args.methodName, maxDepth);
    }
    if (direction === 'impact') {
      result.impact = ceg.getCallImpactRadius(args.methodName);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message?.includes('no such table')) {
      return envelope({
        success: true,
        data: {
          methodName: args.methodName,
          callers: [],
          callees: [],
          note: 'knowledge_edges 表不存在，请运行 bootstrap 后再查询',
        },
        meta: { tool: 'autosnippet_call_context' },
      });
    }
    throw err;
  }

  return envelope({
    success: true,
    data: {
      methodName: args.methodName,
      direction,
      maxDepth,
      ...result,
    },
    meta: { tool: 'autosnippet_call_context' },
  });
}

// ─── graph_stats — 图谱统计 ────────────────────────────────

export async function graphStats(ctx: McpContext) {
  const graphService = ctx.container.get('knowledgeGraphService');
  if (!graphService) {
    return envelope({
      success: false,
      message: 'KnowledgeGraphService not available',
      meta: { tool: 'autosnippet_graph' },
    });
  }
  let stats: any;
  try {
    stats = graphService.getStats();
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
        meta: { tool: 'autosnippet_graph' },
      });
    }
    throw err;
  }
  return envelope({ success: true, data: stats, meta: { tool: 'autosnippet_graph' } });
}
