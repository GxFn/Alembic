/**
 * 全局常量注册表 — 集中管理所有魔法数字和阈值
 *
 * 取代散落在各模块中的硬编码数字，方便统一调参和文档化。
 *
 * @module shared/constants
 */

// ─── 质量评分 ───────────────────────────────────────────

/** QualityScorer 维度权重 */
export const QUALITY_WEIGHTS = Object.freeze({
  completeness: 0.35,
  format:       0.25,
  codeQuality:  0.25,
  metadata:     0.15,
  engagement:   0.00,
});

/** QualityScorer 等级分界线 */
export const QUALITY_GRADES = Object.freeze({
  A: 0.9,
  B: 0.75,
  C: 0.6,
  D: 0.4,
});

/** 代码质量评估 — 合理长度范围 */
export const CODE_LENGTH = Object.freeze({
  MIN: 10,
  MAX: 5000,
});

// ─── Guard 规则学习 ──────────────────────────────────────

/** RuleLearner 规则健康阈值 */
export const RULE_LEARNER = Object.freeze({
  /** 触发高误报规则的条件 */
  PROBLEMATIC_FALSE_POSITIVE_RATE: 0.3,
  PROBLEMATIC_MIN_TRIGGERS: 5,
  /** 规则建议置信度 */
  CONFIDENCE_TUNE:        0.7,
  CONFIDENCE_DISABLE:     0.8,
  CONFIDENCE_SPECIALIZE:  0.6,
  CONFIDENCE_REVIEW:      0.4,
  /** 触发数阈值 */
  HIGH_TRIGGER_COUNT:     50,
  HIGH_PRECISION:         0.8,
  /** 闲置天数阈值 */
  UNUSED_DAYS_THRESHOLD:  30,
  /** 精度下限 */
  LOW_PRECISION:          0.5,
});

// ─── 合规报告 ────────────────────────────────────────────

/** ComplianceReporter 默认 Quality Gate */
export const QUALITY_GATE = Object.freeze({
  MAX_ERRORS:   0,
  MAX_WARNINGS: 20,
  MIN_SCORE:    70,
});

/** ComplianceReporter 扣分权重 */
export const COMPLIANCE_SCORING = Object.freeze({
  ERROR_PENALTY:            5,
  WARNING_PENALTY:          1,
  INFO_PENALTY:             0.2,
  PROBLEMATIC_RULE_PENALTY: 3,
  HIGH_F1_BONUS:            5,
  HIGH_F1_THRESHOLD:        0.8,
  LOW_PRECISION_THRESHOLD:  0.5,
  MAX_FILES_DEFAULT:        500,
});

// ─── 知识置信度 ──────────────────────────────────────────

/** 知识条目默认置信度和阈值 */
export const KNOWLEDGE_CONFIDENCE = Object.freeze({
  /** 默认 confidence（Reasoning VO） */
  DEFAULT:              0.7,
  /** pending 条目纳入交付的最低 confidence */
  PENDING_MIN:          0.7,
  /** rankScore 中 confidence 缺省值 */
  RANK_DEFAULT:         0.5,
  /** Bootstrap refine 时的 AI 默认 confidence */
  BOOTSTRAP_DEFAULT:    0.6,
  /** 自动提交时的 bootstrap confidence */
  BOOTSTRAP_SUBMIT:     0.8,
});

// ─── 搜索管线 ────────────────────────────────────────────

/** SearchEngine 配置 */
export const SEARCH = Object.freeze({
  DEFAULT_LIMIT:  10,
  MAX_RESULTS:    100,
});

// ─── 文件监听器 ──────────────────────────────────────────

/** FileWatcher 配置 */
export const FILE_WATCHER = Object.freeze({
  DEBOUNCE_DELAY_MS:           300,
  STABILITY_THRESHOLD_MS:      500,
  POLL_INTERVAL_MS:            100,
  BINARY_INTERVAL_MS:          300,
  MAX_FILE_SIZE_BYTES:         1024 * 1024,
});

// ─── AI Provider ─────────────────────────────────────────

/** AiProvider 熔断配置 */
export const AI_CIRCUIT_BREAKER = Object.freeze({
  FAILURE_THRESHOLD: 5,
});

// ─── 缓存 ────────────────────────────────────────────────

/** ToolResultCache 配置 */
export const CACHE = Object.freeze({
  MAX_FILE_ENTRIES:   200,
  MAX_SEARCH_ENTRIES: 500,
  /** 缓存条目默认 TTL（毫秒），0 = 不过期 */
  DEFAULT_TTL_MS:     30 * 60 * 1000,   // 30 分钟
});

// ─── 性能监控 ────────────────────────────────────────────

/** PerformanceMonitor 配置 */
export const MONITORING = Object.freeze({
  SLOW_REQUEST_THRESHOLD_MS: 1000,
  ERROR_ALERT_THRESHOLD:     10,
});

// ─── Cursor 交付 ─────────────────────────────────────────

/** CursorDeliveryPipeline 排序权重 */
export const DELIVERY_RANK = Object.freeze({
  CONFIDENCE_WEIGHT:  50,
  AUTHORITY_WEIGHT:   30,
  USE_COUNT_MAX:      10,
  USE_COUNT_WEIGHT:   2,
  ACTIVE_BONUS:       10,
});

export default {
  QUALITY_WEIGHTS,
  QUALITY_GRADES,
  CODE_LENGTH,
  RULE_LEARNER,
  QUALITY_GATE,
  COMPLIANCE_SCORING,
  KNOWLEDGE_CONFIDENCE,
  SEARCH,
  FILE_WATCHER,
  AI_CIRCUIT_BREAKER,
  CACHE,
  MONITORING,
  DELIVERY_RANK,
};
