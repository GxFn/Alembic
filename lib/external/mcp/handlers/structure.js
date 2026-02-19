/**
 * MCP Handlers — 项目结构 & 知识图谱
 * getTargets, getTargetFiles, getTargetMetadata, graphQuery, graphImpact, graphPath, graphStats
 */

import fs from 'node:fs';
import path from 'node:path';
import { envelope } from '../envelope.js';
import * as Paths from '../../../infrastructure/config/Paths.js';

// ─── SpmService 缓存 ─────────────────────────────────────
// 同一 projectRoot 在模块生命期内只初始化一次
let _spmCache = null;   // { projectRoot, spm, targets }

async function _getLoadedSpm() {
  const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();
  if (_spmCache && _spmCache.projectRoot === projectRoot) return _spmCache;
  const { SpmService } = await import('../../../service/spm/SpmService.js');
  const spm = new SpmService(projectRoot);
  await spm.load();
  const targets = await spm.listTargets() || [];
  _spmCache = { projectRoot, spm, targets };
  return _spmCache;
}

function _findTarget(targets, targetName) {
  const t = targets.find(t => t.name === targetName);
  if (!t) throw new Error(`Target not found: ${targetName}`);
  return t;
}

/** 推断语言 */
function _inferLang(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.swift': 'swift', '.m': 'objectivec', '.h': 'objectivec', '.mm': 'objectivec',
    '.c': 'c', '.cpp': 'cpp', '.js': 'javascript', '.ts': 'typescript',
    '.py': 'python', '.rb': 'ruby', '.java': 'java', '.kt': 'kotlin',
    '.go': 'go', '.rs': 'rust',
  };
  return map[ext] || 'unknown';
}

/** 推断 Target 职责 */
function _inferTargetRole(targetName) {
  const n = targetName.toLowerCase();
  if (/core|kit|shared|common|foundation|base/i.test(n)) return 'core';
  if (/service|manager|provider|repository|store/i.test(n)) return 'service';
  if (/ui|view|screen|component|widget/i.test(n)) return 'ui';
  if (/network|api|http|grpc|socket/i.test(n)) return 'networking';
  if (/storage|database|cache|persist|realm|coredata/i.test(n)) return 'storage';
  if (/test|spec|mock|stub|fake/i.test(n)) return 'test';
  if (/app|main|launch|entry/i.test(n)) return 'app';
  if (/router|coordinator|navigation/i.test(n)) return 'routing';
  if (/util|helper|extension|tool/i.test(n)) return 'utility';
  if (/model|entity|dto|schema/i.test(n)) return 'model';
  if (/auth|login|session|token/i.test(n)) return 'auth';
  if (/config|setting|environment|constant/i.test(n)) return 'config';
  return 'feature';
}

// ═══════════════════════════════════════════════════════════
// Handler: getTargets
// ═══════════════════════════════════════════════════════════

