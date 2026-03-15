/**
 * mcp-tools.ts — MCP 工具输入 Zod Schema
 *
 * 每个 MCP 工具的输入参数定义为 Zod Schema，既做运行时校验，
 * 又可通过 zodToJsonSchema() 自动生成 inputSchema 声明（消除双重维护）。
 *
 * 命名约定：`{ToolSuffix}Input`，如 `SearchInput` 对应 `autosnippet_search`。
 *
 * @module shared/schemas/mcp-tools
 */

import { z } from 'zod';
import {
  ComplexityEnum,
  ContentSchema,
  IdField,
  KindEnum,
  KnowledgeTypeEnum,
  LanguageField,
  ReasoningSchema,
  ScopeEnum,
  StrictKindEnum,
  TitleField,
} from './common.js';

// ══════════════════════════════════════════════════════
//  1. autosnippet_health — 无参数
// ══════════════════════════════════════════════════════

export const HealthInput = z.object({});
export type HealthInput = z.infer<typeof HealthInput>;

// ══════════════════════════════════════════════════════
//  2. autosnippet_search
// ══════════════════════════════════════════════════════

export const SearchInput = z.object({
  query: z.string().min(1, 'query is required').describe('搜索关键词或自然语言描述'),
  mode: z
    .enum(['auto', 'keyword', 'bm25', 'semantic', 'context'])
    .default('auto')
    .describe(
      'auto=自动选策略 | keyword=精确匹配 | bm25=全文检索 | semantic=向量语义 | context=综合+上下文'
    ),
  kind: KindEnum.default('all').describe('过滤知识类型: all/rule/pattern/fact'),
  limit: z.number().int().min(1).max(100).default(10),
  language: z.string().optional().describe('按编程语言过滤，如 swift/typescript'),
  sessionId: z.string().optional(),
  sessionHistory: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type SearchInput = z.infer<typeof SearchInput>;

// ══════════════════════════════════════════════════════
//  3. autosnippet_knowledge
// ══════════════════════════════════════════════════════

export const KnowledgeInput = z
  .object({
    operation: z
      .enum(['list', 'get', 'insights', 'confirm_usage'])
      .default('list')
      .describe(
        'list=列表 | get=单条详情(id) | insights=质量分析(id) | confirm_usage=记录采纳(id)'
      ),
    id: z.string().optional().describe('get/insights/confirm_usage 时必填'),
    kind: KindEnum.optional(),
    language: z.string().optional(),
    category: z.string().optional(),
    knowledgeType: z.string().optional(),
    status: z.string().optional(),
    complexity: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(20),
    usageType: z.enum(['adoption', 'application']).optional(),
    feedback: z.string().optional(),
  })
  .refine(
    (d) => {
      if (['get', 'insights', 'confirm_usage'].includes(d.operation) && !d.id) {
        return false;
      }
      return true;
    },
    { message: 'id is required for get/insights/confirm_usage operations' }
  );
export type KnowledgeInput = z.infer<typeof KnowledgeInput>;

// ══════════════════════════════════════════════════════
//  4. autosnippet_structure
// ══════════════════════════════════════════════════════

export const StructureInput = z.object({
  operation: z
    .enum(['targets', 'files', 'metadata'])
    .default('targets')
    .describe('targets=构建目标列表 | files=Target文件列表 | metadata=项目元数据'),
  targetName: z.string().optional().describe('files 操作时指定目标名'),
  includeSummary: z.boolean().default(true),
  includeContent: z.boolean().default(false),
  contentMaxLines: z.number().int().min(1).default(100),
  maxFiles: z.number().int().min(1).max(5000).default(500),
});
export type StructureInput = z.infer<typeof StructureInput>;

// ══════════════════════════════════════════════════════
//  5. autosnippet_graph
// ══════════════════════════════════════════════════════

export const GraphInput = z.object({
  operation: z
    .enum(['query', 'impact', 'path', 'stats'])
    .describe('query=节点关系 | impact=影响分析 | path=路径查找 | stats=全局统计'),
  nodeId: z.string().optional().describe('query/impact 时指定节点 ID'),
  nodeType: z.string().default('recipe'),
  fromId: z.string().optional(),
  toId: z.string().optional(),
  direction: z.enum(['out', 'in', 'both']).default('both'),
  maxDepth: z.number().int().min(1).max(10).default(3),
  relation: z.string().optional(),
});
export type GraphInput = z.infer<typeof GraphInput>;

// ══════════════════════════════════════════════════════
//  6. autosnippet_call_context
// ══════════════════════════════════════════════════════

export const CallContextInput = z.object({
  methodName: z.string().min(1, 'methodName is required').describe('函数/方法名称，支持部分匹配'),
  direction: z
    .enum(['callers', 'callees', 'both', 'impact'])
    .default('both')
    .describe('callers=上游调用者 | callees=下游依赖 | both=双向 | impact=影响半径'),
  maxDepth: z.number().int().min(1).max(5).default(2),
});
export type CallContextInput = z.infer<typeof CallContextInput>;

// ══════════════════════════════════════════════════════
//  7. autosnippet_guard
// ══════════════════════════════════════════════════════

export const GuardInput = z.object({
  files: z.array(z.string()).optional(),
  code: z.string().optional(),
  language: z.string().optional(),
  filePath: z.string().optional(),
});
export type GuardInput = z.infer<typeof GuardInput>;

// ══════════════════════════════════════════════════════
//  7b. autosnippet_submit_knowledge
// ══════════════════════════════════════════════════════

export const SubmitKnowledgeInput = z.object({
  // ── 必填字段 ──
  title: TitleField.describe('知识标题，简洁明确'),
  language: LanguageField.describe('编程语言，如 typescript/swift/python'),
  content: ContentSchema.describe(
    '内容对象: { pattern?: "代码片段", markdown?: "正文", rationale: "设计原理" }。pattern/markdown 至少提供一个，rationale 必填'
  ),
  kind: StrictKindEnum.describe('rule=规范约束 | pattern=代码模式 | fact=项目事实'),
  doClause: z
    .string()
    .min(1, 'doClause is required')
    .describe('✅ 应该怎么做（Channel A+B 硬依赖）'),
  dontClause: z.string().min(1, 'dontClause is required').describe('❌ 不应该怎么做'),
  whenClause: z.string().min(1, 'whenClause is required').describe('何时适用（Channel B 硬依赖）'),
  coreCode: z.string().min(1, 'coreCode is required').describe('核心代码片段（Channel B 模板块）'),
  category: z
    .string()
    .min(1, 'category is required')
    .describe('View/Service/Tool/Model/Network/Storage/UI/Utility'),
  trigger: z.string().min(1, 'trigger is required').describe('触发关键词，如 @NetworkMonitor'),
  description: z.string().min(1, 'description is required').describe('一句话描述用途'),
  headers: z.array(z.string()).describe('完整 import 语句列表'),
  usageGuide: z
    .string()
    .min(1, 'usageGuide is required')
    .describe('使用指南（Markdown，用 ### 分节：何时用/关键点/何时不用）'),
  knowledgeType: z
    .string()
    .min(1, 'knowledgeType is required')
    .describe('code-pattern/architecture/best-practice/code-standard 等'),
  reasoning: ReasoningSchema.describe(
    '推理对象: { whyStandard: "原因", sources: ["来源"], confidence: 0.0-1.0 }'
  ),
  // ── 可选字段 ──
  topicHint: z.string().optional(),
  complexity: ComplexityEnum.optional(),
  scope: ScopeEnum.optional(),
  difficulty: z.string().optional(),
  tags: z.array(z.string()).optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  relations: z.record(z.string(), z.unknown()).optional(),
  headerPaths: z.array(z.string()).optional(),
  moduleName: z.string().optional(),
  includeHeaders: z.boolean().optional(),
  source: z.string().optional(),
  client_id: z.string().optional(),
  skipDuplicateCheck: z.boolean().default(false),
  dimensionId: z.string().optional(),
});
export type SubmitKnowledgeInput = z.infer<typeof SubmitKnowledgeInput>;

// ══════════════════════════════════════════════════════
//  8. autosnippet_submit_knowledge_batch
// ══════════════════════════════════════════════════════

export const SubmitKnowledgeBatchInput = z.object({
  target_name: z
    .string()
    .min(1, 'target_name is required')
    .describe('批量来源标识，如 network-module-scan'),
  items: z
    .array(z.record(z.string(), z.unknown()))
    .min(1, 'items array must not be empty')
    .describe('知识条目数组，每条字段同 submit_knowledge。content/reasoning 必须是对象'),
  source: z.string().default('cursor-scan'),
  deduplicate: z.boolean().default(true).describe('基于 title 自动去重，默认开启'),
  client_id: z.string().optional(),
  dimensionId: z.string().optional().describe('冷启动时关联维度 ID'),
});
export type SubmitKnowledgeBatchInput = z.infer<typeof SubmitKnowledgeBatchInput>;

// ══════════════════════════════════════════════════════
//  9. autosnippet_save_document
// ══════════════════════════════════════════════════════

export const SaveDocumentInput = z.object({
  title: TitleField,
  markdown: z.string().min(1, 'markdown content is required'),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  scope: z.enum(['universal', 'project-specific']).default('project-specific'),
  source: z.string().optional(),
});
export type SaveDocumentInput = z.infer<typeof SaveDocumentInput>;

// ══════════════════════════════════════════════════════
//  10. autosnippet_skill
// ══════════════════════════════════════════════════════

export const SkillInput = z.object({
  operation: z
    .enum(['list', 'load', 'create', 'update', 'delete', 'suggest'])
    .describe(
      'list=列表 | load=加载内容(name) | create=创建 | update=更新 | delete=删除 | suggest=推荐'
    ),
  name: z.string().optional().describe('Skill 名称（kebab-case，如 autosnippet-create）'),
  skillName: z.string().optional().describe('name 的别名，与 name 等价'),
  section: z.string().optional().describe('load 时过滤指定章节'),
  description: z.string().optional().describe('create/update 时的简短描述'),
  content: z.string().optional().describe('create/update 时的 Markdown 内容'),
  overwrite: z.boolean().default(false),
  createdBy: z.enum(['manual', 'user-ai', 'system-ai', 'external-ai']).default('external-ai'),
});
export type SkillInput = z.infer<typeof SkillInput>;

// ══════════════════════════════════════════════════════
//  11. autosnippet_bootstrap — 无参数
// ══════════════════════════════════════════════════════

export const BootstrapInput = z.object({});
export type BootstrapInput = z.infer<typeof BootstrapInput>;

// ══════════════════════════════════════════════════════
//  11b. autosnippet_dimension_complete
// ══════════════════════════════════════════════════════

export const DimensionCompleteInput = z.object({
  sessionId: z.string().optional(),
  dimensionId: z.string().min(1, 'dimensionId is required'),
  submittedRecipeIds: z.array(z.string()).optional(),
  analysisText: z
    .string()
    .min(1, 'analysisText is required')
    .describe(
      '维度分析报告（Markdown）。写得越详细，生成的 Skill 质量越高；若过短，系统会自动从候选知识中合成。'
    ),
  referencedFiles: z.array(z.string()).optional(),
  keyFindings: z.array(z.string()).optional(),
  candidateCount: z.number().int().min(0).optional(),
  crossDimensionHints: z.record(z.string(), z.string()).optional(),
});
export type DimensionCompleteInput = z.infer<typeof DimensionCompleteInput>;

// ══════════════════════════════════════════════════════
//  11c. autosnippet_wiki_plan
// ══════════════════════════════════════════════════════

export const WikiPlanInput = z.object({
  language: z.enum(['zh', 'en']).default('zh'),
  sessionId: z.string().optional(),
});
export type WikiPlanInput = z.infer<typeof WikiPlanInput>;

// ══════════════════════════════════════════════════════
//  11d. autosnippet_wiki_finalize
// ══════════════════════════════════════════════════════

export const WikiFinalizeInput = z.object({
  articlesWritten: z.array(z.string()).min(1, 'articlesWritten must not be empty'),
});
export type WikiFinalizeInput = z.infer<typeof WikiFinalizeInput>;

// ══════════════════════════════════════════════════════
//  12. autosnippet_capabilities — 无参数
// ══════════════════════════════════════════════════════

export const CapabilitiesInput = z.object({});
export type CapabilitiesInput = z.infer<typeof CapabilitiesInput>;

// ══════════════════════════════════════════════════════
//  13. autosnippet_task
// ══════════════════════════════════════════════════════

export const TaskInput = z.object({
  operation: z
    .enum([
      'prime',
      'ready',
      'create',
      'claim',
      'close',
      'fail',
      'defer',
      'progress',
      'show',
      'list',
      'stats',
      'blocked',
      'decompose',
      'dep_add',
      'dep_tree',
      'record_decision',
      'revise_decision',
      'unpin_decision',
      'list_decisions',
    ])
    .describe(
      '会话: prime(首选) | ready。任务: create/claim/close/fail/defer/progress/show/list/stats/blocked。分解: decompose/dep_add/dep_tree。决策: record_decision/revise_decision/unpin_decision/list_decisions'
    ),
  title: z.string().optional(),
  description: z.string().optional(),
  design: z.string().optional(),
  acceptance: z.string().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  taskType: z.enum(['epic', 'task', 'bug', 'chore']).optional(),
  parentId: z.string().optional(),
  id: z.string().optional(),
  reason: z.string().optional(),
  rationale: z.string().optional(),
  tags: z.array(z.string()).optional(),
  relatedTaskId: z.string().optional(),
  dependsOn: z.string().optional(),
  depType: z
    .enum([
      'blocks',
      'parent-child',
      'waits-for',
      'discovered-from',
      'related',
      'knowledge-ref',
      'supersedes',
    ])
    .default('blocks'),
  limit: z.number().int().min(1).max(200).default(10),
  status: z.enum(['open', 'in_progress', 'deferred', 'closed', 'pinned']).optional(),
  withKnowledge: z.boolean().default(true),
  userQuery: z
    .string()
    .optional()
    .describe('User current input / prompt text for knowledge-aware search'),
  activeFile: z.string().optional().describe('Currently active file path in IDE'),
  language: z.string().optional().describe('Current programming language'),
  subtasks: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        priority: z.number().int().min(0).max(4).optional(),
        taskType: z.string().optional(),
        blockedByIndex: z.number().int().min(0).optional(),
      })
    )
    .optional(),
});
export type TaskInput = z.infer<typeof TaskInput>;

