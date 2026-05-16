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
} from '@alembic/core/domain/knowledge';
export { KnowledgeRepository } from '@alembic/core/domain/knowledge/KnowledgeRepository';
export { Constraints } from '@alembic/core/domain/knowledge/values/Constraints';
export { Content } from '@alembic/core/domain/knowledge/values/Content';
export { Quality } from '@alembic/core/domain/knowledge/values/Quality';
export { Reasoning as ReasoningV3 } from '@alembic/core/domain/knowledge/values/Reasoning';
export {
  RELATION_BUCKETS,
  RELATION_BUCKETS as RelationType,
  Relations,
} from '@alembic/core/domain/knowledge/values/Relations';
export { Stats } from '@alembic/core/domain/knowledge/values/Stats';

// Snippet 相关
export { Snippet } from '@alembic/core/domain/snippet/Snippet';
