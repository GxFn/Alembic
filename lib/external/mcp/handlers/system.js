/**
 * MCP Handlers — 系统类
 * health, capabilities
 */

import fs from 'node:fs';
import path from 'node:path';
import { envelope } from '../envelope.js';
import { TOOLS, TOOL_GATEWAY_MAP } from '../tools.js';

export async function health(ctx) {
  const checks = { database: false, gateway: false, vectorStore: false };
  const issues = [];
  let knowledgeBase = null;

  // 1) AI 配置
  let aiInfo = { provider: 'unknown', hasKey: false };
  try {
    const { getAiConfigInfo } = await import('../../../external/ai/AiFactory.js');
    aiInfo = getAiConfigInfo();
  } catch (e) {
    issues.push(`ai: ${e.message}`);
  }

  // 2) Database 连通性 + 知识库统计
  try {
    const db = ctx.container.get('database');
    if (db) {
      db.prepare('SELECT 1').get();
      checks.database = true;
      // 知识库统计（轻量聚合查询）
      try {
        // V3: knowledge_entries 统一表（lifecycle 替代 status）
        const rStats = db.prepare(`
          SELECT COUNT(*) as total,
            SUM(CASE WHEN lifecycle='active' THEN 1 ELSE 0 END) as active,
            SUM(CASE WHEN kind='rule' THEN 1 ELSE 0 END) as rules,
            SUM(CASE WHEN kind='pattern' THEN 1 ELSE 0 END) as patterns,
            SUM(CASE WHEN kind='fact' THEN 1 ELSE 0 END) as facts
          FROM knowledge_entries
        `).get();
        const cPending = db.prepare(`
          SELECT COUNT(*) as total,
            SUM(CASE WHEN lifecycle='pending' THEN 1 ELSE 0 END) as pending
          FROM knowledge_entries
        `).get();
        knowledgeBase = {
          recipes: { total: rStats.total, active: rStats.active, rules: rStats.rules, patterns: rStats.patterns, facts: rStats.facts },
          candidates: { total: cPending.total, pending: cPending.pending },
        };
      } catch { /* 统计查询失败不影响 health */ }
    }
  } catch (e) {
    issues.push(`database: ${e.message}`);
  }

  // 3) Gateway 可用性
  try {
    const gw = ctx.container.get('gateway');
    checks.gateway = !!gw;
  } catch (e) {
    issues.push(`gateway: ${e.message}`);
  }

  // 4) VectorStore 可用性
  try {
    const vs = ctx.container.get('vectorStore');
    if (vs) {
      const vsStats = typeof vs.getStats === 'function' ? await vs.getStats() : null;
      checks.vectorStore = true;
      if (vsStats) {
        knowledgeBase = knowledgeBase || {};
        knowledgeBase.vectorIndex = { documentCount: vsStats.documentCount ?? vsStats.totalDocuments ?? 0 };
      }
    }
  } catch (e) {
    issues.push(`vectorStore: ${e.message}`);
  }

  // 5) 版本号（从 AutoSnippet 包自身的 package.json 读取，不依赖 cwd）
  if (!_pkgVersion) {
    try {
      const __dir = path.dirname(new URL(import.meta.url).pathname);
      const pkgPath = path.resolve(__dir, '../../../../package.json');
      _pkgVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '2.0.0';
    } catch {
      _pkgVersion = '2.0.0';
    }
  }

  // 6) 综合状态
  const allCritical = checks.database; // DB 是唯一硬性依赖
  const status = allCritical ? 'ok' : 'degraded';

  return envelope({
    success: true,
    data: {
      status,
      version: _pkgVersion,
      uptime: Math.floor((Date.now() - ctx.startedAt) / 1000),
      projectRoot: process.env.ASD_PROJECT_DIR || process.cwd(),
      ai: aiInfo,
      checks,
      services: ctx.container.getServiceNames(),
      knowledgeBase,
      ...(issues.length ? { issues } : {}),
    },
    meta: { tool: 'autosnippet_health' },
  });
}

