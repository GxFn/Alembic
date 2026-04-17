/**
 * reactive-evolution.ts — ReactiveEvolution 类型定义
 *
 * 文件变更事件驱动的 Recipe 实时进化。
 */

/* ═══════════════════ File Change Events ═══════════════════ */

/** 文件变更类型 */
export type FileChangeType = 'created' | 'renamed' | 'deleted' | 'modified';

/** 单个文件变更事件（新模型：path 为主键） */
export interface FileChangeEvent {
  /** 变更类型 */
  type: FileChangeType;
  /** 文件路径（相对于 projectRoot）— 当前路径 */
  path: string;
  /** 变更前路径（仅 renamed 时有值） */
  oldPath?: string;
}

/**
 * @deprecated 旧事件模型，保留兼容。新代码请使用 FileChangeEvent。
 */
export interface LegacyFileChangeEvent {
  type: 'renamed' | 'deleted' | 'modified';
  oldPath: string;
  newPath?: string;
}

/* ═══════════════════ Processing Report ═══════════════════ */

/** 对单条 Recipe 的处理动作 */
export type ReactiveAction = 'fix-rename' | 'fix-symbol' | 'deprecate' | 'skip' | 'needs-review';

/** 单条处理明细 */
export interface ReactiveDetail {
  recipeId: string;
  recipeTitle: string;
  action: ReactiveAction;
  reason: string;
}

/** 批量处理报告 */
export interface ReactiveEvolutionReport {
  /** 自动修复的 Recipe 数 */
  fixed: number;
  /** 标记弃用的 Recipe 数 */
  deprecated: number;
  /** 跳过的（无关联 Recipe） */
  skipped: number;
  /** 需要 Agent review 的 Recipe 数 */
  needsReview: number;
  /** 建议用户触发进化检查 */
  suggestReview: boolean;
  /** 处理明细 */
  details: ReactiveDetail[];
}