export async function getTargets(ctx, args = {}) {
  const { spm, targets } = await _getLoadedSpm();
  const includeSummary = args.includeSummary !== false; // 默认 true

  if (!includeSummary) {
    return envelope({ success: true, data: { targets }, meta: { tool: 'autosnippet_structure' } });
  }

  // 带摘要：每个 target 附加文件数、语言统计、推断职责
  const enriched = [];
  const globalLangStats = {};
  let totalFiles = 0;

  for (const t of targets) {
    let fileCount = 0;
    const langStats = {};
    try {
      const fileList = await spm.getTargetFiles(t);
      fileCount = fileList.length;
      for (const f of fileList) {
        const lang = _inferLang(f.name);
        langStats[lang] = (langStats[lang] || 0) + 1;
        globalLangStats[lang] = (globalLangStats[lang] || 0) + 1;
      }
    } catch { /* skip */ }
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

export async function getTargetFiles(ctx, args) {
  if (!args.targetName) throw new Error('targetName is required');
  const { spm, targets } = await _getLoadedSpm();
  const target = _findTarget(targets, args.targetName);

  // 使用 SpmService.getTargetFiles — 正确定位 Sources/<target>/ 目录
  const rawFiles = await spm.getTargetFiles(target);

  const includeContent = args.includeContent || false;
  const contentMaxLines = args.contentMaxLines || 100;
  const maxFiles = args.maxFiles || 500;

  const files = [];
  for (const f of rawFiles) {
    if (files.length >= maxFiles) break;
    const entry = {
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
      } catch { entry.content = null; entry.totalLines = 0; entry.truncated = false; }
    }
    files.push(entry);
  }

  // 文件语言统计
  const langStats = {};
  for (const f of files) { langStats[f.language] = (langStats[f.language] || 0) + 1; }

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

export async function getTargetMetadata(ctx, args) {
  if (!args.targetName) throw new Error('targetName is required');
  const { spm, targets, projectRoot } = await _getLoadedSpm();
  const target = _findTarget(targets, args.targetName);

  // ── 基础元数据 ──
  const meta = {
    name: target.name,
    packageName: target.packageName || null,
    packagePath: target.packagePath || null,
    type: target.type || 'target',
    inferredRole: _inferTargetRole(target.name),
    targetDir: target.targetDir || null,
    sourcesPath: target.info?.path || null,
    sources: target.info?.sources || null,
    dependencies: target.info?.dependencies || [],
  };

  // ── SPM 图谱 (spmmap.json) ──
  try {
    const knowledgeDir = Paths.getProjectKnowledgePath(projectRoot);
    const mapPath = path.join(knowledgeDir, 'AutoSnippet.spmmap.json');
    if (fs.existsSync(mapPath)) {
      const graph = JSON.parse(fs.readFileSync(mapPath, 'utf8'))?.graph || null;
      if (graph?.packages?.[target.packageName]) {
        const pkg = graph.packages[target.packageName];
        meta.packageDir = pkg.packageDir;
        meta.packageSwift = pkg.packageSwift;
        meta.packageTargets = pkg.targets || [];
      }
    }
  } catch { /* ignore */ }

  // ── 知识图谱关系 (knowledge_edges) ──
  try {
    const graphService = ctx.container?.get('knowledgeGraphService');
    if (graphService) {
      const edges = graphService.getEdges(target.name, 'module', 'both');
      meta.graphEdges = {
        outgoing: (edges.outgoing || []).map(e => ({ toId: e.toId, toType: e.toType, relation: e.relation })),
        incoming: (edges.incoming || []).map(e => ({ fromId: e.fromId, fromType: e.fromType, relation: e.relation })),
      };
    }
  } catch { /* knowledge_edges may not exist */ }

  return envelope({ success: true, data: meta, meta: { tool: 'autosnippet_structure' } });
}

export async function graphQuery(ctx, args) {
  const graphService = ctx.container.get('knowledgeGraphService');
  if (!graphService) {
    return envelope({ success: false, message: 'KnowledgeGraphService not available — knowledge_edges 表可能未初始化', meta: { tool: 'autosnippet_graph' } });
  }
  const nodeType = args.nodeType || 'recipe';
  const direction = args.direction || 'both';
  let data;
  try {
    if (args.relation) {
      data = graphService.getRelated(args.nodeId, nodeType, args.relation);
    } else {
      data = graphService.getEdges(args.nodeId, nodeType, direction);
    }
  } catch (err) {
    // knowledge_edges 表不存在时 graceful 降级到 relations 字段
    if (err.message?.includes('no such table')) {
      data = await _fallbackRelationsFromRecipe(ctx, args.nodeId, args.relation, direction);
      return envelope({ success: true, data, meta: { tool: 'autosnippet_graph', source: 'relations-fallback' } });
    }
    throw err;
  }
  return envelope({ success: true, data, meta: { tool: 'autosnippet_graph' } });
}

export async function graphImpact(ctx, args) {
  const graphService = ctx.container.get('knowledgeGraphService');
  if (!graphService) {
    return envelope({ success: false, message: 'KnowledgeGraphService not available — knowledge_edges 表可能未初始化', meta: { tool: 'autosnippet_graph' } });
  }
  const nodeType = args.nodeType || 'recipe';
  let impacted;
  try {
    impacted = graphService.getImpactAnalysis(args.nodeId, nodeType, args.maxDepth ?? 3);
  } catch (err) {
    // knowledge_edges 表不存在时 graceful 降级
    if (err.message?.includes('no such table')) {
      impacted = await _fallbackImpactFromRecipe(ctx, args.nodeId);
      return envelope({ success: true, data: { nodeId: args.nodeId, impactedCount: impacted.length, impacted, degraded: true, degradedReason: 'knowledge_edges 表不存在，仅从 relations 字段反查' }, meta: { tool: 'autosnippet_graph', source: 'relations-fallback' } });
    }
    throw err;
  }
  return envelope({ success: true, data: { nodeId: args.nodeId, impactedCount: impacted.length, impacted }, meta: { tool: 'autosnippet_graph' } });
}

/**
 * 降级：从 knowledge_entries.relations 提取关系（不依赖 knowledge_edges 表）
 */
async function _fallbackRelationsFromRecipe(ctx, nodeId, relation, direction) {
  try {
    const knowledgeService = ctx.container.get('knowledgeService');
    const entry = await knowledgeService.get(nodeId);
    if (!entry) return { outgoing: [], incoming: [] };

    const relJson = typeof entry.relations?.toJSON === 'function' ? entry.relations.toJSON() : (entry.relations || {});
    const outgoing = [];
    if (direction === 'both' || direction === 'out') {
      for (const [relType, targets] of Object.entries(relJson)) {
        if (relation && relType !== relation) continue;
        for (const t of (Array.isArray(targets) ? targets : [])) {
          outgoing.push({ fromId: nodeId, fromType: 'knowledge', toId: t.target || t.id || t, toType: 'knowledge', relation: relType });
        }
      }
    }

    // 反向查找：其他条目中 relations 包含当前 nodeId
    const incoming = [];
    if (direction === 'both' || direction === 'in') {
      const knowledgeRepo = ctx.container.get('knowledgeRepository');
      const reverseRows = knowledgeRepo.db.prepare(
        `SELECT id, relations FROM knowledge_entries WHERE relations LIKE ? AND id != ?`
      ).all(`%${nodeId}%`, nodeId);
      for (const row of reverseRows) {
        try {
          const rels = JSON.parse(row.relations || '{}');
          for (const [relType, targets] of Object.entries(rels)) {
            if (relation && relType !== relation) continue;
            for (const t of (Array.isArray(targets) ? targets : [])) {
              const targetId = t.target || t.id || t;
              if (targetId === nodeId) {
                incoming.push({ fromId: row.id, fromType: 'knowledge', toId: nodeId, toType: 'knowledge', relation: relType });
              }
            }
          }
        } catch { /* ignore parse error */ }
      }
    }

    return { outgoing, incoming };
  } catch { return { outgoing: [], incoming: [] }; }
}

/**
 * 降级：从 knowledge_entries.relations 反查受影响的条目
 */
async function _fallbackImpactFromRecipe(ctx, nodeId) {
  try {
    const knowledgeRepo = ctx.container.get('knowledgeRepository');
    const rows = knowledgeRepo.db.prepare(
      `SELECT id, title, relations FROM knowledge_entries WHERE relations LIKE ? AND id != ?`
    ).all(`%${nodeId}%`, nodeId);

    const impacted = [];
    for (const row of rows) {
      try {
        const rels = JSON.parse(row.relations || '{}');
        for (const [relType, targets] of Object.entries(rels)) {
          for (const t of (Array.isArray(targets) ? targets : [])) {
            if ((t.target || t.id || t) === nodeId) {
              impacted.push({ id: row.id, title: row.title, type: 'knowledge', relation: relType, depth: 1 });
            }
          }
        }
      } catch { /* ignore */ }
    }
    return impacted;
  } catch { return []; }
}

// ─── graph_path — 路径查找 ─────────────────────────────────

export async function graphPath(ctx, args) {
  if (!args.fromId || !args.toId) throw new Error('fromId and toId are required');
  const graphService = ctx.container.get('knowledgeGraphService');
  if (!graphService) {
    return envelope({ success: false, message: 'KnowledgeGraphService not available', meta: { tool: 'autosnippet_graph' } });
  }
  const fromType = args.fromType || 'recipe';
  const toType = args.toType || 'recipe';
  const maxDepth = Math.min(Math.max(args.maxDepth ?? 5, 1), 10);
  let result;
  try {
    result = graphService.findPath(args.fromId, fromType, args.toId, toType, maxDepth);
  } catch (err) {
    if (err.message?.includes('no such table')) {
      // 降级：用 relations 字段做单跳查找
      result = await _fallbackPathFromRecipe(ctx, args.fromId, args.toId);
      return envelope({ success: true, data: result, meta: { tool: 'autosnippet_graph', source: 'relations-fallback' } });
    }
    throw err;
  }
  return envelope({ success: true, data: result, meta: { tool: 'autosnippet_graph' } });
}

/**
 * 降级路径查找：只能发现 1-hop 直接关系
 */
async function _fallbackPathFromRecipe(ctx, fromId, toId) {
  try {
    const knowledgeService = ctx.container.get('knowledgeService');
    const entry = await knowledgeService.get(fromId);
    if (!entry) return { found: false, path: [], depth: -1 };

    const relJson = typeof entry.relations?.toJSON === 'function' ? entry.relations.toJSON() : (entry.relations || {});
    for (const [relType, targets] of Object.entries(relJson)) {
      for (const t of (Array.isArray(targets) ? targets : [])) {
        const targetId = t.target || t.id || t;
        if (targetId === toId) {
          return {
            found: true,
            path: [{ from: { id: fromId, type: 'knowledge' }, to: { id: toId, type: 'knowledge' }, relation: relType }],
            depth: 1,
          };
        }
      }
    }
    return { found: false, path: [], depth: -1 };
  } catch { return { found: false, path: [], depth: -1 }; }
}

// ─── graph_stats — 图谱统计 ────────────────────────────────

export async function graphStats(ctx) {
  const graphService = ctx.container.get('knowledgeGraphService');
  if (!graphService) {
    return envelope({ success: false, message: 'KnowledgeGraphService not available', meta: { tool: 'autosnippet_graph' } });
  }
  let stats;
  try {
    stats = graphService.getStats();
  } catch (err) {
    if (err.message?.includes('no such table')) {
      return envelope({ success: true, data: { totalEdges: 0, byRelation: {}, nodeTypes: [], note: 'knowledge_edges 表不存在，请运行数据库迁移' }, meta: { tool: 'autosnippet_graph' } });
    }
    throw err;
  }
  return envelope({ success: true, data: stats, meta: { tool: 'autosnippet_graph' } });
}
