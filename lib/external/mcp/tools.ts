/**
 * MCP 工具定义 — V3 整合版 (18 agent + 4 admin = 22 工具)
 *
 * 每个工具声明包含 name、tier（agent/admin）、description 和 inputSchema。
 * description 是 Agent 选择工具的关键 — 使用 bullet list 列出所有 operation 及其用途。
 * inputSchema 由 Zod Schema 自动生成（zodToMcpSchema），参数的 .describe() 会转为 JSON Schema description。
 *
 * Agent 工具 (18):
 *   1-7:   查询工具 (health/search/knowledge/structure/graph/call_context/guard)
 *   8-10:  写入工具 (submit_knowledge/submit_knowledge_batch/save_document)
 *   11:    Skill 管理 (skill)
 *   12-15: 冷启动 (bootstrap/dimension_complete/wiki_plan/wiki_finalize)
 *   16:    自发现 (capabilities)
 *   17:    任务管理 (task)
 *
 * Admin 工具 (4):
 *   18-21: enrich_candidates/knowledge_lifecycle/validate_candidate/check_duplicate
 */

import {
  BootstrapInput,
  CallContextInput,
  CapabilitiesInput,
  CheckDuplicateInput,
  DimensionCompleteInput,
  EnrichCandidatesInput,
  GraphInput,
  GuardInput,
  HealthInput,
  KnowledgeInput,
  KnowledgeLifecycleInput,
  SaveDocumentInput,
  SearchInput,
  SkillInput,
  StructureInput,
  SubmitKnowledgeBatchInput,
  SubmitKnowledgeInput,
  TaskInput,
  ValidateCandidateInput,
  WikiFinalizeInput,
  WikiPlanInput,
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
  // wiki_finalize — 写操作（meta.json）
  autosnippet_wiki_finalize: { action: 'knowledge:create', resource: 'knowledge' },
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
  // 知识提交
  autosnippet_submit_knowledge: { action: 'knowledge:create', resource: 'knowledge' },
  autosnippet_submit_knowledge_batch: { action: 'knowledge:create', resource: 'knowledge' },
  autosnippet_save_document: { action: 'knowledge:create', resource: 'knowledge' },
  // task 写操作（create/claim/close/fail/defer/decompose/dep_add + decision 写操作）
  autosnippet_task: {
    resolver: (args: Record<string, unknown>) =>
      (
        ({
          create: { action: 'task:create', resource: 'tasks' },
          claim: { action: 'task:update', resource: 'tasks' },
          close: { action: 'task:update', resource: 'tasks' },
          fail: { action: 'task:update', resource: 'tasks' },
          defer: { action: 'task:update', resource: 'tasks' },
          progress: { action: 'task:update', resource: 'tasks' },
          decompose: { action: 'task:create', resource: 'tasks' },
          dep_add: { action: 'task:update', resource: 'tasks' },
          record_decision: { action: 'task:create', resource: 'tasks' },
          revise_decision: { action: 'task:update', resource: 'tasks' },
          unpin_decision: { action: 'task:update', resource: 'tasks' },
        }) as Record<string, { action: string; resource: string }>
      )[args?.operation as string] || null, // prime/ready/show/list/blocked/dep_tree/stats/list_decisions 只读
  },
  // admin 工具
  autosnippet_enrich_candidates: { action: 'knowledge:update', resource: 'knowledge' },
  autosnippet_knowledge_lifecycle: { action: 'knowledge:update', resource: 'knowledge' },
};

// ─── 工具声明 ────────────────────────────────────────────────

