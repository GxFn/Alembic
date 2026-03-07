/**
 * ExplorationTracker — 统一的 AI 探索生命周期控制器
 *
 * 合并了三个原本各自为政的系统:
 *   1. PhaseRouter (ContextWindow.js) — 阶段状态机
 *   2. 探索进度追踪 (原内联逻辑) — 信息增量检测
 *   3. ReasoningLayer 行为控制部分 — 反思/规划/停滞 nudge
 *
 * 职责（拆分后的编排层）:
 *   - 阶段状态机: phase 持有 + 转换规则
 *   - 信号收集: 委托 SignalDetector
 *   - Nudge 生成: 委托 NudgeGenerator
 *   - 计划跟踪: 委托 PlanTracker
 *   - Graceful exit: 管理轮次耗尽后的优雅退出流程
 *
 * 不拥有的职责:
 *   - 推理链数据收集 → ReasoningTrace (纯数据，不影响行为)
 *   - 上下文压缩 → ContextWindow
 *   - 工具注册与执行 → ToolRegistry
 *   - 跨对话记忆 → Memory / WorkingMemory
 *
 * @module ExplorationTracker
 */

import Logger from '../../../infrastructure/logging/Logger.js';
import type {
  ExplorationBudget,
  ExplorationPhase,
  ExplorationStrategy,
  ExplorationTrace,
  FullExplorationMetrics,
} from './exploration/ExplorationStrategies.js';
import {
  createBootstrapStrategy,
  STRATEGY_ANALYST,
  STRATEGY_PRODUCER,
} from './exploration/ExplorationStrategies.js';
import { NudgeGenerator } from './exploration/NudgeGenerator.js';
import type { ActiveTrace } from './exploration/PlanTracker.js';
import { PlanTracker } from './exploration/PlanTracker.js';
import { SEARCH_TOOLS, SignalDetector } from './exploration/SignalDetector.js';

// ─── 本地类型 ──────────────────────────────────────────

/** resolve() 选项 */
interface ResolveOptions {
  source?: unknown;
  strategy?: unknown;
  dimensionMeta?: { outputType?: string };
}

/** 预算输入（带默认值） */
interface BudgetInput extends Partial<ExplorationBudget> {
  submitToolName?: string;
}

// ─── ExplorationTracker 主类 ─────────────────────────────

export class ExplorationTracker {
  /** @type {object} 策略配置 */
  #strategy: ExplorationStrategy;
  /** @type {object} 预算配置 */
  #budget: ExplorationBudget;
  /** @type {string} 当前阶段 */
  #phase: string;
  /** @type {object} 日志器 */
  #logger;

  // ── 子模块 ──
  /** @type {SignalDetector} */
  #signalDetector;
  /** @type {NudgeGenerator} */
  #nudgeGenerator;
  /** @type {PlanTracker} */
  #planTracker;

