/**
 * evolution.ts — Evolution 系统类型定义
 *
 * 包含 ContentPatcher / RecipeLifecycleSupervisor / 结构化 suggestedChanges 的类型。
 */

/* ═══════════════════ Structured Patch ═══════════════════ */

/** suggestedChanges 中每项变更操作 */
export interface PatchChange {
  /** 目标字段路径（如 'content.markdown', 'coreCode', 'doClause'） */
  field: string;
  /** 操作类型 */
  action: 'replace' | 'replace-section' | 'append';
  /** 新值（replace / append 时必填） */
  newValue?: string;
  /** 目标 section 标题（replace-section 时必填） */
  section?: string;
  /** 新 section 内容（replace-section 时必填） */
  newContent?: string;
}

/** 结构化 suggestedChanges 格式（Agent 输出） */
export interface StructuredPatch {
  patchVersion: number;
  changes: PatchChange[];
  reasoning: string;
}

/* ═══════════════════ ContentPatcher ═══════════════════ */

/** Recipe 内容快照 */
export interface RecipeContentSnapshot {
  coreCode: string;
  doClause: string;
  dontClause: string;
  whenClause: string;
  content: { markdown?: string; rationale?: string };
  sourceRefs: string[];
  headers: string[];
}

/** ContentPatcher 应用结果 */
export interface ContentPatchResult {
  success: boolean;
  recipeId: string;
  fieldsPatched: string[];
  beforeSnapshot: RecipeContentSnapshot;
  afterSnapshot: RecipeContentSnapshot;
  patchSource: 'agent-suggestion' | 'correction' | 'merge';
  skipped: boolean;
  skipReason?: string;
}

/* ═══════════════════ Lifecycle Supervisor ═══════════════════ */

/** 状态转移触发类型 */
export type TransitionTrigger =
  | 'confidence-route'
  | 'grace-period-expire'
  | 'guard-conflict'
  | 'proposal-execution'
  | 'proposal-attach'
  | 'content-patch-complete'
  | 'decay-detection'
  | 'manual-deprecation'
  | 'evolution-gateway'
  | 'timeout-recovery'
  | 'evidence-recovery'
  | 'resurrection';

/** 状态转移证据 */
export interface TransitionEvidence {
  decayScore?: number;
  fpRate?: number;
  usageCount?: number;
  suggestedChanges?: string;
  patchResult?: ContentPatchResult;
  reason: string;
}

/** 状态转移请求 */
export interface TransitionRequest {
  recipeId: string;
  targetState: string;
  trigger: TransitionTrigger;
  evidence?: TransitionEvidence;
  proposalId?: string;
  operatorId?: string;
}

/** 状态转移事件（不可变记录） */
export interface TransitionEvent {
  id: string;
  recipeId: string;
  fromState: string;
  toState: string;
  trigger: TransitionTrigger;
  evidence: TransitionEvidence | null;
  proposalId: string | null;
  operatorId: string;
  createdAt: number;
}

/** 状态转移结果 */
export interface TransitionResult {
  success: boolean;
  fromState: string;
  toState: string;
  event?: TransitionEvent;
  error?: string;
}

/** 超时检查结果 */
export interface TimeoutCheckResult {
  timedOut: { recipeId: string; fromState: string; toState: string; age: number }[];
  checked: number;
}

/** 生命周期健康摘要 */
export interface LifecycleHealthSummary {
  stateDistribution: Record<string, number>;
  intermediateStates: {
    stuckEvolving: { count: number; oldestAge: number };
    stuckDecaying: { count: number; oldestAge: number };
    stuckStaging: { count: number; oldestAge: number };
    stuckPending: { count: number; oldestAge: number };
  };
  recentTransitions: {
    last24h: number;
    last7d: number;
    topTriggers: { trigger: string; count: number }[];
  };
  proposalMetrics: {
    pendingCount: number;
    observingCount: number;
    executionRate: number;
    avgObservationDays: number;
    contentPatchRate: number;
  };
}