export const TOOLS = [
  // ══════════════════════════════════════════════════════
  //  Tier: agent — Agent 核心工具集 (18 个)
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
      '代码规范检查。\n' +
      '• 无参数 → 自动检查 git diff 增量文件（编码后首选用法）\n' +
      '• files → 检查指定文件列表\n' +
      '• code → 内联检查代码片段\n' +
      '每个 violation 附带修复指南（doClause + coreCode），按指示修复后可再次检查。',
    inputSchema: zodToMcpSchema(GuardInput),
  },

  // 8. 提交单条知识
  {
    name: 'autosnippet_submit_knowledge',
    tier: 'agent',
    description:
      '提交单条知识。所有字段须一次性提供。提交后进入 pending 状态，用户在 Dashboard 审核。\n' +
      '校验未通过的条目仍会入库，返回 recipeReadyHints 提示缺失字段。\n' +
      'content 和 reasoning 必须是对象（非字符串）。详见各参数 description。',
    inputSchema: zodToMcpSchema(SubmitKnowledgeInput),
  },

  // 9. 批量知识提交
  {
    name: 'autosnippet_submit_knowledge_batch',
    tier: 'agent',
    description:
      '批量提交知识条目。每条字段要求同 submit_knowledge，支持自动去重。\n' +
      '校验更严格：不通过的条目会被拒绝（不入库），返回 rejectedSummary。\n' +
      '适用于冷启动维度分析、模块批量扫描等场景。',
    inputSchema: zodToMcpSchema(SubmitKnowledgeBatchInput),
  },

  // 10. 保存开发文档
  {
    name: 'autosnippet_save_document',
    tier: 'agent',
    description:
      '保存开发文档（设计文档、排查报告、ADR 等）到知识库。仅需 title + markdown，无需完整 V3 字段。',
    inputSchema: zodToMcpSchema(SaveDocumentInput),
  },

  // 11. Skill 管理
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

  // 12. 冷启动
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

  // 13. 维度完成通知
  {
    name: 'autosnippet_dimension_complete',
    tier: 'agent',
    description:
      '维度分析完成通知。负责：Recipe 关联、Skill 生成（从已提交候选自动合成）、Checkpoint 保存、跨维度 Hints 分发。\n' +
      'analysisText 可简写，系统会自动从已提交的候选知识中合成详细内容用于 Skill 生成。',
    inputSchema: zodToMcpSchema(DimensionCompleteInput),
  },

  // 14. Wiki 规划
  {
    name: 'autosnippet_wiki_plan',
    tier: 'agent',
    description:
      '规划 Wiki 文档生成 — 整合项目结构与知识库，返回文档主题列表及每个主题的数据包。Agent 根据规划自行撰写文章。',
    inputSchema: zodToMcpSchema(WikiPlanInput),
  },

  // 15. Wiki 完成
  {
    name: 'autosnippet_wiki_finalize',
    tier: 'agent',
    description: '完成 Wiki 生成 — 写入 meta.json、去重检查、验证完整性。所有文章写入后调用。',
    inputSchema: zodToMcpSchema(WikiFinalizeInput),
  },

  // 16. 能力自发现
  {
    name: 'autosnippet_capabilities',
    tier: 'agent',
    description: '列出所有可用 MCP 工具及其用途概览。适合 Agent 初次接触时了解服务能力。',
    inputSchema: zodToMcpSchema(CapabilitiesInput),
  },

  // 17. 任务与决策管理
  {
    name: 'autosnippet_task',
    tier: 'agent',
    description:
      '任务与决策管理。每次对话开始时先调用 prime 加载上下文。\n' +
      '会话: prime（加载决策+任务+知识上下文）| ready（就绪确认）\n' +
      '任务: create | claim | close | fail | defer | progress | show | list | stats | blocked\n' +
      '分解: decompose（拆子任务）| dep_add（添加依赖）| dep_tree（依赖树）\n' +
      '决策: record_decision | revise_decision | unpin_decision | list_decisions',
    inputSchema: zodToMcpSchema(TaskInput),
  },

  // ══════════════════════════════════════════════════════
  //  Tier: admin — 管理员/CI 工具 (额外 +4)
  // ══════════════════════════════════════════════════════

  // 18. 候选字段诊断
  {
    name: 'autosnippet_enrich_candidates',
    tier: 'admin',
    description:
      '诊断候选条目的字段完整性（无 AI）。返回每条候选的 missingFields 列表，Agent 据此补全后重新提交。',
    inputSchema: zodToMcpSchema(EnrichCandidatesInput),
  },

  // 19. 知识生命周期
  {
    name: 'autosnippet_knowledge_lifecycle',
    tier: 'admin',
    description:
      '知识条目生命周期操作。approve/fast_track → 发布知识；reject → 拒绝；deprecate → 废弃；reactivate → 恢复。',
    inputSchema: zodToMcpSchema(KnowledgeLifecycleInput),
  },

  // 20. 候选预校验（调试）
  {
    name: 'autosnippet_validate_candidate',
    tier: 'admin',
    description: '独立候选校验（5 层结构化检查）。调试用，submit_knowledge 已内置校验。',
    inputSchema: zodToMcpSchema(ValidateCandidateInput),
  },

  // 21. 去重检测（调试）
  {
    name: 'autosnippet_check_duplicate',
    tier: 'admin',
    description: '独立相似度检测。调试用，submit_knowledge 已内置去重。',
    inputSchema: zodToMcpSchema(CheckDuplicateInput),
  },
];
