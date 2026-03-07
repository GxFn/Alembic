/**
 * MCP 工具定义 — V3 整合版 (18 agent + 4 admin = 22 工具)
 *
 * 从 39 → 22 工具（参数路由合并同类工具 + 外部 Agent 冷启动新架构 + TaskGraph 统一入口）。
 * TaskGraph: autosnippet_task (统一入口，含 prime/decision/task CRUD)
 * 每个工具声明增加 tier 字段（agent / admin）。
 *
 * inputSchema 由 Zod Schema 自动生成（zodToMcpSchema），消除手写 JSON Schema 双重维护。
 * Zod Schema → 运行时校验（wrapHandler）+ JSON Schema 声明（ListTools）。
 *
 * 外部 Agent 冷启动新工具 (v3.1):
 *   - autosnippet_bootstrap:          参数化 → 无参数化 Mission Briefing
 *   - autosnippet_dimension_complete:  维度分析完成通知
 *   - autosnippet_wiki_plan:           Wiki 主题规划
 *   - autosnippet_wiki_finalize:       Wiki 元数据 + 去重
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
    description: '检查服务健康状态与知识库统计。total=0 时表示需要冷启动。',
    inputSchema: zodToMcpSchema(HealthInput),
  },

  // 2. 统合搜索（4 → 1）
  {
    name: 'autosnippet_search',
    tier: 'agent',
    description: '统合搜索入口。支持 4 种模式（mode 参数），返回 byKind 分组结果。',
    inputSchema: zodToMcpSchema(SearchInput),
  },

  // 3. 知识浏览（7 → 1）
  {
    name: 'autosnippet_knowledge',
    tier: 'agent',
    description:
      '知识浏览与使用确认。list=列表过滤 | get=单条详情 | insights=质量洞察 | confirm_usage=记录采纳。',
    inputSchema: zodToMcpSchema(KnowledgeInput),
  },

  // 4. 项目结构（3 → 1）
  {
    name: 'autosnippet_structure',
    tier: 'agent',
    description: '项目结构探查。targets=目标列表 | files=文件列表 | metadata=元数据与依赖。',
    inputSchema: zodToMcpSchema(StructureInput),
  },

  // 5. 知识图谱（4 → 1）
  {
    name: 'autosnippet_graph',
    tier: 'agent',
    description:
      '知识图谱查询。query=节点关系 | impact=影响分析 | path=路径查找 | stats=全局统计。',
    inputSchema: zodToMcpSchema(GraphInput),
  },

  // 6. 调用链上下文 (Phase 5)
  {
    name: 'autosnippet_call_context',
    tier: 'agent',
    description:
      '查询方法的调用链上下文。\n' +
      '• callers: 谁调用了这个方法？（调用者链）\n' +
      '• callees: 这个方法调用了谁？（依赖链）\n' +
      '• impact: 修改此方法的影响半径分析\n' +
      '• both: 同时获取调用者和被调用者',
    inputSchema: zodToMcpSchema(CallContextInput),
  },

  // 7. Guard 检查（统一入口）
  {
    name: 'autosnippet_guard',
    tier: 'agent',
    description:
      '代码规范检查 & 质量门禁。\n' +
      '• 无参数 → 自动从 git diff 检测增量文件并检查（编码后推荐用法）\n' +
      '• files: ["path/to/file.m", ...] → 检查指定文件\n' +
      '• code: "..." → 单文件内联检查\n' +
      '每个 violation 内联 recipe 修复指南（doClause + coreCode），直接按指示修复后再次调用。',
    inputSchema: zodToMcpSchema(GuardInput),
  },

  // 7. 提交知识（严格前置校验 + 去重检测）
  {
    name: 'autosnippet_submit_knowledge',
    tier: 'agent',
    description:
      '提交单条知识到知识库（V3 统一实体）。严格前置校验，缺少必要字段将被直接拒绝（不入库）。\n' +
      '所有必填字段必须在单次调用中一次性提供，不要分步提交。\n' +
      '⚠️ content 必须是对象: { "pattern": "代码片段", "markdown": "## 标题\\n正文...", "rationale": "设计原理" }（pattern/markdown 至少一个 + rationale 必填）\n' +
      '⚠️ reasoning 必须是对象: { "whyStandard": "原因", "sources": ["file.ts"], "confidence": 0.85 }\n' +
      '必填: title, language, content, kind, doClause, dontClause, whenClause, coreCode, category, trigger, description, headers, usageGuide, knowledgeType, reasoning',
    inputSchema: zodToMcpSchema(SubmitKnowledgeInput),
  },

  // 8. 批量知识提交
  {
    name: 'autosnippet_submit_knowledge_batch',
    tier: 'agent',
    description:
      '批量提交知识条目（V3 统一实体）。每条字段要求同 submit_knowledge。支持去重。\n' +
      '⚠️ items 数组中每条的 content 和 reasoning 都必须是 JSON 对象（不是字符串）。\n' +
      'content 格式: { "pattern": "代码...", "markdown": "正文...", "rationale": "原理..." }\n' +
      'reasoning 格式: { "whyStandard": "原因", "sources": ["file.ts"], "confidence": 0.85 }',
    inputSchema: zodToMcpSchema(SubmitKnowledgeBatchInput),
  },

  // 9. 保存开发文档
  {
    name: 'autosnippet_save_document',
    tier: 'agent',
    description:
      '保存开发文档（设计文档、排查报告、ADR 等）。仅需 title + markdown，自动以 dev-document 存储。',
    inputSchema: zodToMcpSchema(SaveDocumentInput),
  },

  // 10. Skill 管理（6 → 1）
  {
    name: 'autosnippet_skill',
    tier: 'agent',
    description:
      'Skill 管理。list=列表 | load=加载 | create=创建 | update=更新 | delete=删除 | suggest=AI推荐。',
    inputSchema: zodToMcpSchema(SkillInput),
  },

  // 11. 冷启动 Mission Briefing（无参数，返回项目分析 + 执行计划）
  {
    name: 'autosnippet_bootstrap',
    tier: 'agent',
    description:
      '冷启动 Mission Briefing — 自动分析项目结构、AST、依赖图和 Guard 审计，返回完整的执行计划和维度任务清单。无需任何参数，直接调用即可。不依赖数据库，DB 不可用时也能正常工作。\n' +
      '💡 建议先加载 Skill 获取详细冷启动指引: autosnippet_skill({ operation: "load", name: "autosnippet-coldstart" })\n' +
      '返回的 submissionSchema.example 包含完整的提交 JSON 示例，请严格按其格式提交知识。',
    inputSchema: zodToMcpSchema(BootstrapInput),
  },

  // 11b. 维度完成通知
  {
    name: 'autosnippet_dimension_complete',
    tier: 'agent',
    description:
      '维度分析完成通知 — Agent 完成一个维度的分析后调用。负责 Recipe 关联、Skill 生成、Checkpoint 保存、进度推送、跨维度 Hints 分发。',
    inputSchema: zodToMcpSchema(DimensionCompleteInput),
  },

  // 11c. Wiki 主题规划
  {
    name: 'autosnippet_wiki_plan',
    tier: 'agent',
    description:
      '规划 Wiki 文档生成 — 扫描项目结构、分析 AST 和依赖、整合知识库，返回发现的文档主题及每个主题的数据包。Agent 根据规划自行撰写文章后写入 wiki 目录。',
    inputSchema: zodToMcpSchema(WikiPlanInput),
  },

  // 11d. Wiki 完成（meta.json + 去重）
  {
    name: 'autosnippet_wiki_finalize',
    tier: 'agent',
    description:
      '完成 Wiki 生成 — 写入 meta.json、执行去重检查、验证文件完整性。在所有 Wiki 文章写入完成后调用。',
    inputSchema: zodToMcpSchema(WikiFinalizeInput),
  },

  // 12. 能力声明（Agent 自发现）
  {
    name: 'autosnippet_capabilities',
    tier: 'agent',
    description: '列出所有可用 MCP 工具的概览，供 Agent 自发现服务能力。',
    inputSchema: zodToMcpSchema(CapabilitiesInput),
  },

  // 13. autosnippet_task — 统一任务管理（含 prime/decision/CRUD）
  {
    name: 'autosnippet_task',
    tier: 'agent',
    description:
      'Unified task & decision management. Includes session context (prime), task CRUD, and decision persistence.\n' +
      'Call prime FIRST at every conversation start to load decisions + tasks + knowledge context.',
    inputSchema: zodToMcpSchema(TaskInput),
  },

  // ══════════════════════════════════════════════════════
  //  Tier: admin — 管理员/CI 工具 (额外 +4)
  // ══════════════════════════════════════════════════════

  // 13. 候选字段诊断
  {
    name: 'autosnippet_enrich_candidates',
    tier: 'admin',
    description: '候选字段完整性诊断（不使用 AI）。返回 missingFields 列表，Agent 自行补全。',
    inputSchema: zodToMcpSchema(EnrichCandidatesInput),
  },

  // 14. 知识条目生命周期
  {
    name: 'autosnippet_knowledge_lifecycle',
    tier: 'admin',
    description:
      '知识条目生命周期操作：submit/approve/reject/publish/deprecate/reactivate/fast_track。',
    inputSchema: zodToMcpSchema(KnowledgeLifecycleInput),
  },

  // 15. 独立候选校验（调试）
  {
    name: 'autosnippet_validate_candidate',
    tier: 'admin',
    description: '对候选做结构化预校验（5层），调试用（Agent 层的 submit_knowledge 已内置校验）。',
    inputSchema: zodToMcpSchema(ValidateCandidateInput),
  },

  // 16. 独立去重检测（调试）
  {
    name: 'autosnippet_check_duplicate',
    tier: 'admin',
    description: '相似度检测（调试用，Agent 层的 submit_knowledge 已内置去重）。',
    inputSchema: zodToMcpSchema(CheckDuplicateInput),
  },
];
