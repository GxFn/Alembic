/** KnowledgeEntry 领域层统一导出 */

// 实体
export { KnowledgeEntry } from '@alembic/core/domain/knowledge/KnowledgeEntry';
// Repository 接口
export { KnowledgeRepository } from '@alembic/core/domain/knowledge/KnowledgeRepository';
export type { LifecycleFilter } from '@alembic/core/domain/knowledge/Lifecycle';
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
} from '@alembic/core/domain/knowledge/Lifecycle';
export { Constraints } from '@alembic/core/domain/knowledge/values/Constraints';
// 值对象
export { Content } from '@alembic/core/domain/knowledge/values/Content';
export { Quality } from '@alembic/core/domain/knowledge/values/Quality';
export { Reasoning } from '@alembic/core/domain/knowledge/values/Reasoning';
export { RELATION_BUCKETS, Relations } from '@alembic/core/domain/knowledge/values/Relations';
export { Stats } from '@alembic/core/domain/knowledge/values/Stats';
