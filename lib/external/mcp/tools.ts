/**
 * MCP 工具定义 — V3 整合版 (14 agent + 2 admin = 16 工具)
 *
 * 每个工具声明包含 name、tier（agent/admin）、description 和 inputSchema。
 * description 是 Agent 选择工具的关键 — 使用 bullet list 列出所有 operation 及其用途。
 * inputSchema 由 Zod Schema 自动生成（zodToMcpSchema），参数的 .describe() 会转为 JSON Schema description。
 *
 * Agent 工具 (14):
 *   1-7:   查询工具 (health/search/knowledge/structure/graph/call_context/guard)
 *   8:     写入工具 (submit_knowledge — unified pipeline，单条/批量统一处理)
 *   9:     Skill 管理 (skill)
 *   10-12: 冷启动 (bootstrap/dimension_complete/wiki)
 *   13:    项目全景 (panorama)
 *   14:    任务管理 (task — 5 ops: prime/create/close/fail/record_decision)
 *
 * Admin 工具 (2):
 *   15-16: enrich_candidates/knowledge_lifecycle
 */

import {
  BootstrapInput,
  CallContextInput,
  DimensionCompleteInput,
  EnrichCandidatesInput,
  GraphInput,
  GuardInput,
  HealthInput,
  KnowledgeInput,
  KnowledgeLifecycleInput,
  PanoramaInput,
  SearchInput,
  SkillInput,
  StructureInput,
  SubmitKnowledgeInput,
  TaskInput,
  WikiInput,
} from '#shared/schemas/mcp-tools.js';
import { zodToMcpSchema } from './zodToMcpSchema.js';

// ─── Tier 定义 ──────────────────────────────────────────────
export const TIER_ORDER = { agent: 0, admin: 1 };

// ─── Gateway 映射（仅写操作需要 gating） ────────────────────

export const TOOL_GATEWAY_MAP = {
  // bootstrap — 无参数化 Mission Briefing（只读分析，无需 gating）
  // autosnippet_bootstrap: null,
  // dimension_complete — 写操作（recipe tagging + skill creation + checkpoint）
  autosnippet_dimension_complete: { action: 'knowledge:bootstrap', resource: 'knowledge' },
  // wiki — finalize 操作是写操作（meta.json）
  autosnippet_wiki: {
    resolver: (args: Record<string, unknown>) =>
      args?.operation === 'finalize' ? { action: 'knowledge:create', resource: 'knowledge' } : null, // plan 只读
  },
  // guard 写操作（仅 files 模式）
  autosnippet_guard: {
    resolver: (args: Record<string, unknown>) =>
      args?.files && Array.isArray(args.files)
        ? { action: 'guard_rule:check_code', resource: 'guard_rules' }
        : null, // code 模式只读，跳过 Gateway
  },
  // skill 写操作（create/update/delete）
  autosnippet_skill: {
    resolver: (args: Record<string, unknown>) =>
      (
        ({
          create: { action: 'create:skills', resource: 'skills' },
          update: { action: 'update:skills', resource: 'skills' },
          delete: { action: 'delete:skills', resource: 'skills' },
        }) as Record<string, { action: string; resource: string }>
      )[args?.operation as string] || null, // list/load/suggest 只读
  },
  // 知识提交（unified pipeline）
  autosnippet_submit_knowledge: { action: 'knowledge:create', resource: 'knowledge' },
  // task 写操作（create/close/fail + record_decision）
  autosnippet_task: {
    resolver: (args: Record<string, unknown>) =>
      (
        ({
          create: { action: 'task:create', resource: 'intent' },
          close: { action: 'task:update', resource: 'intent' },
          fail: { action: 'task:update', resource: 'intent' },
          record_decision: { action: 'task:create', resource: 'intent' },
        }) as Record<string, { action: string; resource: string }>
      )[args?.operation as string] || null, // prime 只读
  },
  // admin 工具
  autosnippet_enrich_candidates: { action: 'knowledge:update', resource: 'knowledge' },
  autosnippet_knowledge_lifecycle: { action: 'knowledge:update', resource: 'knowledge' },
};

// ─── 工具声明 ────────────────────────────────────────────────

