/**
 * Domain 层索引
 * 导出所有实体、值对象和仓储接口
 */

// Knowledge 统一知识实体 (V3)
export {
  KnowledgeEntry,
  Lifecycle,
  isValidTransition,
  isValidLifecycle,
  isCandidate as isLifecycleCandidate,
  CANDIDATE_STATES,
  inferKind as inferKindV3,
} from './knowledge/index.js';
export { Content } from './knowledge/values/Content.js';
export { Relations, RELATION_BUCKETS, RELATION_BUCKETS as RelationType } from './knowledge/values/Relations.js';
export { Constraints } from './knowledge/values/Constraints.js';
export { Reasoning as ReasoningV3 } from './knowledge/values/Reasoning.js';
export { Quality } from './knowledge/values/Quality.js';
export { Stats } from './knowledge/values/Stats.js';
export { KnowledgeRepository } from './knowledge/KnowledgeRepository.js';

// Snippet 相关
export { Snippet } from './snippet/Snippet.js';
