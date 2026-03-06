/**
 * ExplorationStrategies — 探索策略定义
 *
 * 从 ExplorationTracker.js 提取的内置策略配置。
 * 每种策略定义了阶段序列、转换规则、toolChoice 逻辑和反思/规划开关。
 *
 * @module ExplorationStrategies
 */

// ─── 常量 ──────────────────────────────────────────────

/** 反思间隔（每 N 轮触发一次） */
export const DEFAULT_REFLECTION_INTERVAL = 5;
/** 默认重规划间隔 */
export const DEFAULT_REPLAN_INTERVAL = 8;

// ─── 内置策略 ────────────────────────────────────────────

/**
 * Bootstrap 策略（有 submit 阶段）
 * @param {boolean} isSkillOnly - skill-only 维度跳过 PRODUCE 阶段
 * @returns {object} 策略配置
 */
export function createBootstrapStrategy(isSkillOnly = false) {
  return {
    name: 'bootstrap',
    phases: isSkillOnly
      ? ['EXPLORE', 'SUMMARIZE']
      : ['EXPLORE', 'PRODUCE', 'SUMMARIZE'],
    transitions: {
      ...(isSkillOnly
        ? {
            'EXPLORE→SUMMARIZE': {
              onMetrics: (m, b) =>
                m.submitCount > 0 ||
                m.searchRoundsInPhase >= b.searchBudget,
              onTextResponse: true,
            },
          }
        : {
            'EXPLORE→PRODUCE': {
              onMetrics: (m, b) =>
                m.submitCount > 0 ||
                m.searchRoundsInPhase >= b.searchBudget,
              onTextResponse: true,
            },
            'PRODUCE→SUMMARIZE': {
              onMetrics: (m, b) =>
                m.submitCount >= b.maxSubmits ||
                (m.submitCount > 0 && m.roundsSinceSubmit >= b.idleRoundsToExit) ||
                (m.phaseRounds >= b.searchBudgetGrace && m.submitCount === 0),
              onTextResponse: (m, b) =>
                m.submitCount >= b.softSubmitLimit,
            },
          }),
    },
    getToolChoice: (phase, m, b) => {
      if (phase === 'SUMMARIZE') return 'none';
      if (phase === 'EXPLORE') {
        return m.searchRoundsInPhase >= b.searchBudget - 1 ? 'auto' : 'required';
      }
      return 'auto'; // PRODUCE
    },
    enableReflection: true,
    reflectionInterval: DEFAULT_REFLECTION_INTERVAL,
    enablePlanning: true,
    replanInterval: DEFAULT_REPLAN_INTERVAL,
  };
}

/**
 * Analyst 策略（纯探索，无 submit 阶段）
 * 4 阶段: SCAN → EXPLORE → VERIFY → SUMMARIZE
 */
export const STRATEGY_ANALYST = {
  name: 'analyst',
  phases: ['SCAN', 'EXPLORE', 'VERIFY', 'SUMMARIZE'],
  transitions: {
    'SCAN→EXPLORE': {
      onMetrics: (m) => m.iteration >= 3,
      onTextResponse: false,
    },
    'EXPLORE→VERIFY': {
      onMetrics: (m, b) =>
        m.searchRoundsInPhase >= Math.floor(b.maxIterations * 0.6) ||
        m.roundsSinceNewInfo >= 3,
      onTextResponse: false,
    },
    'VERIFY→SUMMARIZE': {
      onMetrics: (m, b) =>
        m.iteration >= Math.floor(b.maxIterations * 0.8) ||
        m.roundsSinceNewInfo >= 2,
      onTextResponse: true,
    },
  },
  getToolChoice: (phase) => {
    if (phase === 'SUMMARIZE') return 'none';
    if (phase === 'SCAN') return 'required';
    if (phase === 'EXPLORE') return 'required';
    return 'auto'; // VERIFY
  },
  enableReflection: true,
  reflectionInterval: DEFAULT_REFLECTION_INTERVAL,
  enablePlanning: true,
  replanInterval: DEFAULT_REPLAN_INTERVAL,
};

/**
 * Producer 策略（格式化+提交，不搜索）
 * 2 阶段: PRODUCE → SUMMARIZE
 */
export const STRATEGY_PRODUCER = {
  name: 'producer',
  phases: ['PRODUCE', 'SUMMARIZE'],
  transitions: {
    'PRODUCE→SUMMARIZE': {
      onMetrics: (m, b) =>
        m.submitCount >= b.maxSubmits ||
        (m.submitCount > 0 && m.roundsSinceSubmit >= b.idleRoundsToExit) ||
        (m.phaseRounds >= b.searchBudgetGrace && m.submitCount === 0),
      onTextResponse: (m, b) =>
        m.submitCount >= b.softSubmitLimit,
    },
  },
  getToolChoice: (phase) => (phase === 'SUMMARIZE' ? 'none' : 'auto'),
  enableReflection: false,
  reflectionInterval: 0,
  enablePlanning: false,
  replanInterval: 0,
};
