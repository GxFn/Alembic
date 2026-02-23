/**
 * MCP Handlers — 系统类
 * health, capabilities
 */

import fs from 'node:fs';
import path from 'node:path';
import { envelope } from '../envelope.js';
import { TIER_ORDER, TOOL_GATEWAY_MAP, TOOLS } from '../tools.js';

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
        const rStats = db
          .prepare(`
          SELECT COUNT(*) as total,
            SUM(CASE WHEN lifecycle='active' THEN 1 ELSE 0 END) as active,
            SUM(CASE WHEN kind='rule' THEN 1 ELSE 0 END) as rules,
            SUM(CASE WHEN kind='pattern' THEN 1 ELSE 0 END) as patterns,
            SUM(CASE WHEN kind='fact' THEN 1 ELSE 0 END) as facts
          FROM knowledge_entries
        `)
          .get();
        const cPending = db
          .prepare(`
          SELECT COUNT(*) as total,
            SUM(CASE WHEN lifecycle='pending' THEN 1 ELSE 0 END) as pending
          FROM knowledge_entries
        `)
          .get();
        knowledgeBase = {
          recipes: {
            total: rStats.total,
            active: rStats.active,
            rules: rStats.rules,
            patterns: rStats.patterns,
            facts: rStats.facts,
          },
          candidates: { total: cPending.total, pending: cPending.pending },
        };
      } catch {
        /* 统计查询失败不影响 health */
      }
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
        knowledgeBase.vectorIndex = {
          documentCount: vsStats.documentCount ?? vsStats.totalDocuments ?? 0,
        };
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

  // 如果 DB 不可用但冷启动仍可执行，附加提示避免 Agent 浪费时间修复 DB
  const actionHints = [];
  if (!checks.database) {
    actionHints.push(
      'DB 不可用不影响冷启动：autosnippet_bootstrap 不依赖数据库（纯文件系统分析），可直接调用。DB 会在首次 submit_knowledge 时自动重试初始化。'
    );
  }
  if (!knowledgeBase || knowledgeBase.recipes.total === 0) {
    actionHints.push(
      '知识库为空，建议执行冷启动：(1) 调用 autosnippet_bootstrap 获取 Mission Briefing → (2) 按维度分析代码并提交知识 → (3) 调用 autosnippet_dimension_complete 完成每个维度。'
    );
    actionHints.push(
      '💡 冷启动前建议先加载 Skill 获取详细指引：autosnippet_skill({ operation: "load", name: "autosnippet-coldstart" })'
    );
  }

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
      ...(actionHints.length ? { actionHints } : {}),
    },
    meta: { tool: 'autosnippet_health' },
  });
}

let _pkgVersion = null;

export function capabilities() {
  // V3 工具分类映射
  const CATEGORY_MAP = {
    autosnippet_health: 'system',
    autosnippet_capabilities: 'system',
    autosnippet_search: 'search',
    autosnippet_knowledge: 'browse',
    autosnippet_structure: 'structure',
    autosnippet_graph: 'graph',
    autosnippet_guard: 'guard',
    autosnippet_submit_knowledge: 'submit',
    autosnippet_submit_knowledge_batch: 'submit',
    autosnippet_save_document: 'submit',
    autosnippet_skill: 'skill',
    autosnippet_bootstrap: 'bootstrap',
    autosnippet_dimension_complete: 'bootstrap',
    autosnippet_wiki_plan: 'wiki',
    autosnippet_wiki_finalize: 'wiki',
    autosnippet_enrich_candidates: 'admin',
    autosnippet_knowledge_lifecycle: 'admin',
    autosnippet_validate_candidate: 'admin',
    autosnippet_check_duplicate: 'admin',
  };

  // 根据当前 tier 决定可见工具
  const tierName = process.env.ASD_MCP_TIER || 'agent';
  const maxTier = TIER_ORDER[tierName] ?? TIER_ORDER.agent;
  const visibleTools = TOOLS.filter((t) => (TIER_ORDER[t.tier || 'agent'] ?? 0) <= maxTier);

  const tools = visibleTools.map((t) => {
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
      tier: t.tier || 'agent',
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
      tier: tierName,
      categoryGuide: {
        system: '系统状态与能力发现',
        search: '统合搜索 — auto(BM25+semantic 融合) / keyword / semantic / context(漏斗+会话)',
        browse: '知识浏览 — list/get/insights/confirm_usage（operation 路由）',
        graph: '知识图谱 — query/impact/path/stats（operation 路由）',
        structure: '项目结构 — targets/files/metadata（operation 路由）',
        submit: '知识提交（写操作，Gateway gated）',
        guard: '代码 Guard 检查 — code(单文件)/files(批量)（自动路由）',
        skill: 'Skill 管理 — list/load/create/update/delete/suggest',
        bootstrap: '冷启动 Mission Briefing — 无参数调用，返回项目分析 + 执行计划',
        admin: '管理员工具（诊断/生命周期/校验/去重）',
      },
      byCategory,
      tools,
      workflows: [
        {
          name: '知识查询',
          steps: [
            'search（推荐首选，auto mode 融合）',
            'knowledge op=get',
            'knowledge op=confirm_usage',
          ],
          tips: '精确匹配用 mode=keyword，需意图+会话上下文用 mode=context',
        },
        { name: '单条知识提交', steps: ['submit_knowledge（内置校验+去重）'] },
        {
          name: '批量 Target 扫描',
          steps: [
            'structure op=targets',
            'structure op=files',
            '(Agent 分析)',
            'submit_knowledge_batch',
          ],
        },
        {
          name: '冷启动（外部 Agent）',
          steps: [
            '⚠️ 先加载 Skill 获取详细指引: autosnippet_skill({ operation: "load", name: "autosnippet-coldstart" })',
            'bootstrap（获取 Mission Briefing，无参数直接调用）',
            '按 Briefing 中的 submissionSchema.example 格式提交知识（注意: content 和 reasoning 都是 JSON 对象）',
            'Agent 分析代码 + submit_knowledge / submit_knowledge_batch × N',
            'dimension_complete × N',
            'wiki_plan → Agent 写文章 → wiki_finalize（可选）',
          ],
        },
        { name: '代码审计', steps: ['guard (code/files)', 'knowledge op=list kind=rule'] },
      ],
    },
    meta: { tool: 'autosnippet_capabilities' },
  });
}