export const TOOLS = [
  // ══════════════════════════════════════════════════════
  //  Tier: agent — Agent 核心工具集 (14 个)
  // ══════════════════════════════════════════════════════

  // 1. 健康检查
  {
    name: 'autosnippet_health',
    tier: 'agent',
    description:
      '检查服务状态与知识库统计。返回 total（知识总数）和各 kind/lifecycle 分布。total=0 时需要冷启动（调用 autosnippet_bootstrap）。',
    inputSchema: zodToMcpSchema(HealthInput),
  },

  // 2. 统合搜索
  {
    name: 'autosnippet_search',
    tier: 'agent',
    description:
      '搜索知识库。5 种模式：\n' +
      '• auto（默认）— 自动选最优策略\n' +
      '• keyword — 精确关键词匹配，适合 trigger/title 查找\n' +
      '• bm25 — 全文检索，适合自然语言描述\n' +
      '• semantic — 向量语义搜索，适合模糊概念匹配\n' +
      '• context — 综合搜索 + 上下文关联，适合编码辅助\n' +
      '返回按 kind（rule/pattern/fact）分组的结果。',
    inputSchema: zodToMcpSchema(SearchInput),
  },

  // 3. 知识浏览
  {
    name: 'autosnippet_knowledge',
    tier: 'agent',
    description:
      '知识条目管理。\n' +
      '• list — 按 kind/category/status 过滤列表\n' +
      '• get — 获取单条完整内容（需 id）\n' +
      '• insights — 条目质量分析与改进建议（需 id）\n' +
      '• confirm_usage — 记录知识被实际采纳（需 id）',
    inputSchema: zodToMcpSchema(KnowledgeInput),
  },

  // 4. 项目结构
  {
    name: 'autosnippet_structure',
    tier: 'agent',
    description:
      '探查项目结构。\n' +
      '• targets — 构建目标列表（模块/Target/Package）\n' +
      '• files — 指定 Target 的文件列表\n' +
      '• metadata — 项目元数据（语言、依赖、配置）',
    inputSchema: zodToMcpSchema(StructureInput),
  },

  // 5. 知识图谱
  {
    name: 'autosnippet_graph',
    tier: 'agent',
    description:
      '知识关系图谱查询。\n' +
      '• query — 查询节点的关联关系\n' +
      '• impact — 修改某知识的影响范围分析\n' +
      '• path — 两个知识节点间的关联路径\n' +
      '• stats — 图谱全局统计（节点/边/密度）',
    inputSchema: zodToMcpSchema(GraphInput),
  },

  // 6. 调用链上下文
  {
    name: 'autosnippet_call_context',
    tier: 'agent',
    description:
      '查询函数/方法的调用链。\n' +
      '• callers — 谁调用了它（上游调用链）\n' +
      '• callees — 它调用了谁（下游依赖链）\n' +
      '• impact — 修改它的影响半径（上+下游+受影响文件数）\n' +
      '• both — 同时获取 callers + callees',
    inputSchema: zodToMcpSchema(CallContextInput),
  },

  // 7. Guard 代码检查
  {
    name: 'autosnippet_guard',
    tier: 'agent',
    description:
      '代码规范检查与 Guard 免疫系统。\n' +
      '• 无参数 → 自动检查 git diff 增量文件（编码后首选用法）\n' +
      '• files → 检查指定文件列表\n' +
      '• code → 内联检查代码片段\n' +
      '• operation: "reverse_audit" → Recipe→Code 反向验证（检查知识是否过时）\n' +
      '• operation: "coverage_matrix" → 模块级 Guard 规则覆盖率矩阵\n' +
      '每个 violation 附带修复指南（doClause + coreCode），按指示修复后可再次检查。',
    inputSchema: zodToMcpSchema(GuardInput),
  },

  // 8. 提交知识（统一管线）
  {
    name: 'autosnippet_submit_knowledge',
    tier: 'agent',
    description:
      '提交知识条目（单条/批量统一管线）。通过 items 数组传入 1~N 条。\n' +
      '• 所有条目统一严格校验，所有 V3 字段须一次性提供\n' +
      '• 统一融合分析：检测与已有 Recipe 和批次内候选的重叠\n' +
      '• 返回 CONSOLIDATION_MERGE / CONSOLIDATION_REORGANIZE / CONSOLIDATION_INSUFFICIENT 时需处理\n' +
      '• 设 skipConsolidation: true 跳过融合检查。content 和 reasoning 必须是对象。',
    inputSchema: zodToMcpSchema(SubmitKnowledgeInput),
  },

  // 9. Skill 管理
  {
    name: 'autosnippet_skill',
    tier: 'agent',
    description:
      'Skill 管理。\n' +
      '• list — 列出所有可用 Skill（内置 + 项目级）\n' +
      '• load — 加载 Skill 完整内容，获取详细指引（需 name）\n' +
      '• create — 创建项目级 Skill（需 name + description + content）\n' +
      '• update — 更新项目级 Skill 内容\n' +
      '• delete — 删除项目级 Skill（内置不可删）\n' +
      '• suggest — 基于项目分析推荐应创建的 Skill',
    inputSchema: zodToMcpSchema(SkillInput),
  },

  // 10. 冷启动
  {
    name: 'autosnippet_bootstrap',
    tier: 'agent',
    description:
      '冷启动 — 无需参数，自动分析项目（AST、依赖图、Guard 审计），返回 Mission Briefing：\n' +
      '• 项目元数据与语言统计\n' +
      '• 维度任务清单（8 维度 × 3 Tier）\n' +
      '• 执行计划与提交示例\n' +
      '收到 Briefing 后按 executionPlan 完成所有维度分析。',
    inputSchema: zodToMcpSchema(BootstrapInput),
  },

  // 11. 维度完成通知
  {
    name: 'autosnippet_dimension_complete',
    tier: 'agent',
    description:
      '维度分析完成通知。负责：Recipe 关联、Skill 生成（从已提交候选自动合成）、Checkpoint 保存、跨维度 Hints 分发。\n' +
      'analysisText 可简写，系统会自动从已提交的候选知识中合成详细内容用于 Skill 生成。',
    inputSchema: zodToMcpSchema(DimensionCompleteInput),
  },

  // 12. Wiki 文档生成
  {
    name: 'autosnippet_wiki',
    tier: 'agent',
    description:
      'Wiki 文档生成。\n' +
      '• plan — 规划主题 + 数据包（整合项目结构与知识库，返回主题列表 + 每个主题的数据包，Agent 据此撰写）\n' +
      '• finalize — 完成生成（写入 meta.json、去重检查、验证完整性，所有文章写入后调用）',
    inputSchema: zodToMcpSchema(WikiInput),
  },

  // 13. 项目全景
  {
    name: 'autosnippet_panorama',
    tier: 'agent',
    description:
      '项目全景查询。无数据时自动触发结构扫描，无需手动冷启动。\n' +
      '• overview（默认）— 项目骨架 + 架构层级 + 模块角色 + 知识覆盖率\n' +
      '• module — 单模块详情 + 邻居关系（需 module 参数）\n' +
      '• gaps — 知识空白区（有代码无 Recipe 的模块）\n' +
      '• health — 全景健康度（覆盖率 + 耦合度 + 循环依赖 + 健康评分）\n' +
      '• governance_cycle — 知识新陈代谢完整周期（矛盾检测 + 冗余分析 + 衰退评估）\n' +
      '• decay_report — 衰退评估报告（5 策略检测 + decayScore 评分）\n' +
      '• staging_check — staging 条目检查 + 到期自动发布\n' +
      '• enhancement_suggestions — 基于使用数据的 Recipe 增强建议',
    inputSchema: zodToMcpSchema(PanoramaInput),
  },

  // 14. 任务与决策管理
  {
    name: 'autosnippet_task',
    tier: 'agent',
    description:
      '任务与决策管理（5 operations）。每次对话开始时先调用 prime 加载知识上下文。\n' +
      '• prime — 加载知识上下文 + 初始化意图生命周期\n' +
      '• create — 创建任务锚点（≥2 files 或 ≥10 lines 的非轻量工作）\n' +
      '• close — 完成任务 + 触发 Guard 合规审查\n' +
      '• fail — 放弃任务\n' +
      '• record_decision — 记录用户偏好决策',
    inputSchema: zodToMcpSchema(TaskInput),
  },

  // ══════════════════════════════════════════════════════
  //  Tier: admin — 管理员/CI 工具 (+2)
  // ══════════════════════════════════════════════════════

  // 15. 候选字段诊断
  {
    name: 'autosnippet_enrich_candidates',
    tier: 'admin',
    description:
      '诊断候选条目的字段完整性（无 AI）。返回每条候选的 missingFields 列表，Agent 据此补全后重新提交。',
    inputSchema: zodToMcpSchema(EnrichCandidatesInput),
  },

  // 16. 知识生命周期
  {
    name: 'autosnippet_knowledge_lifecycle',
    tier: 'admin',
    description:
      '知识条目生命周期操作。approve/fast_track → 发布知识；reject → 拒绝；deprecate → 废弃；reactivate → 恢复。',
    inputSchema: zodToMcpSchema(KnowledgeLifecycleInput),
  },
];
