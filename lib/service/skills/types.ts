/**
 * Skill 推荐系统 — 统一类型定义
 *
 * 覆盖: SignalProvider / RecommendationPipeline / FeedbackStore / SkillHooks
 */

// ═══════════════════════════════════════════════════════
//  Hook 系统类型
// ═══════════════════════════════════════════════════════

/** Hook 执行模式 — 受 Webpack Tapable 启发，简化为 4 种核心语义 */
export type HookMode =
  /** 串行执行，所有 handler 按优先级顺序执行，忽略返回值 */
  | 'series'
  /** 并行执行，所有 handler Promise.allSettled (fire-and-forget) */
  | 'parallel'
  /** 串行传值，前一个 handler 的返回值作为下一个的第一个参数 */
  | 'waterfall'
  /** 串行短路，首个返回 truthy 值（含 {block:true}）的 handler 终止链 */
  | 'bail';

/** Hook 定义 */
export interface HookDefinition {
  name: string;
  mode: HookMode;
  description: string;
}

/** Handler 注册选项 */
export interface HookHandlerOptions {
  /** handler 名称 (用于日志和调试) */
  name: string;
  /** 执行优先级 (越小越先，默认 100) */
  priority?: number;
  /** 超时 (ms)，超时自动跳过，默认 10000 */
  timeout?: number;
}

/** 已注册的 Handler 内部表示 */
export interface RegisteredHandler {
  fn: (...args: unknown[]) => Promise<unknown> | unknown;
  name: string;
  priority: number;
  timeout: number;
}

// ═══════════════════════════════════════════════════════
//  信号系统类型
// ═══════════════════════════════════════════════════════

/** 标准化信号对象 */
export interface Signal {
  id: string;
  provider: string;
  type: string;
  timestamp: Date;
  data: Record<string, unknown>;
  /** 信号强度 0-1 */
  strength: number;
  /** 可选的去重 key */
  dedupeKey?: string;
}

/** 信号收集上下文 */
export interface SignalContext {
  projectRoot: string;
  database?: unknown;
  container?: unknown;
}

/** 统一信号提供者接口 */
export interface SignalProvider {
  /** 提供者唯一名称 */
  readonly name: string;
  /** 信号类别 */
  readonly category: 'behavior' | 'quality' | 'context' | 'external';
  /** 优先级 (越小越先执行) */
  readonly priority: number;

  /**
   * 收集信号 — 增量模式
   * @param since 上次收集的时间戳 (null = 首次)
   * @param context 全局上下文
   * @returns 标准化信号对象数组
   */
  collect(since: Date | null, context: SignalContext): Promise<Signal[]>;

  /** 信号提供者是否可用 */
  isAvailable(context: SignalContext): boolean;
}

// ═══════════════════════════════════════════════════════
//  推荐系统类型
// ═══════════════════════════════════════════════════════

/** 推荐候选 */
export interface RecommendationCandidate {
  /** 推荐的 Skill 名称 */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 推荐理由 */
  rationale: string;
  /** 推荐来源策略 */
  source: string;
  /** 优先级 */
  priority: 'high' | 'medium' | 'low';
  /** 原始信号数据 */
  signals: Record<string, unknown>;
  /** 推荐内容草稿 (可选) */
  body?: string;
}

/** 带分数的推荐结果 */
export interface ScoredRecommendation extends RecommendationCandidate {
  /** 综合得分 0-1 */
  score: number;
  /** 各信号分项得分 */
  signalScores?: Record<string, number>;
  /** 唯一推荐 ID (用于反馈追踪) */
  recommendationId: string;
  /** 推荐生成时间 */
  generatedAt: string;
}

/** 推荐管线上下文 */
export interface RecommendationContext {
  projectRoot: string;
  database?: unknown;
  container?: unknown;
  agentFactory?: unknown;
  /** 已有的项目级 Skill 名称集合 (用于去重) */
  existingSkills?: Set<string>;
  /** 用户偏好 (来自 FeedbackStore) */
  userPreference?: UserPreference;
  /** AI Provider 是否可用 */
  aiAvailable?: boolean;
}

/** 召回策略接口 */
export interface RecallStrategy {
  readonly name: string;
  /** 召回方法类型 */
  readonly type: 'rule' | 'ai' | 'vector' | 'popularity';

  /** 召回候选列表 */
  recall(context: RecommendationContext): Promise<RecommendationCandidate[]>;

  /** 策略是否可用 (例如 AI 策略需要 aiProvider) */
  isAvailable(context: RecommendationContext): boolean;
}

// ═══════════════════════════════════════════════════════
//  反馈系统类型
// ═══════════════════════════════════════════════════════

/** 推荐反馈动作 */
export type FeedbackAction =
  /** 用户采纳推荐并创建了 Skill */
  | 'adopted'
  /** 用户主动关闭/忽略推荐 */
  | 'dismissed'
  /** 推荐过期未处理 */
  | 'expired'
  /** 用户查看了推荐详情 */
  | 'viewed'
  /** 用户采纳但修改了内容 */
  | 'modified';

/** 推荐反馈记录 */
export interface RecommendationFeedback {
  recommendationId: string;
  action: FeedbackAction;
  timestamp: string;
  /** 推荐来源策略 */
  source?: string;
  /** 推荐类别 */
  category?: string;
  /** 用户反馈原因 */
  reason?: string;
}

/** 用户偏好 (从反馈历史中推导) */
export interface UserPreference {
  preferredCategories: string[];
  avoidedCategories: string[];
  preferredSources: string[];
  /** 总体采纳率 */
  adoptionRate: number;
}

// ═══════════════════════════════════════════════════════
//  度量系统类型
// ═══════════════════════════════════════════════════════

/** 推荐效果指标 */
export interface RecommendationMetricsSnapshot {
  /** 总推荐数 */
  totalRecommendations: number;
  /** 总展示数 */
  totalViewed: number;
  /** 总采纳数 */
  totalAdopted: number;
  /** 总忽略数 */
  totalDismissed: number;
  /** 总过期数 */
  totalExpired: number;
  /** 采纳率 */
  adoptionRate: number;
  /** 查看率 */
  viewRate: number;
  /** 按来源分组的采纳率 */
  adoptionRateBySource: Record<string, number>;
  /** 统计时间范围 */
  since: string;
}
