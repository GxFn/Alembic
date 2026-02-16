export interface Snippet {
  identifier: string;
  title: string;
  completionKey: string;
  summary: string;
  category?: string;
  language: string;
  content: string[];
  body?: string[];
  headers?: string[];
  /** 每条 header 相对于 target 根目录的路径，用于 // as:include <M/H.h> [path] */
  headerPaths?: string[];
  /** target/模块名，用于角括号格式 // as:include <TargetName/Header.h> */
  moduleName?: string;
  includeHeaders?: boolean;
  link?: string;
}

export interface RecipeStats {
  authority: number;
  guardUsageCount: number;
  humanUsageCount: number;
  aiUsageCount: number;
  lastUsedAt: string | null;
  authorityScore: number;
}

/** Recipe 结构化内容（API 返回对象形式时） */
export interface RecipeContent {
  pattern?: string;
  markdown?: string;
  rationale?: string;
  steps?: Array<string | { title?: string; description?: string; code?: string }>;
  codeChanges?: Array<{ file: string; before: string; after: string; explanation: string }>;
  verification?: { method?: string; expectedResult?: string; testCode?: string } | null;
}

export interface Recipe {
  id?: string;
  name: string;
  trigger?: string;
  content: string;
  category?: string;
  language?: string;
  description?: string;
  status?: string;
  kind?: 'rule' | 'pattern' | 'fact';
  metadata?: any;
  /** 使用统计与权威分（来自 recipe-stats.json） */
  stats?: RecipeStats | null;
  // ── V2 structured fields (passed through by v1-compat) ──
  knowledgeType?: string;
  v2Content?: {
    pattern?: string;
    rationale?: string;
    steps?: Array<{ title?: string; description?: string; code?: string }>;
    codeChanges?: Array<{ file: string; before: string; after: string; explanation: string }>;
    verification?: { method?: string; expectedResult?: string; testCode?: string } | null;
    markdown?: string;
  } | null;
  relations?: Record<string, any[]> | null;
  constraints?: {
    guards?: Array<{ pattern: string; severity: string; message?: string }>;
    boundaries?: string[];
    preconditions?: string[];
    sideEffects?: string[];
  } | null;
  tags?: string[];
  /** 使用指南 */
  usageGuide?: string;
  usageGuide_cn?: string;
  usageGuide_en?: string;
  /** 来源信息 */
  source?: string;
  source_file?: string;
  module_name?: string;
  /** V3 直接字段 */
  scope?: string;
  complexity?: string;
  difficulty?: string;
  version?: string;
  headers?: string[];
  updatedAt?: string | number | null;
}

export interface ProjectData {
  rootSpec: {
  list: Snippet[];
  recipes?: {
    dir: string;
  };
  };
  recipes: Recipe[];
  /** V3: 按 category 分组的知识条目 */
  candidates: Record<string, {
  targetName: string;
  scanTime: number;
  items: KnowledgeEntry[];
  }>;
  projectRoot: string;
  watcherStatus?: string;
  /** 当前使用的 AI 提供商与模型（供 UI 展示） */
  aiConfig?: { provider: string; model: string };
}

export interface SPMTarget {
  name: string;
  packageName: string;
  packagePath: string;
  targetDir: string;
  info: any;
}

export interface ExtractedRecipe {
  title: string;
  summary: string;
  summary_cn?: string;
  summary_en?: string;
  trigger: string;
  category?: string;
  language: string;
  code: string;
  usageGuide: string;
  usageGuide_cn?: string;
  usageGuide_en?: string;
  headers?: string[];
  /** 每条 header 相对于 target 根目录的路径，与 create/headName 一致，用于 // as:include <M/H.h> [path] */
  headerPaths?: string[];
  /** target/模块名，用于角括号格式 // as:include <TargetName/Header.h> */
  moduleName?: string;
  /** 是否引入头文件：true 时 snippet 内写入 // as:include 标记，watch 按标记注入依赖 */
  includeHeaders?: boolean;
  /** 难度等级：beginner / intermediate / advanced */
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  /** 权威分 1～5，审核人员可设置初始值 */
  authority?: number;
  /** 知识类型 */
  knowledgeType?: 'code-pattern' | 'architecture' | 'best-practice' | 'rule';
  /** 复杂度 */
  complexity?: 'beginner' | 'intermediate' | 'advanced';
  /** 适用范围 */
  scope?: 'universal' | 'project-specific' | 'target-specific';
  /** 设计原理（英文） */
  rationale?: string;
  /** 实施步骤 */
  steps?: string[];
  /** 前置条件 */
  preconditions?: string[];
  /** 质量评分 (0-1) */
  qualityScore?: number;
  /** 质量等级 (A-F) */
  qualityGrade?: string;
  /** 自由标签 */
  tags?: string[];
  /** 版本号 */
  version?: string;
  /** 更新时间戳（毫秒） */
  updatedAt?: number;
}

// ── V2 Candidate 类型已删除 — 前端统一使用 V3 KnowledgeEntry ──

/** Guard 审计摘要（全项目扫描返回） */
export interface GuardAuditSummary {
  totalFiles: number;
  totalViolations: number;
  errors: number;
  warnings: number;
}

/* ═══════════════════════════════════════════
 *  V3 Knowledge Entry — 统一知识实体
 * ═══════════════════════════════════════════ */

export type KnowledgeLifecycle = 'pending' | 'active' | 'deprecated';
export type KnowledgeKind = 'rule' | 'pattern' | 'fact';

