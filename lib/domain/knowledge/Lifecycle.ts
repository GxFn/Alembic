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

/** 合法状态转移表 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  [Lifecycle.PENDING]: [Lifecycle.STAGING, Lifecycle.ACTIVE, Lifecycle.DEPRECATED],
  [Lifecycle.STAGING]: [Lifecycle.ACTIVE, Lifecycle.PENDING],
  [Lifecycle.ACTIVE]: [Lifecycle.EVOLVING, Lifecycle.DECAYING, Lifecycle.DEPRECATED],
  [Lifecycle.EVOLVING]: [Lifecycle.ACTIVE, Lifecycle.DECAYING],
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
