/**
 * §10.6 Graph shared types — 图谱类型共享
 *
 * Bootstrap 管道和 KnowledgeGraphService 共享实体/边的概念。
 * 统一枚举避免 string literal 不一致。
 */

/** 代码实体类型 */
export type EntityType =
  | 'class'
  | 'protocol'
  | 'category'
  | 'module'
  | 'pattern'
  | 'function'
  | 'file';

/** 关系类型 */
export type RelationType =
  | 'inherits'
  | 'conforms'
  | 'extends'
  | 'depends_on'
  | 'uses_pattern'
  | 'is_part_of'
  | 'calls'
  | 'data_flow'
  | 'discovered_in';

/** 图节点引用 */
export interface GraphNodeRef {
  id: string;
  type: EntityType;
  name: string;
}

/** 图边引用 */
export interface GraphEdgeRef {
  fromId: string;
  fromType: EntityType;
  toId: string;
  toType: EntityType;
  relation: RelationType;
  weight?: number;
}
