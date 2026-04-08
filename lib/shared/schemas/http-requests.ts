/**
 * http-requests.ts — HTTP 路由请求 Zod Schemas
 *
 * 为 Express 路由提供运行时输入校验，覆盖：
 *   - knowledge（CRUD + 生命周期）
 *   - guardRules（规则管理 + 批量操作）
 *   - search（统合搜索 + 上下文搜索）
 *   - candidates（候选条目操作）
 *   - guard（文件质量检查）
 *   - skills（技能管理）
 *   - task（统一任务分发）
 *   - modules（模块扫描）
 *   - ai（AI 配置、摘要、翻译、对话、Agent 工具/任务）
 *   - extract（路径/文本提取）
 *   - auth（登录）
 *   - commands（文件读写）
 *   - remote（远程指令、通知）
 *
 * @module shared/schemas/http-requests
 */

import { z } from 'zod';

// ─── 复用基础片段 ─────────────────────────────

/** Id + limit 分页共用 */
const MAX_BATCH_SIZE = 100;

const BatchIds = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_BATCH_SIZE),
});

const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(20),
});

// ═══ Knowledge ═══════════════════════════════════

export const CreateKnowledgeBody = z.object({
  title: z.string().min(1, 'title is required'),
  content: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
  description: z.string().optional(),
  kind: z.enum(['rule', 'pattern', 'fact']).optional(),
  language: z.string().optional(),
  category: z.string().optional(),
  knowledgeType: z.string().optional(),
  complexity: z.enum(['basic', 'intermediate', 'advanced']).optional(),
  scope: z.enum(['universal', 'project', 'team', 'personal']).optional(),
  tags: z.array(z.string()).optional(),
});

export const UpdateKnowledgeBody = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    content: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    kind: z.enum(['rule', 'pattern', 'fact']).optional(),
    language: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  });

export const DeprecateKnowledgeBody = z.object({
  reason: z.string().min(1, 'reason is required'),
});

export const BatchPublishBody = BatchIds;

export const BatchDeleteBody = BatchIds;

export const BatchDeprecateBody = BatchIds.extend({
  reason: z.string().optional(),
});

export const KnowledgeUsageBody = z.object({
  type: z.enum(['adoption', 'view', 'feedback']).default('adoption'),
  feedback: z.unknown().optional(),
});

export const KnowledgeListQuery = PaginationQuery.extend({
  lifecycle: z.string().optional(),
  kind: z.string().optional(),
  category: z.string().optional(),
  language: z.string().optional(),
  knowledgeType: z.string().optional(),
  scope: z.string().optional(),
  keyword: z.string().optional(),
  tag: z.string().optional(),
  source: z.string().optional(),
});

// ═══ Guard Rules ═════════════════════════════════

export const CreateGuardRuleBody = z
  .object({
    name: z.string().min(1).optional(),
    ruleId: z.string().min(1).optional(),
    description: z.string().optional(),
    message: z.string().optional(),
    pattern: z.string().min(1, 'pattern is required'),
    severity: z.enum(['error', 'warning', 'info']).default('warning'),
    category: z.string().optional(),
    sourceRecipeId: z.string().optional(),
    sourceReason: z.string().optional(),
    note: z.string().optional(),
    languages: z.array(z.string()).optional(),
    dimension: z.string().optional(),
  })
  .refine((data) => data.name || data.ruleId, {
    message: 'Either name or ruleId is required',
  });

export const BatchEnableBody = BatchIds;

export const BatchDisableBody = BatchIds.extend({
  reason: z.string().optional(),
});

export const DisableRuleBody = z.object({
  reason: z.string().optional(),
});

export const CheckCodeBody = z.object({
  code: z.string().min(1, 'code is required'),
  language: z.string().optional(),
  ruleIds: z.array(z.string()).optional(),
});