let _pkgVersion = null;

export function capabilities() {
  // 工具分类映射
  const CATEGORY_MAP = {
    autosnippet_health: 'system',
    autosnippet_capabilities: 'system',
    autosnippet_search: 'search',
    autosnippet_context_search: 'search',
    autosnippet_keyword_search: 'search',
    autosnippet_semantic_search: 'search',
    autosnippet_list_rules: 'browse',
    autosnippet_list_patterns: 'browse',
    autosnippet_list_facts: 'browse',
    autosnippet_list_recipes: 'browse',
    autosnippet_get_recipe: 'browse',
    autosnippet_recipe_insights: 'browse',
    autosnippet_graph_query: 'graph',
    autosnippet_graph_impact: 'graph',
    autosnippet_get_targets: 'structure',
    autosnippet_get_target_files: 'structure',
    autosnippet_get_target_metadata: 'structure',
    autosnippet_validate_candidate: 'validate',
    autosnippet_check_duplicate: 'validate',
    autosnippet_guard_check: 'guard',
    autosnippet_guard_audit_files: 'guard',
    autosnippet_scan_project: 'scan',
    autosnippet_enrich_candidates: 'enrich',
    autosnippet_confirm_usage: 'telemetry',
    autosnippet_compliance_report: 'telemetry',
  };

  const tools = TOOLS.map(t => {
    const props = t.inputSchema.properties || {};
    const requiredSet = new Set(t.inputSchema.required || []);
    const params = Object.entries(props).map(([key, schema]) => ({
      name: key,
      type: schema.type || 'any',
      required: requiredSet.has(key),
      ...(schema.default !== undefined ? { default: schema.default } : {}),
      ...(schema.enum ? { enum: schema.enum } : {}),
      ...(schema.description ? { description: schema.description } : {}),
    }));
    const gatewayInfo = TOOL_GATEWAY_MAP[t.name];
    return {
      name: t.name,
      description: t.description,
      category: CATEGORY_MAP[t.name] || 'other',
      gatewayGated: !!gatewayInfo,
      params,
    };
  });

  // 按分类分组
  const byCategory = {};
  for (const t of tools) {
    (byCategory[t.category] || (byCategory[t.category] = [])).push(t.name);
  }

  return envelope({
    success: true,
    data: {
      count: tools.length,
      categoryGuide: {
        system: '系统状态与能力发现',
        search: '知识库搜索 — search(auto 融合推荐) / keyword_search(SQL LIKE 精确) / semantic_search(向量语义) / context_search(Agent+漏斗+会话)',
        browse: '知识浏览（list / get / insights）',
        graph: '知识图谱关系查询与影响分析',
        structure: 'SPM Target 结构发现',
        validate: '候选预校验与去重检测',
        submit: '候选提交（写操作，Gateway gated）',
        guard: '代码 Guard 规则审计（写操作，Gateway gated）',
        scan: '全项目扫描（文件收集 + Guard 检查）',
        enrich: 'AI 语义字段补全（写操作，Gateway gated）',
        telemetry: '使用遥测与合规',
      },
      byCategory,
      tools,
      workflows: [
        { name: '知识查询', steps: ['search（推荐首选，auto mode 融合）', 'get_recipe', 'confirm_usage'], tips: '精确匹配用 keyword_search，需意图+会话上下文用 context_search' },
        { name: '单条知识提交', steps: ['check_duplicate', 'validate_candidate', 'submit_knowledge'] },
        { name: '批量 Target 扫描', steps: ['get_targets', 'get_target_files', '(Agent 分析)', 'submit_knowledge_batch'] },
        { name: '全项目深度扫描', steps: ['scan_project', '(Agent 语义分析)', 'submit_knowledge_batch', 'enrich_candidates'] },
        { name: '候选就绪检查', steps: ['enrich_candidates', 'validate_candidate', 'check_duplicate'] },
      ],
    },
    meta: { tool: 'autosnippet_capabilities' },
  });
}
