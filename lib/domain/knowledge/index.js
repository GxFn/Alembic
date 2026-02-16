/**
 * KnowledgeEntry 领域层统一导出
 */

// 实体
export { KnowledgeEntry } from './KnowledgeEntry.js';

// 生命周期
export {
  Lifecycle,
  isValidTransition,
  isValidLifecycle,
  isCandidate,
  CANDIDATE_STATES,
  inferKind,
} from './Lifecycle.js';

// 值对象
export { Content } from './values/Content.js';
export { Relations, RELATION_BUCKETS } from './values/Relations.js';
export { Constraints } from './values/Constraints.js';
export { Reasoning } from './values/Reasoning.js';
export { Quality } from './values/Quality.js';
export { Stats } from './values/Stats.js';

// Repository 接口
export { KnowledgeRepository } from './KnowledgeRepository.js';
