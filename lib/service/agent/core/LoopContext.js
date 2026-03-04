/**
 * LoopContext — reactLoop 单次执行的完整状态
 *
 * 封装原 reactLoop 内散落的 10+ 局部变量:
 *   - 注入依赖 (messages, tracker, trace, memoryCoordinator, sharedState)
 *   - 循环状态 (iteration, lastReply, toolCalls, tokenUsage)
 *   - 错误恢复 (consecutiveAiErrors, consecutiveEmptyResponses)
 *   - 配置 (source, budget, capabilities, baseSystemPrompt, toolSchemas, prompt)
 *
 * 使 reactLoop 的提取方法只需接收一个 ctx 参数。
 *
 * @module core/LoopContext
 */

/**
 * @typedef {Object} LoopContextConfig
 * @property {import('./MessageAdapter.js').MessageAdapter} messages — 统一消息适配器
 * @property {Object|null} [tracker] — ExplorationTracker 实例
 * @property {Object|null} [trace] — ActiveContext 实例
 * @property {Object|null} [memoryCoordinator] — MemoryCoordinator 实例
 * @property {Object|null} [sharedState] — 共享状态 { submittedTitles, submittedPatterns }
 * @property {string} [source] — 'user' | 'system'
 * @property {Object} budget — 预算配置
 * @property {import('../capabilities.js').Capability[]} capabilities — 本轮使用的 capabilities
 * @property {string} baseSystemPrompt — 基础系统提示词
 * @property {Array} toolSchemas — 工具 schema 列表
 * @property {string} prompt — 原始用户提示
 * @property {Function|null} [onToolCall] — 本轮工具调用钩子
 * @property {Object} [context] — 额外上下文
 * @property {import('../context/ContextWindow.js').ContextWindow|null} [contextWindow] — 原始 ContextWindow (供 forced-summary 等外部逻辑)
 */

export class LoopContext {
  // ─── 注入依赖 ───

  /** @type {import('./MessageAdapter.js').MessageAdapter} 统一消息适配器 */
  messages;

  /** @type {Object|null} ExplorationTracker 实例 */
  tracker;

  /** @type {Object|null} ActiveContext 实例 */
  trace;

  /** @type {Object|null} MemoryCoordinator 实例 */
  memoryCoordinator;

  /** @type {Object|null} 共享状态 */
  sharedState;

  // ─── 循环状态 ───

  /** @type {number} 当前迭代次数 */
  iteration = 0;

  /** @type {string} 最终回复文本 */
  lastReply = '';

  /** @type {Array} 本轮工具调用记录 */
  toolCalls = [];

  /** @type {{input: number, output: number}} 本轮 token 用量 */
  tokenUsage = { input: 0, output: 0 };

  /** @type {number} 循环开始时间戳 */
  loopStartTime = 0;

  // ─── 错误恢复 ───

  /** @type {number} 连续 AI 错误计数 (2-strike 策略) */
  consecutiveAiErrors = 0;

  /** @type {number} 连续空响应计数 */
  consecutiveEmptyResponses = 0;

  // ─── 配置 (只读) ───

  /** @type {string} 来源 'user' | 'system' */
  source;

  /** @type {Object} 预算配置 */
  budget;

  /** @type {import('../capabilities.js').Capability[]} */
  capabilities;

  /** @type {string} 基础系统提示词 */
  baseSystemPrompt;

  /** @type {Array} 工具 schemas */
  toolSchemas;

  /** @type {string} 原始用户提示 */
  prompt;

  /** @type {Function|null} 工具调用钩子 */
  onToolCall;

  /** @type {Object} 额外上下文 */
  context;

  /** @type {import('../../chat/ContextWindow.js').ContextWindow|null} 原始 ContextWindow 引用 */
  contextWindow;

  /** @type {string|null} 首轮 toolChoice 覆盖 ('required'/'auto'/'none') */
  toolChoiceOverride;

  /**
   * @param {LoopContextConfig} config
   */
  constructor(config) {
    this.messages = config.messages;
    this.tracker = config.tracker || null;
    this.trace = config.trace || null;
    this.memoryCoordinator = config.memoryCoordinator || null;
    this.sharedState = config.sharedState || null;
    this.source = config.source || 'user';
    this.budget = config.budget;
    this.capabilities = config.capabilities;
    this.baseSystemPrompt = config.baseSystemPrompt;
    this.toolSchemas = config.toolSchemas;
    this.prompt = config.prompt;
    this.onToolCall = config.onToolCall || null;
    this.context = config.context || {};
    this.contextWindow = config.contextWindow || null;
    this.toolChoiceOverride = config.toolChoiceOverride || null;
    this.loopStartTime = Date.now();
  }

  // ─── 计算属性 ───

  /** 是否为 system 场景 */
  get isSystem() {
    return this.source === 'system';
  }

  /** 最大迭代数 */
  get maxIterations() {
    return this.budget.maxIterations || 20;
  }

  // ─── Token 累计辅助 ───

  /**
   * 累加 token 用量到循环级统计
   * @param {Object} usage — { inputTokens, outputTokens }
   */
  addTokenUsage(usage) {
    if (!usage) return;
    const inTok = usage.inputTokens || 0;
    const outTok = usage.outputTokens || 0;
    this.tokenUsage.input += inTok;
    this.tokenUsage.output += outTok;
  }

  // ─── 结果构建 ───

  /**
   * 构建循环返回值
   * @returns {{ reply: string, toolCalls: Array, tokenUsage: Object, iterations: number }}
   */
  buildResult() {
    return {
      reply: this.lastReply,
      toolCalls: [...this.toolCalls],
      tokenUsage: { ...this.tokenUsage },
      iterations: this.iteration,
    };
  }
}
