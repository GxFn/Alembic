/**
 * KnowledgeEntry 领域层统一导出
 */

// 实体
export { KnowledgeEntry } from './KnowledgeEntry.js';
// Repository 接口
export { KnowledgeRepository } from './KnowledgeRepository.js';
// 生命周期
export {
  CANDIDATE_STATES,
  inferKind,
  isCandidate,
  isValidLifecycle,
  isValidTransition,
  Lifecycle,
} from './Lifecycle.js';
export { Constraints } from './values/Constraints.js';
// 值对象
export { Content } from './values/Content.js';
export { Quality } from './values/Quality.js';
export { Reasoning } from './values/Reasoning.js';
export { RELATION_BUCKETS, Relations } from './values/Relations.js';
export { Stats } from './values/Stats.js';
