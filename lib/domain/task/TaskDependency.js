/**
 * 任务依赖类型
 *
 * Phase 1 引入 6 种核心依赖类型，按 "是否影响就绪" 分为两组。
 *
 *   阻塞型: blocks, waits-for        → 影响 ready 计算
 *   结构型: parent-child              → 仅层次关系
 *   关联型: discovered-from, related, knowledge-ref → 不影响 ready
 */
export const DepType = Object.freeze({
  // ── 阻塞型（影响 ready 计算）──
  BLOCKS: 'blocks',
  WAITS_FOR: 'waits-for',

  // ── 结构型（建立层次，不影响 ready）──
  PARENT_CHILD: 'parent-child',

  // ── 关联型（不影响 ready，构建知识/因果图谱）──
  DISCOVERED_FROM: 'discovered-from',
  RELATED: 'related',
  KNOWLEDGE_REF: 'knowledge-ref', // AutoSnippet 独有：关联知识条目
  SUPERSEDES: 'supersedes',       // 决策演化链：新决策取代旧决策
});

/** 所有合法的依赖类型值列表 */
const ALL_DEP_TYPES = Object.values(DepType);

/** 影响就绪计算的依赖类型集合 */
const BLOCKING_TYPES = new Set([DepType.BLOCKS, DepType.WAITS_FOR]);

/**
 * 判断依赖类型是否影响就绪计算
 * @param {string} depType
 * @returns {boolean}
 */
export function affectsReadyWork(depType) {
  return BLOCKING_TYPES.has(depType);
}

/**
 * 判断依赖类型是否合法
 * @param {string} depType
 * @returns {boolean}
 */
export function isValidDepType(depType) {
  return ALL_DEP_TYPES.includes(depType);
}

export default DepType;
