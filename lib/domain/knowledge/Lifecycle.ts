/**
 * Lifecycle — 知识实体生命周期状态机（3 状态简化版）
 *
 * pending    — 待审核（所有新条目初始状态）
 * active     — 已发布（可被搜索/Guard/Export 消费）
 * deprecated — 已废弃
 */

export const Lifecycle = {
  /** 待审核 */
  PENDING: 'pending',
  /** 已发布（可被搜索/Guard/Export 消费） */
  ACTIVE: 'active',
  /** 已弃用 */
  DEPRECATED: 'deprecated',
};

/** 候选阶段的所有状态 */
export const CANDIDATE_STATES = [Lifecycle.PENDING];

/** 合法状态转移表 */
const VALID_TRANSITIONS = {
  [Lifecycle.PENDING]: [Lifecycle.ACTIVE, Lifecycle.DEPRECATED],
  [Lifecycle.ACTIVE]: [Lifecycle.DEPRECATED],
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

/** 是否处于候选阶段（待审核） */
export function isCandidate(lifecycle: string): boolean {
  const normalized = normalizeLifecycle(lifecycle);
  return normalized === Lifecycle.PENDING;
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