export const ImportFromRecipeBody = z.object({
  recipeId: z.string().min(1, 'recipeId is required'),
  rules: z.array(z.record(z.string(), z.unknown())).min(1, 'rules array must not be empty'),
});

export const GuardRulesListQuery = PaginationQuery.extend({
  severity: z.string().optional(),
  category: z.string().optional(),
  sourceRecipe: z.string().optional(),
  keyword: z.string().optional(),
  enabled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const ComplianceQuery = z.object({
  path: z.string().optional(),
  maxErrors: z.coerce.number().int().min(0).default(0),
  maxWarnings: z.coerce.number().int().min(0).default(20),
  minScore: z.coerce.number().int().min(0).max(100).default(70),
  maxFiles: z.coerce.number().int().min(1).max(10000).default(500),
});

// ═══ Search ══════════════════════════════════════

export const SearchQuery = PaginationQuery.extend({
  q: z.string().min(1, 'search query is required'),
  type: z.enum(['all', 'recipe', 'solution', 'rule', 'candidate']).default('all'),
  mode: z.enum(['keyword', 'bm25', 'semantic']).default('keyword'),
  groupByKind: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const ContextAwareSearchBody = z.object({
  keyword: z.string().min(1, 'keyword is required'),
  limit: z.number().int().min(1).max(100).default(10),
  language: z.string().optional(),
  sessionHistory: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const SimilarityBody = z.object({
  code: z.string().optional(),
  targetName: z.string().optional(),
  candidateId: z.string().optional(),
  candidate: z
    .object({
      title: z.string().optional(),
      summary: z.string().optional(),
      code: z.string().optional(),
      pattern: z.string().optional(),
      usageGuide: z.string().optional(),
      markdown: z.string().optional(),
    })
    .optional(),
});

// ═══ Candidates ══════════════════════════════════

export const EnrichBody = z.object({
  candidateIds: z.array(z.string().min(1)).min(1).max(20),
});

export const BootstrapRefineBody = z.object({
  candidateIds: z.array(z.string().min(1)).optional(),
  userPrompt: z.string().optional(),
  dryRun: z.boolean().default(false),
});

export const RefinePreviewBody = z.object({
  candidateId: z.string().min(1, 'candidateId is required'),
  userPrompt: z.string().min(1, 'userPrompt is required'),
});

export const RefineApplyBody = z.object({
  candidateId: z.string().min(1, 'candidateId is required'),
  userPrompt: z.string().optional(),
  preview: z.record(z.string(), z.unknown()).optional(),
});

// ═══ Guard (file check) ══════════════════════════

export const GuardFileBody = z.object({
  filePath: z.string().min(1, 'filePath is required'),
  content: z.string().optional(),
  language: z.string().optional(),
});

export const GuardBatchBody = z.object({
  files: z
    .array(
      z.object({
        filePath: z.string().min(1),
        content: z.string().optional(),
        language: z.string().optional(),
      })
    )
    .min(1, 'files array must not be empty')
    .max(50, 'maximum 50 files per batch'),
});

// ═══ Skills ══════════════════════════════════════

export const CreateSkillBody = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().min(1, 'description is required'),
  content: z.string().min(1, 'content is required'),
  overwrite: z.boolean().default(false),
  createdBy: z.string().default('manual'),
});

export const UpdateSkillBody = z
  .object({
    description: z.string().optional(),
    content: z.string().optional(),
  })
  .refine((data) => data.description || data.content, {
    message: 'At least one of description or content must be provided',
  });

// ═══ Task (unified dispatch) ═════════════════════

export const TaskDispatchBody = z
  .object({
    operation: z.string().min(1, 'operation is required'),
    // 各操作的参数透传为 passthrough（具体校验在 handler 中）
  })
  .passthrough();

// ═══ Modules ═════════════════════════════════════

export const ScanFolderBody = z.object({
  path: z.string().min(1, 'path is required'),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const ScanTargetBody = z
  .object({
    target: z.record(z.string(), z.unknown()).optional(),
    targetName: z.string().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((data) => data.target || data.targetName, {
    message: 'Either target or targetName is required',
  });

export const ScanProjectBody = z.object({
  options: z.record(z.string(), z.unknown()).optional(),
});

export const ModuleBootstrapBody = z.object({
  maxFiles: z.number().int().min(1).max(10000).default(500),
  skipGuard: z.boolean().default(false),
  contentMaxLines: z.number().int().min(1).max(10000).default(120),
});

export const ModuleRescanBody = z.object({
  reason: z.string().optional(),
  dimensions: z.array(z.string()).optional(),
});

// ═══ Graph Search ════════════════════════════════

export const GraphQuery = z.object({
  nodeId: z.string().min(1, 'nodeId is required'),
  nodeType: z.string().min(1, 'nodeType is required'),
  relation: z.string().optional(),
  direction: z.enum(['both', 'in', 'out']).default('both'),
});

export const GraphImpactQuery = z.object({
  nodeId: z.string().min(1, 'nodeId is required'),
  nodeType: z.string().min(1, 'nodeType is required'),
  maxDepth: z.coerce.number().int().min(1).max(5).default(3),
});

// ═══ AI Routes ═══════════════════════════════════

export const AiLangBody = z.object({
  lang: z.enum(['zh', 'en'], { message: 'lang must be "zh" or "en"' }),
});

export const AiConfigBody = z.object({
  provider: z.string().min(1, 'provider is required'),
  model: z.string().optional(),
});

export const AiSummarizeBody = z.object({
  code: z.string().min(1, 'code is required'),
  language: z.string().optional(),
});

export const AiTranslateBody = z.object({
  summary: z.string().optional(),
  usageGuide: z.string().optional(),
});

export const AiChatBody = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  history: z.array(z.record(z.string(), z.unknown())).default([]),
  lang: z.string().optional(),
  conversationId: z.string().optional(),
  sseSessionId: z.string().optional(),
});

export const AiStreamBody = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  history: z.array(z.record(z.string(), z.unknown())).default([]),
  lang: z.string().optional(),
});

export const AiToolBody = z.object({
  tool: z.string().min(1, 'tool name is required'),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const AiTaskBody = z.object({
  task: z.string().min(1, 'task name is required'),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const AiFormatUsageGuideBody = z.object({
  text: z.string().optional(),
});

export const AiEnvConfigBody = z.object({
  provider: z.string().min(1, 'provider is required'),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  proxy: z.string().optional(),
});

// ═══ Extract Routes ══════════════════════════════

export const ExtractPathBody = z.object({
  relativePath: z.string().min(1, 'relativePath is required'),
  projectRoot: z.string().optional(),
});

export const ExtractTextBody = z.object({
  text: z.string().min(1, 'text is required'),
  language: z.string().optional(),
  relativePath: z.string().optional(),
  projectRoot: z.string().optional(),
});

// ═══ Auth Routes ═════════════════════════════════

export const AuthLoginBody = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(1, '密码不能为空'),
});

// ═══ Commands Routes ═════════════════════════════

export const FileReadQuery = z.object({
  path: z.string().min(1, 'path is required'),
});

export const FileSaveBody = z.object({
  path: z.string().min(1, 'path is required'),
  content: z.string({ message: 'content is required' }),
});

// ═══ Wiki Routes ═════════════════════════════════

/* Wiki validation stays as inline path-param check (wildcard route) */

// ═══ Remote Routes ═══════════════════════════════

export const RemoteSendBody = z.object({
  command: z
    .string()
    .min(1, 'command is required')
    .transform((s) => s.trim()),
});

export const RemoteNotifyBody = z.object({
  text: z
    .string()
    .min(1, 'text is required')
    .transform((s) => s.trim()),
});

export const RemoteResultBody = z.object({
  result: z.string().optional(),
  status: z.string().default('completed'),
});

export const RemoteHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
