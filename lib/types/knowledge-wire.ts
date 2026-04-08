/**
 * §10.1 KnowledgeEntryWire — 统一的知识条目传输合约
 *
 * 这是后端 KnowledgeEntry.toJSON() 和前端 Dashboard 共享的唯一类型定义。
 * 所有 API 层传输都使用此形状，消除后端 class 与前端 interface 的字段漂移。
 */

// ──────────────────────────────────────────────────────────────────
// 枚举类型
// ──────────────────────────────────────────────────────────────────

export type KnowledgeLifecycle =
  | 'pending'
  | 'staging'
  | 'active'
  | 'evolving'
  | 'decaying'
  | 'deprecated';
export type KnowledgeKind = 'rule' | 'pattern' | 'fact';

// ──────────────────────────────────────────────────────────────────
// 子对象 Wire Format
// ──────────────────────────────────────────────────────────────────

export interface KnowledgeContentWire {
  pattern: string;
  markdown: string;
  rationale: string;
  steps: Array<{ title?: string; description?: string; code?: string }>;
  codeChanges: Array<{ file: string; before: string; after: string; explanation: string }>;
  verification: { method?: string; expectedResult?: string; testCode?: string } | null;
}

export interface KnowledgeReasoningWire {
  whyStandard: string;
  sources: string[];
  confidence: number;
  qualitySignals: Record<string, unknown>;
  alternatives: string[];
}

export interface KnowledgeQualityWire {
  completeness: number;
  adaptation: number;
  documentation: number;
  overall: number;
  grade: string;
}

export interface KnowledgeStatsWire {
  views: number;
  adoptions: number;
  applications: number;
  guardHits: number;
  searchHits: number;
  authority: number;
  lastHitAt: number | null;
  lastSearchedAt: number | null;
  lastGuardHitAt: number | null;
  hitsLast30d: number;
  hitsLast90d: number;
  searchHitsLast30d: number;
  version: number;
  ruleFalsePositiveRate: number | null;
}

export interface KnowledgeConstraintsWire {
  guards: Array<{
    id?: string | null;
    type?: string;
    pattern: string | null;
    severity: string;
    message?: string;
    fixSuggestion?: string;
  }>;
  boundaries: string[];
  preconditions: string[];
  sideEffects: string[];
}

export interface KnowledgeRelationEntry {
  target: string;
  description?: string;
}

export interface KnowledgeRelationsWire {
  [bucket: string]: KnowledgeRelationEntry[];
}

// ──────────────────────────────────────────────────────────────────
// 主 Wire Format
// ──────────────────────────────────────────────────────────────────

/** 后端 → 前端 / API 传输的唯一合约 */
export interface KnowledgeEntryWire {
  // ── 标识 ──
  id: string;
  title: string;
  description: string;

  // ── 生命周期 ──
  lifecycle: string;
  lifecycleHistory: Array<{ from: string; to: string; at: number }>;
  autoApprovable: boolean;

  // ── 分类 ──
  language: string;
  category: string;
  kind: string;
  knowledgeType: string;
  complexity: string;
  scope: string;
  difficulty: string | null;
  tags: string[];

  // ── Delivery 字段 ──
  trigger: string;
  topicHint: string;
  whenClause: string;
  doClause: string;
  dontClause: string;
  coreCode: string;
  usageGuide: string;

  // ── 结构化子对象 ──
  content: KnowledgeContentWire;
  relations: KnowledgeRelationsWire;
  constraints: KnowledgeConstraintsWire;
  reasoning: KnowledgeReasoningWire;
  quality: KnowledgeQualityWire;
  stats: KnowledgeStatsWire;

  // ── 代码头文件 ──
  headers: string[];
  headerPaths: string[];
  moduleName: string;
  includeHeaders: boolean;

  // ── AI ──
  agentNotes: string | null;
  aiInsight: string | null;

  // ── 审核 ──
  reviewedBy: string | null;
  reviewedAt: number | null;
  rejectionReason: string | null;

  // ── 来源 ──
  source: string;
  sourceFile: string | null;
  sourceCandidateId: string | null;

  // ── 时间戳 ──
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  publishedBy: string | null;

  // Record<string, unknown> compat — allows `as Record<string, unknown>` casts
  [key: string]: unknown;
}
