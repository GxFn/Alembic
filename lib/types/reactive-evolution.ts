/**
 * reactive-evolution.ts — ReactiveEvolution 类型定义
 *
 * 文件变更事件驱动的 Recipe 实时进化。
 */

/* ═══════════════════ File Change Events ═══════════════════ */

/** 文件变更类型 */
export type FileChangeType = 'created' | 'renamed' | 'deleted' | 'modified';

/**
 * 文件变更事件来源。
 *
 *  - `ide-edit`     VSCode 扩展捕获的实时 IDE 编辑（Signal 1-3：rename / delete / create）+ 保存
 *  - `git-head`     Git HEAD 变化（commit / pull / switch）导致的批量 diff
 *  - `git-worktree` Working Tree 扫描（窗口聚焦 / 5 分钟定时）产生的批量 diff
 *
 * 来源会被透传到 {@link ReactiveEvolutionReport.eventSource}，供 VSCode 扩展判断
 * 是否弹窗（只有 ide-edit 才弹）。服务端 FileChangeHandler 只读取不修改。
 */
export type FileChangeEventSource = 'ide-edit' | 'git-head' | 'git-worktree';

/** 单个文件变更事件（新模型：path 为主键） */
export interface FileChangeEvent {
  /** 变更类型 */
  type: FileChangeType;
  /** 文件路径（相对于 projectRoot）— 当前路径 */
  path: string;
  /** 变更前路径（仅 renamed 时有值） */
  oldPath?: string;
  /** 事件来源（可选，旧版客户端不传则视为 'ide-edit' 以保持向后兼容） */
  eventSource?: FileChangeEventSource;
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

/**
 * 修改事件对 Recipe 的影响级别。
 *
 *  - `direct`    改动的文件 ∈ Recipe.sourceRefs 精确匹配 / coreCode 显式引用。权重 0.7。
 *  - `reference` 改动的文件 ∈ Recipe.reasoning.sources 但不在 sourceRefs / coreCode 中。权重 0.4。
 *  - `pattern`   改动文件命中 Recipe.trigger 的 glob 或关键词，但无显式引用。权重 0.2。
 */
export type ImpactLevel = 'direct' | 'reference' | 'pattern';

/** 单条处理明细 */
export interface ReactiveDetail {
  recipeId: string;
  recipeTitle: string;
  action: ReactiveAction;
  reason: string;
  /** 仅 action='needs-review' 时有值：modified 事件对该 Recipe 的影响级别 */
  impactLevel?: ImpactLevel;
  /** 仅 action='needs-review' 时有值：触发此标记的文件路径 */
  modifiedPath?: string;
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
  /**
   * 本批事件的主要来源。
   *
   * 取批次中出现次数最多的 eventSource；批次只含一种来源时就是该来源。
   * VSCode 扩展据此判断：非 'ide-edit' 的批次一律不弹窗（只在 Dashboard 汇总）。
   */
  eventSource?: FileChangeEventSource;
}