  // ── 信号指标 ──
  #metrics: FullExplorationMetrics = {
    uniqueFiles: new Set(),
    uniquePatterns: new Set(),
    uniqueQueries: new Set(),
    totalToolCalls: 0,
    submitCount: 0,
    roundsSinceNewInfo: 0,
    roundsSinceSubmit: 0,
    iteration: 0,
    searchRoundsInPhase: 0,
    phaseRounds: 0,
  };

  // ── 阶段控制 ──
  /** @type {boolean} 是否刚完成阶段转换（用于 pending nudge） */
  #justTransitioned = false;
  /** @type {string|null} 转换前的旧阶段 */
  #transitionFromPhase: string | null = null;

  // ── Graceful exit 控制 ──
  /** @type {number|null} 进入 graceful exit 的轮次 */
  #gracefulExitRound: number | null = null;

  /** @type {boolean} tick 是否已调用（用于 rollback） */
  #ticked = false;
  /** @type {string} 提交工具名（用于 nudge 文本生成） */
  #submitToolName = 'submit_knowledge';

  /**
   * @param {object} strategy 策略配置对象
   * @param {object} budget 预算配置 { maxIterations, searchBudget, ... }
   */
  constructor(strategy: ExplorationStrategy, budget: BudgetInput) {
    this.#strategy = strategy;
    this.#budget = {
      maxIterations: 24,
      searchBudget: 18,
      searchBudgetGrace: 10,
      maxSubmits: 10,
      softSubmitLimit: 8,
      idleRoundsToExit: 3,
      ...budget,
    };
    this.#submitToolName = budget.submitToolName || 'submit_knowledge';
    this.#phase = strategy.phases[0];
    this.#logger = Logger.getInstance();

    // 初始化子模块
    this.#signalDetector = new SignalDetector(this.#metrics);
    this.#nudgeGenerator = new NudgeGenerator();
    this.#planTracker = new PlanTracker();
  }

  // ─── 静态工厂 ─────────────────────────────────────────

  /**
   * 根据调用参数解析应使用的策略
   * @param {object} opts - AgentRuntime execute 的选项
   * @param {object} budget 预算配置
   * @returns {ExplorationTracker|null} - User 模式返回 null
   */
  static resolve(opts: ResolveOptions, budget: BudgetInput) {
    const { source = 'user', strategy: strategyName, dimensionMeta } = opts;
    const isSystem = source === 'system';

    if (!isSystem) {
      return null;
    }

    let resolvedStrategy: ExplorationStrategy;

    if (strategyName === 'analyst') {
      resolvedStrategy = STRATEGY_ANALYST;
    } else if (strategyName === 'producer') {
      resolvedStrategy = STRATEGY_PRODUCER;
    } else {
      const isSkillOnly = dimensionMeta?.outputType === 'skill';
      resolvedStrategy = createBootstrapStrategy(isSkillOnly);
    }

    return new ExplorationTracker(resolvedStrategy, budget);
  }

  // ─── 核心 API：主循环调用点 ────────────────────────────

  /**
   * 每轮迭代开始时调用 — 递增计数
   */
  tick() {
    this.#metrics.iteration++;
    this.#metrics.phaseRounds++;
    this.#ticked = true;
    this.#justTransitioned = false;
  }

  /**
   * 撤销 tick（AI 调用失败或空响应时，不计入迭代）
   */
  rollbackTick() {
    if (this.#ticked) {
      this.#metrics.iteration--;
      this.#metrics.phaseRounds--;
      this.#ticked = false;
    }
  }

  /** 提交工具名 */
  get submitToolName() {
    return this.#submitToolName;
  }

  /**
   * 是否应退出主循环
   * @returns {boolean}
   */
  shouldExit() {
    // Scan pipeline: SUMMARIZE 无消费方，直接退出
    if (this.#isTerminalPhase() && this.#submitToolName === 'collect_scan_recipe') {
      return true;
    }
    // 终结阶段 + 已给了 2 轮 grace → 退出
    if (this.#isTerminalPhase() && this.#metrics.phaseRounds >= 2) {
      return true;
    }
    // 硬上限兜底
    if (this.#metrics.iteration >= this.#budget.maxIterations + 2) {
      return true;
    }
    // 达到 maxIterations 但未在终结阶段 → 强制转入终结阶段
    if (this.#metrics.iteration >= this.#budget.maxIterations && !this.#isTerminalPhase()) {
      this.#logger.info(
        `[ExplorationTracker] maxIterations reached (${this.#metrics.iteration}/${this.#budget.maxIterations}), forcing → ${this.#getTerminalPhase()}`
      );
      this.#transitionTo(this.#getTerminalPhase());
      this.#justTransitioned = false;
      this.#gracefulExitRound = this.#metrics.iteration;
      return false;
    }
    return false;
  }

  /**
   * 获取本轮的 Nudge（每轮最多一条）
   * @param {object} trace 推理链
   * @returns {{ type: string, text: string }|null}
   */
  getNudge(trace: ExplorationTrace | null) {
    // 委托 NudgeGenerator
    const nudge = this.#nudgeGenerator.generate(this.#buildNudgeState(), trace);
    if (nudge) {
      // 日志 (保持原有行为)
      if (nudge.type === 'convergence') {
        this.#logger.info(
          `[ExplorationTracker] 📊 Exploration saturated at iter ${this.#metrics.iteration}/${this.#budget.maxIterations} — ` +
            `files=${this.#metrics.uniqueFiles.size}, patterns=${this.#metrics.uniquePatterns.size}, staleRounds=${this.#metrics.roundsSinceNewInfo}`
        );
      } else if (nudge.type === 'budget_warning') {
        this.#logger.info(
          `[ExplorationTracker] 📌 Budget warning at ${this.#metrics.iteration}/${this.#budget.maxIterations}`
        );
      } else if (nudge.type === 'reflection') {
        this.#logger.info(
          `[ExplorationTracker] 💭 reflection triggered at iteration ${this.#metrics.iteration}`
        );
      }
      return nudge;
    }

    // NudgeGenerator 不处理 planning — 委托 PlanTracker
    if (this.#strategy.enablePlanning) {
      const planningNudge = this.#planTracker.checkPlanning(
        this.#buildNudgeState(),
        trace as ActiveTrace | null
      );
      if (planningNudge) {
        this.#logger.info(
          `[ExplorationTracker] 📋 ${planningNudge.type} triggered at iteration ${this.#metrics.iteration}`
        );
        return planningNudge;
      }
    }

    return null;
  }

  /**
   * 获取当前阶段的上下文状态行（注入 systemPrompt 尾部）
   * @returns {string}
   */
  getPhaseContext() {
    return this.#nudgeGenerator.getPhaseContext(this.#buildNudgeState());
  }

  /**
   * 获取当前阶段的 toolChoice
   * @returns {'required'|'auto'|'none'}
   */
  getToolChoice() {
    if (this.isGracefulExit) {
      return 'none';
    }
    return this.#strategy.getToolChoice(
      this.#phase as ExplorationPhase,
      this.#metrics,
      this.#budget
    );
  }

  /**
   * 记录一次工具调用结果，更新内部指标
   *
   * @param {string} toolName
   * @param {object} args
   * @param {*} result
   * @returns {{ isNew: boolean }}
   */
  recordToolCall(toolName: string, args: Record<string, unknown>, result: unknown) {
    this.#metrics.totalToolCalls++;
    const isNew = this.#signalDetector.detect(toolName, args, result);

    // Submit 追踪
    if (
      toolName === 'submit_knowledge' ||
      toolName === 'submit_with_check' ||
      toolName === 'collect_scan_recipe'
    ) {
      const status =
        typeof result === 'object' ? (result as Record<string, unknown>)?.status : 'ok';
      const isRejected = status === 'rejected';
      const isError = status === 'error';
      if (!isRejected && !isError) {
        this.#metrics.submitCount++;
        this.#metrics.roundsSinceSubmit = 0;
      }
    }

    return { isNew };
  }

  /**
   * 结束本轮迭代 — 更新轮次级指标 + 检查阶段转换
   *
   * @param {object} roundStats
   * @returns {{ type: string, text: string }|null} 阶段转换 nudge
   */
  endRound({
    hasNewInfo = false,
    submitCount = 0,
    toolNames = [] as string[],
    skipped = false,
  } = {}) {
    this.#ticked = false;

    if (skipped) {
      return null;
    }

    // 1. 更新轮次级指标
    if (hasNewInfo) {
      this.#metrics.roundsSinceNewInfo = 0;
    } else {
      this.#metrics.roundsSinceNewInfo++;
    }
    if (submitCount > 0) {
      this.#metrics.roundsSinceSubmit = 0;
    } else {
      this.#metrics.roundsSinceSubmit++;
    }

    // 2. 搜索轮次计数
    const hasSearchTool = toolNames.some((t) => SEARCH_TOOLS.has(t));
    if (hasSearchTool) {
      this.#metrics.searchRoundsInPhase++;
    }

    // 3. 检查 metrics 驱动的阶段转换
    this.#checkMetricsTransition();

    // 4. 如果发生了转换，生成 nudge
    if (this.#justTransitioned) {
      this.#justTransitioned = false;
      // Scan pipeline: skip SUMMARIZE nudge
      if (this.#submitToolName === 'collect_scan_recipe' && this.#isTerminalPhase()) {
        this.#logger.info(
          `[ExplorationTracker] scan pipeline: skip SUMMARIZE nudge, will exit on next tick (submits=${this.#metrics.submitCount})`
        );
        return null;
      }
      return {
        type: 'phase_transition',
        text: this.#nudgeGenerator.buildTransitionNudge(this.#buildNudgeState()),
      };
    }

    return null;
  }

  /**
   * 处理 AI 返回纯文本响应（无工具调用）
   * @returns {{ isFinalAnswer: boolean, needsDigestNudge: boolean, shouldContinue: boolean, nudge: string|null }}
   */
  onTextResponse() {
    const m = this.#metrics;
    const transitioned = this.#checkTextTransition();
    if (transitioned) {
      this.#justTransitioned = false;
    }

    const isTerminal = this.#isTerminalPhase();

    if (isTerminal && !transitioned) {
      return { isFinalAnswer: true, needsDigestNudge: false, shouldContinue: false, nudge: null };
    }

    if (isTerminal && transitioned) {
      const submitCount = m.submitCount;

      if (this.#submitToolName === 'collect_scan_recipe') {
        return { isFinalAnswer: true, needsDigestNudge: false, shouldContinue: false, nudge: null };
      }

      const nudge =
        this.#strategy.name === 'analyst'
          ? `请**停止调用工具**，直接输出你的完整分析报告。用 Markdown 格式，包含具体文件路径、类名和代码模式。至少涵盖 3 个核心发现。\n\n**现在开始输出你的分析报告。**\n⚠️ 严禁在回复中复制本条指令文字，只输出你自己的分析。`
          : `请在回复中直接输出 dimensionDigest JSON 总结（用 \`\`\`json 包裹）：\n` +
            `\`\`\`json\n{"dimensionDigest":{"summary":"分析总结(100-200字)","candidateCount":${submitCount},"keyFindings":["关键发现"],"crossRefs":{},"gaps":["未覆盖方面"],"remainingTasks":[{"signal":"未处理的信号/主题","reason":"未完成原因","priority":"high|medium|low","searchHints":["建议搜索词"]}]}}\n\`\`\`\n> 如果所有信号都已覆盖，remainingTasks 留空数组 \`[]\`。\n` +
            `⚠️ 严禁在回复中复制本条指令文字，只输出 JSON。`;
      return {
        isFinalAnswer: false,
        needsDigestNudge: true,
        shouldContinue: true,
        nudge,
      };
    }

    // 非终结阶段收到文本
    if (this.#phase === 'PRODUCE' || this.#phase === 'EXPLORE') {
      const nudge =
        this.#phase === 'PRODUCE' && this.#submitToolName !== 'collect_scan_recipe'
          ? `你的分析很好。请继续调用 ${this.#submitToolName} 提交你发现的知识候选，每个值得记录的模式/实践都应该提交。`
          : null;
      return { isFinalAnswer: false, needsDigestNudge: false, shouldContinue: true, nudge };
    }

    return { isFinalAnswer: false, needsDigestNudge: false, shouldContinue: true, nudge: null };
  }

  /**
   * 记录被截断的工具调用数量
   * @param {number} count
   */
  recordTruncatedCalls(count: number) {
    if (count > 0) {
      this.#logger.warn(
        `[ExplorationTracker] ${count} tool calls truncated (MAX_TOOL_CALLS_PER_ITER)`
      );
    }
  }

  // ─── 状态查询 ─────────────────────────────────────────

  get isGracefulExit() {
    return this.#gracefulExitRound != null;
  }

  get isHardExit() {
    return (
      this.#gracefulExitRound != null && this.#metrics.iteration >= this.#gracefulExitRound + 2
    );
  }

  get phase() {
    return this.#phase;
  }

  get iteration() {
    return this.#metrics.iteration;
  }

  get totalSubmits() {
    return this.#metrics.submitCount;
  }

  get strategyName() {
    return this.#strategy.name;
  }

  getMetrics() {
    return {
      iteration: this.#metrics.iteration,
      phase: this.#phase,
      phaseRounds: this.#metrics.phaseRounds,
      submitCount: this.#metrics.submitCount,
      uniqueFiles: this.#metrics.uniqueFiles.size,
      uniquePatterns: this.#metrics.uniquePatterns.size,
      uniqueQueries: this.#metrics.uniqueQueries.size,
      totalToolCalls: this.#metrics.totalToolCalls,
      roundsSinceNewInfo: this.#metrics.roundsSinceNewInfo,
    };
  }

  get metrics() {
    return this.getMetrics();
  }

  getPlanProgress() {
    return this.#planTracker.progress;
  }

  /**
   * 更新计划进度 — 委托 PlanTracker
   * @param {object} trace
   */
  updatePlanProgress(trace: ExplorationTrace | null) {
    if (!this.#strategy.enablePlanning) {
      return;
    }
    this.#planTracker.updatePlanProgress(trace as ActiveTrace | null);
  }

  /**
   * 推理质量评分 — 委托 PlanTracker
   * @param {object} trace
   * @returns {{ score: number, breakdown: object }}
   */
  getQualityMetrics(trace: ExplorationTrace | null) {
    return this.#planTracker.getQualityMetrics(trace as ActiveTrace | null);
  }

  // ─── 阶段路由内部方法 ──────────────────────────────────

  #checkMetricsTransition() {
    const transitions = this.#strategy.transitions;
    const nextPhaseIndex = this.#strategy.phases.indexOf(this.#phase) + 1;
    if (nextPhaseIndex >= this.#strategy.phases.length) {
      return;
    }

    const nextPhase = this.#strategy.phases[nextPhaseIndex];
    const transKey = `${this.#phase}→${nextPhase}`;
    const rule = transitions[transKey];
    if (!rule) {
      return;
    }

    const condition = typeof rule === 'function' ? rule : rule.onMetrics;
    if (condition?.(this.#metrics, this.#budget)) {
      this.#transitionTo(nextPhase);
    }
  }

  #checkTextTransition() {
    const transitions = this.#strategy.transitions;
    const nextPhaseIndex = this.#strategy.phases.indexOf(this.#phase) + 1;
    if (nextPhaseIndex >= this.#strategy.phases.length) {
      return false;
    }

    const nextPhase = this.#strategy.phases[nextPhaseIndex];
    const transKey = `${this.#phase}→${nextPhase}`;
    const rule = transitions[transKey];
    if (!rule) {
      return false;
    }

    let shouldTransition = false;
    if (typeof rule === 'object' && rule.onTextResponse !== undefined) {
      if (typeof rule.onTextResponse === 'function') {
        shouldTransition = rule.onTextResponse(this.#metrics, this.#budget);
      } else {
        shouldTransition = !!rule.onTextResponse;
      }
    }

    if (shouldTransition) {
      this.#transitionTo(nextPhase);
      return true;
    }
    return false;
  }

  #transitionTo(newPhase: string) {
    const oldPhase = this.#phase;
    this.#transitionFromPhase = oldPhase;
    this.#phase = newPhase;
    this.#metrics.phaseRounds = 0;
    this.#metrics.searchRoundsInPhase = 0;
    // 重置停滞计数器 — 防止跨阶段累积导致级联式过早转换
    // (SCAN 阶段的 roundsSinceNewInfo 不应影响 EXPLORE→VERIFY 的判定)
    this.#metrics.roundsSinceNewInfo = 0;
    this.#metrics.roundsSinceSubmit = 0;
    this.#justTransitioned = true;
    this.#logger.info(
      `[ExplorationTracker] ${oldPhase} → ${newPhase} (iter=${this.#metrics.iteration}, submits=${this.#metrics.submitCount})`
    );
  }

  #isTerminalPhase() {
    return this.#phase === this.#getTerminalPhase();
  }

  #getTerminalPhase() {
    return this.#strategy.phases[this.#strategy.phases.length - 1];
  }

  /**
   * 构建 NudgeState 供 NudgeGenerator / PlanTracker 使用
   * @returns {object}
   */
  #buildNudgeState() {
    return {
      phase: this.#phase,
      metrics: this.#metrics,
      budget: this.#budget,
      strategy: this.#strategy,
      gracefulExitRound: this.#gracefulExitRound,
      submitToolName: this.#submitToolName,
      isTerminalPhase: this.#isTerminalPhase(),
      transitionFromPhase: this.#transitionFromPhase,
    };
  }
}

export default ExplorationTracker;