// ══════════════════════════════════════════════════════
//  Admin Tools
// ══════════════════════════════════════════════════════

// 14. autosnippet_enrich_candidates
export const EnrichCandidatesInput = z.object({
  candidateIds: z
    .array(z.string())
    .min(1, 'at least one candidate ID required')
    .max(20, 'max 20 candidates per call'),
});
export type EnrichCandidatesInput = z.infer<typeof EnrichCandidatesInput>;

// 15. autosnippet_knowledge_lifecycle
export const KnowledgeLifecycleInput = z.object({
  id: IdField,
  action: z
    .enum([
      'submit',
      'approve',
      'reject',
      'publish',
      'deprecate',
      'reactivate',
      'to_draft',
      'fast_track',
    ])
    .describe(
      'approve/fast_track=发布 | reject=拒绝 | deprecate=废弃 | reactivate=恢复 | to_draft=回草稿'
    ),
  reason: z.string().optional().describe('reject/deprecate 时的理由'),
});
export type KnowledgeLifecycleInput = z.infer<typeof KnowledgeLifecycleInput>;

// 16. autosnippet_validate_candidate
export const ValidateCandidateInput = z.object({
  candidate: z.record(z.string(), z.unknown()),
  strict: z.boolean().default(false),
});
export type ValidateCandidateInput = z.infer<typeof ValidateCandidateInput>;

