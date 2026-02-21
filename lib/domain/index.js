/**
 * Domain 层索引
 * 导出所有实体、值对象和仓储接口
 */

// Knowledge 统一知识实体 (V3)
export {
  CANDIDATE_STATES,
  inferKind as inferKindV3,
  isCandidate as isLifecycleCandidate,
  isValidLifecycle,
  isValidTransition,
  KnowledgeEntry,
  Lifecycle,
} from './knowledge/index.js';
export { KnowledgeRepository } from './knowledge/KnowledgeRepository.js';
export { Constraints } from './knowledge/values/Constraints.js';
export { Content } from './knowledge/values/Content.js';
export { Quality } from './knowledge/values/Quality.js';
export { Reasoning as ReasoningV3 } from './knowledge/values/Reasoning.js';
export {
  RELATION_BUCKETS,
  RELATION_BUCKETS as RelationType,
  Relations,
} from './knowledge/values/Relations.js';
export { Stats } from './knowledge/values/Stats.js';

// Snippet 相关
export { Snippet } from './snippet/Snippet.js';
