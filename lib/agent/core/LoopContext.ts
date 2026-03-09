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

import type { Capability } from '../capabilities.js';
import type { ContextWindow } from '../context/ContextWindow.js';
import type { ExplorationTracker } from '../context/ExplorationTracker.js';
import type { ActiveContext } from '../memory/ActiveContext.js';
import type { MemoryCoordinator } from '../memory/MemoryCoordinator.js';
import type { MessageAdapter } from './MessageAdapter.js';

/** Tool call hook type */
type ToolCallHook = (name: string, params: Record<string, unknown>, result: unknown) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accept various hook signatures from callers; unknown[] breaks contravariant param checks
type ToolCallHookLike = (...args: any[]) => void;

/** Token usage returned by AI providers */
interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Shared state between pipeline stages */
interface SharedState {
  submittedTitles?: Set<string>;
  submittedPatterns?: Set<string>;
  submitToolName?: string;
  _dimensionMeta?: { id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Budget configuration */
interface BudgetConfig {
  maxIterations?: number;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

/** LoopContext configuration — accepts both concrete and duck-typed inputs from callers */
interface LoopContextConfig {
  messages: MessageAdapter;
  tracker?: ExplorationTracker | Record<string, unknown> | null;
  trace?: ActiveContext | Record<string, unknown> | null;
  memoryCoordinator?: MemoryCoordinator | Record<string, unknown> | null;
  sharedState?: SharedState | Record<string, unknown> | null;
  source?: string;
  budget: BudgetConfig;
  capabilities: Capability[];
  baseSystemPrompt: string;
  toolSchemas: Array<Record<string, unknown>>;
  prompt: string;
  onToolCall?: ToolCallHook | ToolCallHookLike | null;
  context?: Record<string, unknown>;
  contextWindow?: ContextWindow | null;
  toolChoiceOverride?: string | null;
}

export class LoopContext {
  // ─── 注入依赖 ───

  /** @type {import('./MessageAdapter.js').MessageAdapter} 统一消息适配器 */
  messages: MessageAdapter;

  /** @type {Object|null} ExplorationTracker 实例 */
  tracker: ExplorationTracker | null;

  /** @type {Object|null} ActiveContext 实例 */
  trace: ActiveContext | null;

  /** @type {Object|null} MemoryCoordinator 实例 */
  memoryCoordinator: MemoryCoordinator | null;

  /** @type {Object|null} 共享状态 */
  sharedState: SharedState | null;

  // ─── 循环状态 ───

  /** @type {number} 当前迭代次数 */
  iteration = 0;

  /** @type {string} 最终回复文本 */
  lastReply = '';

  /** @type {Array} 本轮工具调用记录 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool call entries have varying shapes (ToolCallEntry, ToolCallRecord, etc.) across callers; no common structural type satisfies all consumers
  toolCalls: any[] = [];

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
  source: string;

  /** @type {Object} 预算配置 */
  budget: BudgetConfig;

  capabilities: Capability[];

  /** @type {string} 基础系统提示词 */
  baseSystemPrompt: string;

  /** @type {Array} 工具 schemas */
  toolSchemas: Array<Record<string, unknown>>;

  /** @type {string} 原始用户提示 */
  prompt: string;

  /** @type {Function|null} 工具调用钩子 */
  onToolCall: ToolCallHook | null;

  /** @type {Object} 额外上下文 */
  context: Record<string, unknown>;

  /** @type {import('../context/ContextWindow.js').ContextWindow|null} 原始 ContextWindow 引用 */
  contextWindow: ContextWindow | null;

  /** @type {string|null} 首轮 toolChoice 覆盖 ('required'/'auto'/'none') */
  toolChoiceOverride: string | null;

  constructor(config: LoopContextConfig) {
    this.messages = config.messages;
    this.tracker = (config.tracker || null) as ExplorationTracker | null;
    this.trace = (config.trace || null) as ActiveContext | null;
    this.memoryCoordinator = (config.memoryCoordinator || null) as MemoryCoordinator | null;
    this.sharedState = (config.sharedState || null) as SharedState | null;
    this.source = config.source || 'user';
    this.budget = config.budget;
    this.capabilities = config.capabilities;
    this.baseSystemPrompt = config.baseSystemPrompt;
    this.toolSchemas = config.toolSchemas;
    this.prompt = config.prompt;
    this.onToolCall = (config.onToolCall || null) as ToolCallHook | null;
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
   * @param usage { inputTokens, outputTokens }
   */
  addTokenUsage(usage: TokenUsage | null | undefined) {
    if (!usage) {
      return;
    }
    const inTok = usage.inputTokens || 0;
    const outTok = usage.outputTokens || 0;
    this.tokenUsage.input += inTok;
    this.tokenUsage.output += outTok;
  }

  // ─── 结果构建 ───

  /**
   * 构建循环返回值
   * @returns }
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
