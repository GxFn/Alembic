/** KnowledgeEntry 领域层统一导出 */

// 实体
export { KnowledgeEntry } from './KnowledgeEntry.js';
// Repository 接口
export { KnowledgeRepository } from './KnowledgeRepository.js';
export type { LifecycleFilter } from './Lifecycle.js';
// 生命周期
export {
  CANDIDATE_LIFECYCLES,
  CANDIDATE_STATES,
  CONSUMABLE_LIFECYCLES,
  CONSUMABLE_STATES,
  COUNTABLE_LIFECYCLES,
  DEGRADED_STATES,
  GUARD_LIFECYCLES,
  inferKind,
  isCandidate,
  isConsumable,
  isDegraded,
  isValidLifecycle,
  isValidTransition,
  Lifecycle,
  lifecycleInSql,
  NON_DEPRECATED_LIFECYCLES,
  PUBLISHED_LIFECYCLES,
} from './Lifecycle.js';
export { Constraints } from './values/Constraints.js';
// 值对象
export { Content } from './values/Content.js';
export { Quality } from './values/Quality.js';
export { Reasoning } from './values/Reasoning.js';
export { RELATION_BUCKETS, Relations } from './values/Relations.js';
export { Stats } from './values/Stats.js';