// 17. autosnippet_check_duplicate
export const CheckDuplicateInput = z.object({
  candidate: z.object({
    title: z.string().optional(),
    summary: z.string().optional(),
    usageGuide: z.string().optional(),
    code: z.string().optional(),
  }),
  threshold: z.number().min(0).max(1).default(0.7),
  topK: z.number().int().min(1).max(50).default(5),
});
export type CheckDuplicateInput = z.infer<typeof CheckDuplicateInput>;

// ══════════════════════════════════════════════════════
//  工具名 → Schema 映射表（用于 wrapHandler 自动注入校验）
// ══════════════════════════════════════════════════════

export const TOOL_SCHEMAS: Record<string, z.ZodType> = {
  autosnippet_health: HealthInput,
  autosnippet_search: SearchInput,
  autosnippet_knowledge: KnowledgeInput,
  autosnippet_structure: StructureInput,
  autosnippet_graph: GraphInput,
  autosnippet_call_context: CallContextInput,
  autosnippet_guard: GuardInput,
  autosnippet_submit_knowledge: SubmitKnowledgeInput,
  autosnippet_submit_knowledge_batch: SubmitKnowledgeBatchInput,
  autosnippet_save_document: SaveDocumentInput,
  autosnippet_skill: SkillInput,
  autosnippet_bootstrap: BootstrapInput,
  autosnippet_dimension_complete: DimensionCompleteInput,
  autosnippet_wiki_plan: WikiPlanInput,
  autosnippet_wiki_finalize: WikiFinalizeInput,
  autosnippet_capabilities: CapabilitiesInput,
  autosnippet_task: TaskInput,
  autosnippet_enrich_candidates: EnrichCandidatesInput,
  autosnippet_knowledge_lifecycle: KnowledgeLifecycleInput,
  autosnippet_validate_candidate: ValidateCandidateInput,
  autosnippet_check_duplicate: CheckDuplicateInput,
};
