/**
 * Lifecycle — 知识实体生命周期状态机（六态版）
 *
 * pending    — 待审核（所有新条目初始状态）
 * staging    — 暂存期（高置信度，Grace Period 后自动 active）
 * active     — 已发布（可被搜索/Guard/Export 消费）
 * evolving   — 进化中（有 EvolutionProposal 附着，内容待更新）
 * decaying   — 衰退观察（30d Grace + 3x 确认后 deprecated）
 * deprecated — 已废弃
 */

export const Lifecycle = {
  /** 待审核 */
  PENDING: 'pending',
  /** 暂存期（高置信度，Grace Period 后自动 active） */
  STAGING: 'staging',
  /** 已发布（可被搜索/Guard/Export 消费） */
  ACTIVE: 'active',
  /** 进化中（有 EvolutionProposal 附着） */
  EVOLVING: 'evolving',
  /** 衰退观察期 */
  DECAYING: 'decaying',
  /** 已弃用 */
  DEPRECATED: 'deprecated',
};

/** 候选阶段的所有状态 */
export const CANDIDATE_STATES = [Lifecycle.PENDING, Lifecycle.STAGING];

/** 可消费状态（Guard/Search/Delivery 可使用的状态） */
export const CONSUMABLE_STATES = [Lifecycle.STAGING, Lifecycle.ACTIVE, Lifecycle.EVOLVING];

/** 降级消费状态（Guard violation 降为 warning，Search 降权） */
export const DEGRADED_STATES = [Lifecycle.DECAYING];

// ═══ 新增统一命名常量 ═══

/** 可消费状态（别名，与 CONSUMABLE_STATES 相同） */
export const CONSUMABLE_LIFECYCLES = CONSUMABLE_STATES;

/** 可计数状态: 全景/统计看板应纳入的 Recipe（含 PENDING） */
export const COUNTABLE_LIFECYCLES = [
  Lifecycle.ACTIVE,
  Lifecycle.STAGING,
  Lifecycle.PENDING,
  Lifecycle.EVOLVING,
] as const;

/** 候选状态（别名，与 CANDIDATE_STATES 相同） */
export const CANDIDATE_LIFECYCLES = CANDIDATE_STATES;

/** Guard 可消费状态（含降级 decaying）: Guard/Search 可匹配的全范围 */
export const GUARD_LIFECYCLES = [
  Lifecycle.STAGING,
  Lifecycle.ACTIVE,
  Lifecycle.EVOLVING,
  Lifecycle.DECAYING,
] as const;

/** 已发布状态: 通过置信度路由已确认的 Recipe */
export const PUBLISHED_LIFECYCLES = [Lifecycle.ACTIVE, Lifecycle.STAGING] as const;

/** 非弃用状态: 除 deprecated 外所有 */
export const NON_DEPRECATED_LIFECYCLES = [
  Lifecycle.PENDING,
  Lifecycle.STAGING,
  Lifecycle.ACTIVE,
  Lifecycle.EVOLVING,
  Lifecycle.DECAYING,
] as const;

/** 类型导出 */
export type LifecycleFilter = (typeof Lifecycle)[keyof typeof Lifecycle];

/** 合法状态转移表 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  [Lifecycle.PENDING]: [Lifecycle.STAGING, Lifecycle.ACTIVE, Lifecycle.DEPRECATED],
  [Lifecycle.STAGING]: [Lifecycle.ACTIVE, Lifecycle.PENDING],
  [Lifecycle.ACTIVE]: [Lifecycle.EVOLVING, Lifecycle.DECAYING, Lifecycle.DEPRECATED],
  [Lifecycle.EVOLVING]: [Lifecycle.STAGING, Lifecycle.ACTIVE, Lifecycle.DECAYING],
  [Lifecycle.DECAYING]: [Lifecycle.ACTIVE, Lifecycle.DEPRECATED],
  [Lifecycle.DEPRECATED]: [Lifecycle.PENDING],
};

/** 规范化生命周期值 */
export function normalizeLifecycle(lifecycle: string): string {
  if (Object.values(Lifecycle).includes(lifecycle)) {
    return lifecycle;
  }
  return Lifecycle.PENDING;
}

/** 检查状态转移是否合法 */
export function isValidTransition(from: string, to: string): boolean {
  const normalFrom = normalizeLifecycle(from);
  const normalTo = normalizeLifecycle(to);
  const allowed = VALID_TRANSITIONS[normalFrom];
  return Array.isArray(allowed) && allowed.includes(normalTo);
}

/** 是否为合法的生命周期值 */
export function isValidLifecycle(lifecycle: string): boolean {
  return Object.values(Lifecycle).includes(lifecycle);
}

/** 是否处于候选阶段（待审核或暂存） */
export function isCandidate(lifecycle: string): boolean {
  const normalized = normalizeLifecycle(lifecycle);
  return normalized === Lifecycle.PENDING || normalized === Lifecycle.STAGING;
}

/** 是否为可消费状态（Guard/Search/Delivery 可使用） */
export function isConsumable(lifecycle: string): boolean {
  const normalized = normalizeLifecycle(lifecycle);
  return CONSUMABLE_STATES.includes(normalized);
}

/** 是否为降级消费状态 */
export function isDegraded(lifecycle: string): boolean {
  const normalized = normalizeLifecycle(lifecycle);
  return DEGRADED_STATES.includes(normalized);
}

/* ── SQL 辅助函数 ── */

/**
 * 生成 `column IN (?, ?, ...)` SQL 片段和对应的参数数组。
 * 用于在 raw SQL 中安全引用 lifecycle 常量数组。
 *
 * @example
 * const { sql, params } = lifecycleInSql(COUNTABLE_LIFECYCLES);
 * db.prepare(`SELECT * FROM knowledge_entries WHERE ${sql}`).all(...params);
 */
export function lifecycleInSql(
  lifecycles: readonly string[],
  column = 'lifecycle'
): { sql: string; params: string[] } {
  const placeholders = lifecycles.map(() => '?').join(', ');
  return { sql: `${column} IN (${placeholders})`, params: [...lifecycles] };
}

/* ── knowledgeType → kind 映射 ── */

const KIND_MAP = {
  'code-standard': 'rule',
  'code-style': 'rule',
  'best-practice': 'rule',
  'boundary-constraint': 'rule',
  'code-pattern': 'pattern',
  architecture: 'pattern',
  solution: 'pattern',
  'anti-pattern': 'pattern',
  'code-relation': 'fact',
  inheritance: 'fact',
  'call-chain': 'fact',
  'data-flow': 'fact',
  'event-and-data-flow': 'fact',
  'module-dependency': 'fact',
  'dev-document': 'fact',
};

/** 从 knowledgeType 推导 kind */
export function inferKind(knowledgeType: string): 'rule' | 'pattern' | 'fact' {
  return ((KIND_MAP as Record<string, string>)[knowledgeType] || 'pattern') as
    | 'rule'
    | 'pattern'
    | 'fact';
}

export default Lifecycle;