export interface KnowledgeContent {
  pattern?: string;
  markdown?: string;
  rationale?: string;
  steps?: Array<{ title?: string; description?: string; code?: string }>;
  code_changes?: Array<{ file: string; before: string; after: string; explanation: string }>;
  verification?: { method?: string; expected_result?: string; test_code?: string } | null;
}

export interface KnowledgeReasoning {
  why_standard: string;
  sources: string[];
  confidence: number;
  quality_signals?: Record<string, unknown>;
  alternatives?: string[];
}

export interface KnowledgeQuality {
  completeness: number;
  adaptation: number;
  documentation: number;
  overall: number;
  grade: string;
}

export interface KnowledgeStats {
  views: number;
  adoptions: number;
  applications: number;
  guard_hits: number;
  search_hits: number;
  authority: number;
}

export interface KnowledgeConstraints {
  guards?: Array<{ id?: string; type?: string; pattern: string; severity: string; message?: string; fix_suggestion?: string }>;
  boundaries?: string[];
  preconditions?: string[];
  side_effects?: string[];
}

export interface KnowledgeRelations {
  inherits?: Array<{ target: string; description?: string }>;
  extends?: Array<{ target: string; description?: string }>;
  depends_on?: Array<{ target: string; description?: string }>;
  conflicts?: Array<{ target: string; description?: string }>;
  related?: Array<{ target: string; description?: string }>;
  implements?: Array<{ target: string; description?: string }>;
  calls?: Array<{ target: string; description?: string }>;
  data_flow?: Array<{ target: string; description?: string }>;
  [key: string]: Array<{ target: string; description?: string }> | undefined;
}

/** V3 统一知识条目（API 返回的 wire format） */
export interface KnowledgeEntry {
  id: string;
  title: string;
  trigger: string;
  description: string;
  lifecycle: KnowledgeLifecycle;
  lifecycle_history?: Array<{ from: string; to: string; at: number; by: string }>;
  auto_approvable?: boolean;
  language: string;
  category: string;
  kind: KnowledgeKind;
  knowledge_type: string;
  complexity: string;
  scope?: string;
  difficulty?: string;
  tags: string[];
  summary_cn?: string;
  summary_en?: string;
  usage_guide_cn?: string;
  usage_guide_en?: string;
  content: KnowledgeContent;
  relations: KnowledgeRelations;
  constraints: KnowledgeConstraints;
  reasoning: KnowledgeReasoning;
  quality: KnowledgeQuality;
  stats: KnowledgeStats;
  headers: string[];
  header_paths?: string[];
  module_name?: string;
  include_headers?: boolean;
  agent_notes?: string[] | null;
  ai_insight?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: number | null;
  rejection_reason?: string | null;
  source: string;
  source_file?: string | null;
  source_candidate_id?: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  published_at?: number | null;
  published_by?: string | null;
}

/** 知识条目列表分页响应 */
export interface KnowledgePaginatedResponse {
  data: KnowledgeEntry[];
  pagination: { page: number; pageSize: number; total: number };
}

/** 知识条目统计（后端返回扁平 key） */
export interface KnowledgeStatsResponse {
  total: number;
  pending: number;
  active: number;
  deprecated: number;
  rules: number;
  patterns: number;
  facts: number;
  [key: string]: number;  // 允许按 key 索引
}

/** 相似 Recipe 条目 */
export interface SimilarRecipe {
  recipeName: string;
  similarity: number;
}

export interface GuardAuditResult {
  summary: GuardAuditSummary;
  files?: Array<{
    filePath: string;
    violations: Array<{ rule: string; severity: string; message: string; line?: number }>;
    summary: { errors: number; warnings: number };
  }>;
}

/**
 * 审核页面使用的条目类型 — 基于 V3 KnowledgeEntry 扩展审核专用字段。
 * 从候选页进入审核时直接传入 KnowledgeEntry，仅需补充 mode/lang 等审核控制字段。
 * 从 SPM Target 扫描时由后端返回的 ExtractedRecipe 数据映射而来。
 */
export type ScanResultItem = Partial<KnowledgeEntry> & {
  /** 保存模式：full = Snippet+Recipe，preview = Recipe Only */
  mode: 'full' | 'preview';
  /** 当前显示语言：cn / en */
  lang: 'cn' | 'en';
  /** 来源场景：target 扫描 / 全项目扫描 */
  scanMode?: 'target' | 'project';
  /** 关联的候选 target 名称 */
  candidateTargetName?: string;
  /** 关联的候选 ID（= KnowledgeEntry.id，保存后用于从候选池移除） */
  candidateId?: string;
  /** ─── 以下为遗留 SPM 扫描兼容字段 ─── */
  /** 合并后的当前语言摘要（由 lang 切换） */
  summary?: string;
  /** 合并后的当前语言使用指南（由 lang 切换） */
  usageGuide?: string;
  usageGuide_cn?: string;
  usageGuide_en?: string;
  /** 代码（SPM 扫描产出，V3 对应 content.pattern） */
  code?: string;
  /** 头文件列表（SPM 扫描产出，V3 已有 headers） */
  headers?: string[];
  /** target/模块名 */
  moduleName?: string;
  /** 是否引入头文件 */
  includeHeaders?: boolean;
  /** 难度 */
  difficulty?: string;
  /** 权威分 1-5 */
  authority?: number;
  /** 知识类型（旧） */
  knowledgeType?: string;
  /** 适用范围（旧） */
  scope?: string;
  /** 标签 */
  tags?: string[];
  /** 设计原理 */
  rationale?: string;
  /** 实施步骤 */
  steps?: string[];
  /** 前置条件 */
  preconditions?: string[];
};
