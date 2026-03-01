/**
 * ExplorationTracker — 统一的 AI 探索生命周期控制器
 *
 * 合并了三个原本各自为政的系统:
 *   1. PhaseRouter (ContextWindow.js) — 阶段状态机
 *   2. 探索进度追踪 (ChatAgent.js 内联) — 信息增量检测
 *   3. ReasoningLayer 行为控制部分 — 反思/规划/停滞 nudge
 *
 * 职责:
 *   - 信号收集: 统一的 recordToolCall() 替代 ~120 行内联 if-else
 *   - 阶段路由: 策略模式，不同角色使用不同阶段策略
 *   - Nudge 生成: 优先级队列，每轮最多注入一条 nudge
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

import Logger from '../../infrastructure/logging/Logger.js';

// ─── 常量 ──────────────────────────────────────────────

/** 反思间隔（每 N 轮触发一次） */
const DEFAULT_REFLECTION_INTERVAL = 5;
/** 连续无新信息 N 轮触发停滞反思 */
const DEFAULT_STALE_THRESHOLD = 2;
/** 最少经过 N 轮后才允许触发停滞反思 */
const MIN_ITERS_FOR_STALE_REFLECTION = 4;
/** 默认重规划间隔 */
const DEFAULT_REPLAN_INTERVAL = 8;
/** 默认偏差阈值 */
const DEFAULT_DEVIATION_THRESHOLD = 0.6;
/** 默认最少探索轮次（冷启动质量保障） */
const DEFAULT_MIN_EXPLORE_ITERS = 16;
/** 默认停滞收敛阈值 */
const DEFAULT_CONVERGENCE_STALE_THRESHOLD = 3;

// ─── 内置策略 ────────────────────────────────────────────

/**
 * Bootstrap 策略（原始 ChatAgent，有 submit 阶段）
 * @param {boolean} isSkillOnly — skill-only 维度跳过 PRODUCE 阶段
 * @returns {object} 策略配置
 */
function createBootstrapStrategy(isSkillOnly = false) {
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
const STRATEGY_ANALYST = {
  name: 'analyst',
  phases: ['SCAN', 'EXPLORE', 'VERIFY', 'SUMMARIZE'],
  transitions: {
    'SCAN→EXPLORE': {
      onMetrics: (m) => m.iteration >= 3,
      onTextResponse: false, // SCAN 阶段文本回复不触发转换
    },
    'EXPLORE→VERIFY': {
      onMetrics: (m, b) =>
        m.searchRoundsInPhase >= Math.floor(b.maxIterations * 0.6) ||
        m.roundsSinceNewInfo >= 3,
      onTextResponse: false, // 允许中间分析文本
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
const STRATEGY_PRODUCER = {
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

// ─── 搜索工具白名单（用于判断"搜索轮次"）───────────────

const SEARCH_TOOLS = new Set([
  'search_project_code',
  'semantic_search_code',
  'get_class_info',
  'get_class_hierarchy',
  'get_protocol_info',
  'get_method_overrides',
  'get_category_map',
  'list_project_structure',
  'get_project_overview',
  'get_file_summary',
]);

// ─── ExplorationTracker 主类 ─────────────────────────────

export class ExplorationTracker {
  /** @type {object} 策略配置 */
  #strategy;
  /** @type {object} 预算配置 */
  #budget;
  /** @type {string} 当前阶段 */
  #phase;
  /** @type {object} 日志器 */
  #logger;

  // ── 信号指标 ──
  #metrics = {
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
  #transitionFromPhase = null;
  /** @type {boolean} 是否已注入收敛 nudge（防止重复触发） */
  #convergenceNudged = false;
  /** @type {boolean} 是否已注入预算警告（防止重复触发） */
  #budgetWarningInjected = false;

  // ── Graceful exit 控制 ──
  /** @type {number|null} 进入 graceful exit 的轮次 */
  #gracefulExitRound = null;

  // ── Planning 跟踪 ──
  /** @type {boolean} 等待 AI 输出 replan */
  #pendingReplan = false;
  /** @type {object} 计划进度 */
  #planProgress = {
    coveredSteps: 0,
    totalSteps: 0,
    deviationScore: 0,
    unplannedActions: 0,
    lastReplanIteration: null,
    consecutiveOffPlan: 0,
  };

  /** @type {boolean} tick 是否已调用（用于 rollback） */
  #ticked = false;

  /**
   * @param {object} strategy — 策略配置对象
   * @param {object} budget — 预算配置 { maxIterations, searchBudget, ... }
   */
  constructor(strategy, budget) {
    this.#strategy = strategy;
    this.#budget = budget;
    this.#phase = strategy.phases[0];
    this.#logger = Logger.getInstance();
  }

  // ─── 静态工厂 ─────────────────────────────────────────

  /**
   * 根据调用参数解析应使用的策略
   * @param {object} opts — ChatAgent execute 的选项
   * @param {object} budget — 预算配置
   * @returns {ExplorationTracker|null} — User 模式返回 null
   */
  static resolve(opts, budget) {
    const { source = 'user', strategy: strategyName, dimensionMeta } = opts;
    const isSystem = source === 'system';

    if (!isSystem) {
      return null; // User 模式不需要 ExplorationTracker
    }

    let resolvedStrategy;

    if (strategyName === 'analyst') {
      resolvedStrategy = STRATEGY_ANALYST;
    } else if (strategyName === 'producer') {
      resolvedStrategy = STRATEGY_PRODUCER;
    } else {
      // 默认 bootstrap（strategyName === 'bootstrap' 或未指定）
      const isSkillOnly = dimensionMeta?.outputType === 'skill';
      resolvedStrategy = createBootstrapStrategy(isSkillOnly);
    }

    return new ExplorationTracker(resolvedStrategy, budget);
  }

  // ─── 核心 API：主循环调用点 ────────────────────────────

  /**
   * 每轮迭代开始时调用 — 递增计数
   * 可通过 rollbackTick() 撤销（AI 失败/空响应时）
   */
  tick() {
    this.#metrics.iteration++;
    this.#metrics.phaseRounds++;
    this.#ticked = true;
    // 安全: 清除上一轮可能遗留的 justTransitioned (文本路径不调 endRound)
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

  /**
   * 是否应退出主循环
   * @returns {boolean}
   */
  shouldExit() {
    // 终结阶段 + 已给了 2 轮 grace → 退出
    if (this.#isTerminalPhase() && this.#metrics.phaseRounds >= 2) {
      return true;
    }

    // 硬上限兜底（maxIterations + 2 grace 都耗尽）
    if (this.#metrics.iteration >= this.#budget.maxIterations + 2) {
      return true;
    }

    // 达到 maxIterations 但未在终结阶段 → 强制转入终结阶段
    if (this.#metrics.iteration >= this.#budget.maxIterations && !this.#isTerminalPhase()) {
      this.#logger.info(
        `[ExplorationTracker] maxIterations reached (${this.#metrics.iteration}/${this.#budget.maxIterations}), forcing → ${this.#getTerminalPhase()}`
      );
      this.#transitionTo(this.#getTerminalPhase());
      this.#justTransitioned = false; // shouldExit 的转换由 force_exit nudge 覆盖，不重复
      this.#gracefulExitRound = this.#metrics.iteration;
      // 返回 false，让主循环运行终结阶段的 grace 轮次
      return false;
    }

    return false;
  }

  /**
   * 获取本轮的 Nudge（每轮最多一条）
   * 调用时机：AI 调用前
   *
   * 优先级 (高→低):
   *   1. force_exit — 轮次耗尽
   *   2. convergence — 信息饱和
   *   3. budget_warning — 75% 预算消耗（无条件）
   *   4. reflection — 周期反思 / 停滞反思
   *   5. planning — 首轮规划 / 偏差重规划
   *
   * @param {import('./ReasoningTrace.js').ReasoningTrace} trace — 推理链（供反思用）
   * @returns {{ type: string, text: string }|null}
   */
  getNudge(trace) {
    const m = this.#metrics;
    const b = this.#budget;

    // 1. 强制退出
    if (this.#gracefulExitRound != null && m.iteration === this.#gracefulExitRound) {
      const submitCount = m.submitCount;
      return {
        type: 'force_exit',
        text: `⚠️ 你已使用 ${m.iteration}/${b.maxIterations} 轮次，**必须立即结束**。请在回复中直接输出 dimensionDigest JSON 总结（用 \`\`\`json 包裹），不要再调用任何工具。\n` +
          `\`\`\`json\n{"dimensionDigest":{"summary":"分析总结","candidateCount":${submitCount},"keyFindings":["发现"],"crossRefs":{},"gaps":["缺口"],"remainingTasks":[{"signal":"未处理信号","reason":"轮次耗尽","priority":"high","searchHints":["搜索词"]}]}}\n\`\`\`\n> remainingTasks: 列出未来得及处理的信号。已覆盖则留空 \`[]\`。`,
      };
    }

    // 2. 收敛引导（信息饱和 — 仅非终结阶段）
    if (
      !this.#isTerminalPhase() &&
      !this.#convergenceNudged &&
      m.roundsSinceNewInfo >= DEFAULT_CONVERGENCE_STALE_THRESHOLD &&
      m.iteration >= DEFAULT_MIN_EXPLORE_ITERS
    ) {
      this.#convergenceNudged = true;
      this.#logger.info(
        `[ExplorationTracker] 📊 Exploration saturated at iter ${m.iteration}/${b.maxIterations} — ` +
        `files=${m.uniqueFiles.size}, patterns=${m.uniquePatterns.size}, staleRounds=${m.roundsSinceNewInfo}`
      );
      return {
        type: 'convergence',
        text: `你已经充分探索了项目代码（${m.uniqueFiles.size} 个文件，${m.uniquePatterns.size} 次不同搜索，${m.uniqueQueries.size} 次结构化查询）。` +
          `最近 ${m.roundsSinceNewInfo} 轮没有发现新信息，建议开始撰写分析总结。\n` +
          `如果你确信还有重要方面未覆盖，可以继续探索（剩余 ${b.maxIterations - m.iteration} 轮）；否则请直接输出你的分析发现。`,
      };
    }

    // 3. 预算警告（75% 消耗，无条件，一次性）
    if (
      !this.#isTerminalPhase() &&
      !this.#budgetWarningInjected &&
      m.iteration >= Math.floor(b.maxIterations * 0.75)
    ) {
      this.#budgetWarningInjected = true;
      this.#logger.info(
        `[ExplorationTracker] 📌 Budget warning at ${m.iteration}/${b.maxIterations}`
      );
      return {
        type: 'budget_warning',
        text: `📌 进度提醒：你已使用 ${m.iteration}/${b.maxIterations} 轮次（${Math.round((m.iteration / b.maxIterations) * 100)}%）。` +
          `请确保核心方面已覆盖，开始准备总结。剩余 ${b.maxIterations - m.iteration} 轮，优先填补最重要的分析空白。`,
      };
    }

    // 4. 反思（周期性 + 停滞）
    if (this.#strategy.enableReflection) {
      const reflectionNudge = this.#checkReflection(trace);
      if (reflectionNudge) return reflectionNudge;
    }

    // 5. 规划（首轮 plan elicitation / 偏差 replan）
    if (this.#strategy.enablePlanning) {
      const planningNudge = this.#checkPlanning(trace);
      if (planningNudge) return planningNudge;
    }

    return null;
  }

  /**
   * 获取当前阶段的上下文状态行（注入 systemPrompt 尾部）
   * 轻量级，每轮都注入，不含行为指令
   * @returns {string}
   */
  getPhaseContext() {
    const m = this.#metrics;
    const b = this.#budget;
    const remaining = b.maxIterations - m.iteration;

    // 接近上限时的紧急警告
    if (remaining <= 2 && remaining > 0 && !this.#isTerminalPhase()) {
      return `\n\n## 当前状态\n⚠️ 仅剩 ${remaining} 轮次即达上限，请尽快完成当前工作并准备输出总结。`;
    }

    // 阶段特定提示
    const phaseHint = this.#getPhaseHint();
    if (phaseHint) {
      return `\n\n## 当前状态\n${phaseHint}`;
    }

    // 通用进度行
    const phaseLabel = this.#getPhaseLabel();
    return `\n\n## 当前进度\n第 ${m.iteration}/${b.maxIterations} 轮 | ${phaseLabel} | 剩余 ${remaining} 轮`;
  }

  /**
   * 获取当前阶段的 toolChoice
   * @returns {'required'|'auto'|'none'}
   */
  getToolChoice() {
    if (this.isGracefulExit) return 'none';
    return this.#strategy.getToolChoice(this.#phase, this.#metrics, this.#budget);
  }

  /**
   * 记录一次工具调用结果，更新内部指标
   * 替代 ChatAgent 中内联的 ~120 行 if-else 逻辑
   *
   * @param {string} toolName
   * @param {object} args
   * @param {*} result — 工具原始返回
   * @returns {{ isNew: boolean }}
   */
  recordToolCall(toolName, args, result) {
    this.#metrics.totalToolCalls++;
    const isNew = this.#detectNewInfo(toolName, args, result);

    // Submit 追踪（只记成功提交）
    if (toolName === 'submit_knowledge' || toolName === 'submit_with_check') {
      const status = typeof result === 'object' ? result?.status : 'ok';
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
   * @param {boolean} roundStats.hasNewInfo — 本轮是否获取到新信息
   * @param {number} roundStats.submitCount — 本轮成功提交数
   * @param {string[]} [roundStats.toolNames] — 本轮调用的工具名列表
   * @param {boolean} [roundStats.skipped] — 标记为跳过的轮次（错误/空响应）
   * @returns {{ type: string, text: string }|null} — 阶段转换 nudge（如有）
   */
  endRound({ hasNewInfo = false, submitCount = 0, toolNames = [], skipped = false } = {}) {
    this.#ticked = false;

    if (skipped) {
      // 跳过的轮次不更新任何指标
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

    // 4. 如果发生了转换，生成 nudge 立即返回给主循环注入
    if (this.#justTransitioned) {
      this.#justTransitioned = false;
      return {
        type: 'phase_transition',
        text: this.#buildTransitionNudge(),
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

    // 检查文本触发的阶段转换
    const transitioned = this.#checkTextTransition();
    // 文本路径不调 endRound()，需要主动清除 justTransitioned 防止泄漏
    if (transitioned) {
      this.#justTransitioned = false;
    }

    const isTerminal = this.#isTerminalPhase();

    if (isTerminal && !transitioned) {
      // 已在终结阶段且非刚转入 → 最终回答
      return { isFinalAnswer: true, needsDigestNudge: false, shouldContinue: false, nudge: null };
    }

    if (isTerminal && transitioned) {
      // 刚转入终结阶段 → 需要 digest nudge，不是最终回答
      const submitCount = m.submitCount;
      return {
        isFinalAnswer: false,
        needsDigestNudge: true,
        shouldContinue: true,
        nudge: `请在回复中直接输出 dimensionDigest JSON 总结（用 \`\`\`json 包裹）：\n` +
          `\`\`\`json\n{"dimensionDigest":{"summary":"分析总结(100-200字)","candidateCount":${submitCount},"keyFindings":["关键发现"],"crossRefs":{},"gaps":["未覆盖方面"],"remainingTasks":[{"signal":"未处理的信号/主题","reason":"未完成原因","priority":"high|medium|low","searchHints":["建议搜索词"]}]}}\n\`\`\`\n> 如果所有信号都已覆盖，remainingTasks 留空数组 \`[]\`。`,
      };
    }

    // 非终结阶段收到文本
    if (this.#phase === 'PRODUCE' || this.#phase === 'EXPLORE') {
      // PRODUCE 阶段中间文本 → 继续循环，注入提交引导
      const nudge = this.#phase === 'PRODUCE'
        ? '你的分析很好。请继续调用 submit_knowledge 提交你发现的知识候选，每个值得记录的模式/实践都应该提交。'
        : null;
      return { isFinalAnswer: false, needsDigestNudge: false, shouldContinue: true, nudge };
    }

    // 其他阶段的文本（SCAN / VERIFY 等）→ 继续循环
    return { isFinalAnswer: false, needsDigestNudge: false, shouldContinue: true, nudge: null };
  }

  /**
   * 记录被截断的工具调用数量
   * @param {number} count
   */
  recordTruncatedCalls(count) {
    if (count > 0) {
      this.#logger.warn(
        `[ExplorationTracker] ${count} tool calls truncated (MAX_TOOL_CALLS_PER_ITER)`
      );
    }
  }

  // ─── 状态查询 ─────────────────────────────────────────

  /** 是否处于 graceful exit 模式 */
  get isGracefulExit() {
    return this.#gracefulExitRound != null;
  }

  /** 是否应硬退出（graceful exit + 2 轮 grace 耗尽） */
  get isHardExit() {
    return (
      this.#gracefulExitRound != null &&
      this.#metrics.iteration >= this.#gracefulExitRound + 2
    );
  }

  /** 当前阶段 */
  get phase() {
    return this.#phase;
  }

  /** 当前迭代次数 */
  get iteration() {
    return this.#metrics.iteration;
  }

  /** 总提交数 */
  get totalSubmits() {
    return this.#metrics.submitCount;
  }

  /** 策略名称 */
  get strategyName() {
    return this.#strategy.name;
  }

  /**
   * 获取当前指标的快照（供外部使用，如 #produceForcedSummary）
   * @returns {object}
   */
  getMetrics() {
    return {
      iteration: this.#metrics.iteration,
      phase: this.#phase,
      submitCount: this.#metrics.submitCount,
      uniqueFiles: this.#metrics.uniqueFiles.size,
      uniquePatterns: this.#metrics.uniquePatterns.size,
      uniqueQueries: this.#metrics.uniqueQueries.size,
      totalToolCalls: this.#metrics.totalToolCalls,
      roundsSinceNewInfo: this.#metrics.roundsSinceNewInfo,
    };
  }

  /**
   * 获取计划进度
   * @returns {object}
   */
  getPlanProgress() {
    return { ...this.#planProgress };
  }

  // ─── 信号收集内部方法 ──────────────────────────────────

  /**
   * 检测工具调用是否产生了新信息
   * 合并了 ChatAgent 内联的探索追踪 + ReasoningLayer.buildObservationMeta 的逻辑
   *
   * @param {string} toolName
   * @param {object} args
   * @param {*} result
   * @returns {boolean}
   * @private
   */
  #detectNewInfo(toolName, args, result) {
    switch (toolName) {
      case 'search_project_code': {
        let foundNew = false;
        const pattern = args?.pattern || '';
        const patterns = args?.patterns || [];
        // 单模式
        if (pattern && !this.#metrics.uniquePatterns.has(pattern)) {
          this.#metrics.uniquePatterns.add(pattern);
          foundNew = true;
        }
        // 批量模式
        for (const p of patterns) {
          if (!this.#metrics.uniquePatterns.has(p)) {
            this.#metrics.uniquePatterns.add(p);
            foundNew = true;
          }
        }
        // 检查搜索结果是否有新文件
        if (result && typeof result === 'object') {
          const matches = result.matches || [];
          const batchResults = result.batchResults || {};
          for (const m of matches) {
            if (m.file && !this.#metrics.uniqueFiles.has(m.file)) {
              this.#metrics.uniqueFiles.add(m.file);
              foundNew = true;
            }
          }
          for (const sub of Object.values(batchResults)) {
            for (const m of sub.matches || []) {
              if (m.file && !this.#metrics.uniqueFiles.has(m.file)) {
                this.#metrics.uniqueFiles.add(m.file);
                foundNew = true;
              }
            }
          }
        }
        return foundNew;
      }

      case 'read_project_file': {
        let foundNew = false;
        const fp = args?.filePath || '';
        const fps = args?.filePaths || [];
        if (fp && !this.#metrics.uniqueFiles.has(fp)) {
          this.#metrics.uniqueFiles.add(fp);
          foundNew = true;
        }
        for (const f of fps) {
          if (!this.#metrics.uniqueFiles.has(f)) {
            this.#metrics.uniqueFiles.add(f);
            foundNew = true;
          }
        }
        return foundNew;
      }

      case 'list_project_structure': {
        const dir = args?.directory || '/';
        const qKey = `list:${dir}`;
        if (!this.#metrics.uniqueQueries.has(qKey)) {
          this.#metrics.uniqueQueries.add(qKey);
          return true;
        }
        return false;
      }

      case 'get_class_info':
      case 'get_class_hierarchy':
      case 'get_protocol_info':
      case 'get_method_overrides':
      case 'get_category_map': {
        const queryTarget =
          args?.className || args?.protocolName || args?.name || '';
        const qKey = `${toolName}:${queryTarget}`;
        if (!this.#metrics.uniqueQueries.has(qKey)) {
          this.#metrics.uniqueQueries.add(qKey);
          return true;
        }
        return false;
      }

      case 'get_project_overview': {
        const qKey = 'overview';
        if (!this.#metrics.uniqueQueries.has(qKey)) {
          this.#metrics.uniqueQueries.add(qKey);
          return true;
        }
        return false;
      }

      case 'submit_knowledge':
      case 'submit_with_check':
        // Submit 本身不算"新信息"（阶段转换由 submitCount 驱动）
        return false;

      default: {
        // 其他工具 — 首次调用算新信息，同名+同参数去重
        const qKey = `${toolName}:${JSON.stringify(args || {}).substring(0, 80)}`;
        if (!this.#metrics.uniqueQueries.has(qKey)) {
          this.#metrics.uniqueQueries.add(qKey);
          return true;
        }
        return false;
      }
    }
  }

  // ─── 阶段路由内部方法 ──────────────────────────────────

  /**
   * 检查 metrics 驱动的阶段转换
   * @private
   */
  #checkMetricsTransition() {
    const transitions = this.#strategy.transitions;
    const nextPhaseIndex = this.#strategy.phases.indexOf(this.#phase) + 1;
    if (nextPhaseIndex >= this.#strategy.phases.length) return;

    const nextPhase = this.#strategy.phases[nextPhaseIndex];
    const transKey = `${this.#phase}→${nextPhase}`;
    const rule = transitions[transKey];
    if (!rule) return;

    const condition = typeof rule === 'function' ? rule : rule.onMetrics;
    if (condition && condition(this.#metrics, this.#budget)) {
      this.#transitionTo(nextPhase);
    }
  }

  /**
   * 检查文本响应触发的阶段转换
   * @returns {boolean} 是否发生了转换
   * @private
   */
  #checkTextTransition() {
    const transitions = this.#strategy.transitions;
    const nextPhaseIndex = this.#strategy.phases.indexOf(this.#phase) + 1;
    if (nextPhaseIndex >= this.#strategy.phases.length) return false;

    const nextPhase = this.#strategy.phases[nextPhaseIndex];
    const transKey = `${this.#phase}→${nextPhase}`;
    const rule = transitions[transKey];
    if (!rule) return false;

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

  /**
   * 执行阶段转换
   * @param {string} newPhase
   * @private
   */
  #transitionTo(newPhase) {
    const oldPhase = this.#phase;
    this.#transitionFromPhase = oldPhase;
    this.#phase = newPhase;
    this.#metrics.phaseRounds = 0;
    this.#metrics.searchRoundsInPhase = 0;
    this.#justTransitioned = true;
    this.#logger.info(
      `[ExplorationTracker] ${oldPhase} → ${newPhase} (iter=${this.#metrics.iteration}, submits=${this.#metrics.submitCount})`
    );
  }

  /**
   * 构建阶段转换 nudge 文本
   * @returns {string}
   * @private
   */
  #buildTransitionNudge() {
    const m = this.#metrics;
    const fromPhase = this.#transitionFromPhase;
    const toPhase = this.#phase;

    if (toPhase === 'PRODUCE') {
      return '你已充分探索了项目代码，现在请开始调用 submit_knowledge 工具来提交你发现的知识候选。不要再搜索，直接提交。';
    }

    if (toPhase === 'SUMMARIZE') {
      const submitCount = m.submitCount;
      return `你已完成分析探索。请在回复中直接输出 dimensionDigest JSON（用 \`\`\`json 包裹），包含以下字段：\n` +
        `\`\`\`json\n{"dimensionDigest":{"summary":"分析总结(100-200字)","candidateCount":${submitCount},"keyFindings":["关键发现"],"crossRefs":{},"gaps":["未覆盖方面"],"remainingTasks":[{"signal":"未处理的信号/主题","reason":"未完成原因(如:提交上限已达)","priority":"high|medium|low","searchHints":["建议搜索词"]}]}}\n\`\`\`\n> 如果所有信号都已覆盖，remainingTasks 留空数组 \`[]\`。如果有未来得及处理的信号，请在此标记，系统会在下次运行时续传。`;
    }

    if (toPhase === 'EXPLORE' && fromPhase === 'SCAN') {
      return '全局扫描完成。现在开始定向搜索——根据你发现的项目结构，搜索关键模式和类。';
    }

    if (toPhase === 'VERIFY') {
      return '搜索阶段信息已饱和。现在进入验证阶段——读取最关键的源文件，确认细节和实现逻辑。';
    }

    return `阶段切换: ${fromPhase} → ${toPhase}`;
  }

  /**
   * 获取当前阶段的 hint（补充到 systemPrompt）
   * @returns {string|null}
   * @private
   */
  #getPhaseHint() {
    const m = this.#metrics;
    const b = this.#budget;

    switch (this.#phase) {
      case 'EXPLORE':
        if (m.searchRoundsInPhase >= b.searchBudget - 2) {
          return `搜索预算即将耗尽 (${m.searchRoundsInPhase}/${b.searchBudget})，请准备提交候选或产出摘要。`;
        }
        return null;

      case 'PRODUCE':
        if (m.submitCount === 0 && m.phaseRounds >= 1) {
          return '⚠️ 探索阶段已结束。你已收集了足够的项目信息，请 **立即** 调用 submit_knowledge 提交候选。不要继续搜索，直接提交。';
        }
        if (m.submitCount >= b.softSubmitLimit && b.softSubmitLimit > 0) {
          const remaining = b.maxSubmits - m.submitCount;
          return `已提交 ${m.submitCount} 个候选（上限 ${b.maxSubmits}）。${remaining > 0 ? `还可提交 ${remaining} 个。` : ''}如果还有值得记录的发现可以继续提交，否则请产出 dimensionDigest 总结。\n⚠️ 如果还有未处理的信号，请在 dimensionDigest 的 remainingTasks 字段中标记，下次运行时会续传。`;
        }
        return null;

      case 'SCAN':
        return '当前处于全局扫描阶段，请先获取项目概览和目录结构。';

      case 'VERIFY':
        return '当前处于验证阶段，请阅读关键源文件确认实现细节。';

      default:
        return null;
    }
  }

  /**
   * 获取用户友好的阶段标签
   * @returns {string}
   * @private
   */
  #getPhaseLabel() {
    switch (this.#phase) {
      case 'SCAN': return '扫描阶段';
      case 'EXPLORE': return '探索阶段';
      case 'PRODUCE': return '提交阶段';
      case 'VERIFY': return '验证阶段';
      case 'SUMMARIZE': return '⚠ 总结阶段 — 请停止工具调用，直接输出分析文本';
      default: return this.#phase;
    }
  }

  /** 是否为终结阶段 */
  #isTerminalPhase() {
    return this.#phase === this.#getTerminalPhase();
  }

  /** 获取策略定义的终结阶段（最后一个） */
  #getTerminalPhase() {
    return this.#strategy.phases[this.#strategy.phases.length - 1];
  }

  // ─── 反思/规划内部方法 ─────────────────────────────────

  /**
   * 检查是否需要触发反思 + 生成反思 nudge
   * @param {import('./ReasoningTrace.js').ReasoningTrace} trace
   * @returns {{ type: string, text: string }|null}
   * @private
   */
  #checkReflection(trace) {
    const m = this.#metrics;
    const b = this.#budget;
    const interval = this.#strategy.reflectionInterval || DEFAULT_REFLECTION_INTERVAL;

    // 触发条件
    const periodicTrigger = m.iteration > 1 && interval > 0 && m.iteration % interval === 0;
    const staleTrigger =
      m.roundsSinceNewInfo >= DEFAULT_STALE_THRESHOLD &&
      m.iteration >= MIN_ITERS_FOR_STALE_REFLECTION;

    if (!periodicTrigger && !staleTrigger) return null;

    const summary = trace?.getRecentSummary?.(interval || 3);
    if (!summary) return null;

    const stats = trace?.getStats?.() || {};
    const remaining = b.maxIterations - m.iteration;
    const progressPct = Math.round((m.iteration / b.maxIterations) * 100);

    const parts = [];
    if (staleTrigger) {
      parts.push(
        `📊 停滞反思 (第 ${m.iteration}/${b.maxIterations} 轮, 连续 ${m.roundsSinceNewInfo} 轮无新信息):`
      );
    } else {
      parts.push(`📊 中期反思 (第 ${m.iteration}/${b.maxIterations} 轮, ${progressPct}% 预算):`);
    }

    if (summary.thoughts?.length > 0) {
      parts.push(
        `\n你最近的思考方向:\n${summary.thoughts.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}`
      );
    }

    parts.push(
      `\n行动效率: 最近 ${summary.roundCount} 轮中 ${Math.round(summary.newInfoRatio * 100)}% 获取到新信息`
    );
    parts.push(
      `累计: ${m.uniqueFiles.size} 文件, ${m.uniquePatterns.size} 搜索模式, ${stats.totalActions || 0} 次工具调用`
    );

    // Planning 进度附加
    if (this.#strategy.enablePlanning) {
      const plan = trace?.getPlan?.();
      if (plan?.steps?.length > 0) {
        const doneCount = plan.steps.filter((s) => s.status === 'done').length;
        parts.push(`\n📋 计划进度: ${doneCount}/${plan.steps.length} 步骤已完成`);
      }
    }

    // 阶段化评估问题
    if (this.#phase === 'EXPLORE' || this.#phase === 'SCAN' || this.#phase === 'VERIFY') {
      parts.push(
        `\n请评估:\n1. 到目前为止最重要的发现是什么？\n2. 还有哪些关键方面未覆盖？\n3. 剩余 ${remaining} 轮，最有价值的下一步是什么？`
      );
    } else if (this.#phase === 'PRODUCE') {
      parts.push(
        `\n请评估:\n1. 已提交的候选是否覆盖了核心发现？\n2. 是否有高价值知识点被遗漏？`
      );
    }

    const reflectionText = parts.join('\n');
    trace?.setReflection?.(reflectionText);
    this.#logger.info(
      `[ExplorationTracker] 💭 reflection triggered at iteration ${m.iteration} (${staleTrigger ? 'stale' : 'periodic'})`
    );

    return { type: 'reflection', text: reflectionText };
  }

  /**
   * 检查是否需要触发规划 + 生成规划 nudge
   * @param {import('./ReasoningTrace.js').ReasoningTrace} trace
   * @returns {{ type: string, text: string }|null}
   * @private
   */
  #checkPlanning(trace) {
    const m = this.#metrics;
    const b = this.#budget;

    // 第 1 轮: plan elicitation
    if (m.iteration === 1) {
      return {
        type: 'planning',
        text: this.#buildPlanElicitationPrompt(),
      };
    }

    // 有计划时: 检查 replan
    const plan = trace?.getPlan?.();
    if (!plan) return null;

    const progress = this.#planProgress;
    const interval = this.#strategy.replanInterval || DEFAULT_REPLAN_INTERVAL;
    const deviationThreshold = DEFAULT_DEVIATION_THRESHOLD;

    const baseIteration = progress.lastReplanIteration || plan.createdAtIteration;
    const periodicTrigger = interval > 0 && m.iteration > 1 && m.iteration - baseIteration >= interval;
    const deviationTrigger =
      progress.consecutiveOffPlan >= 3 ||
      (progress.totalSteps > 0 && progress.deviationScore > deviationThreshold);

    if (!periodicTrigger && !deviationTrigger) return null;

    const remaining = b.maxIterations - m.iteration;
    const parts = [];
    if (deviationTrigger) {
      parts.push(`📋 计划偏差检查 (第 ${m.iteration}/${b.maxIterations} 轮):`);
      if (progress.consecutiveOffPlan >= 3) {
        parts.push(`你的行为已连续 ${progress.consecutiveOffPlan} 轮偏离原定计划。`);
      }
    } else {
      parts.push(`📋 计划进度回顾 (第 ${m.iteration}/${b.maxIterations} 轮):`);
    }

    const doneSteps = plan.steps.filter((s) => s.status === 'done');
    const pendingSteps = plan.steps.filter((s) => s.status === 'pending');
    if (doneSteps.length > 0) {
      parts.push(`\n✅ 已完成 (${doneSteps.length}/${plan.steps.length}):`);
      for (const s of doneSteps) parts.push(`  - ${s.description}`);
    }
    if (pendingSteps.length > 0) {
      parts.push(`\n⏳ 未完成 (${pendingSteps.length}/${plan.steps.length}):`);
      for (const s of pendingSteps) parts.push(`  - ${s.description}`);
    }
    if (progress.unplannedActions > 0) {
      parts.push(`\n⚡ 计划外行为: ${progress.unplannedActions} 次`);
    }
    parts.push(`\n剩余 ${remaining} 轮。请评估:`);
    parts.push(`1. 未完成的步骤是否仍然相关？`);
    parts.push(`2. 是否需要根据新发现调整后续步骤？`);
    parts.push(`3. 请更新你的探索计划（用编号列表）。`);

    progress.lastReplanIteration = m.iteration;
    this.#pendingReplan = true;

    this.#logger.info(
      `[ExplorationTracker] 📋 replan triggered at iteration ${m.iteration} (${deviationTrigger ? 'deviation' : 'periodic'})`
    );

    return { type: 'planning', text: parts.join('\n') };
  }

  /**
   * 构建首轮 plan elicitation prompt
   * @returns {string}
   * @private
   */
  #buildPlanElicitationPrompt() {
    const maxIter = this.#budget.maxIterations || 30;
    return [
      `📋 在开始探索前，请先制定一个简要的探索计划。`,
      ``,
      `你有 ${maxIter} 轮工具调用机会。请在你的回复中用编号列表简述 3-6 个探索步骤:`,
      `- 每个步骤应描述要搜索/阅读的目标（具体的类名、模式、文件路径）`,
      `- 步骤应从宏观到微观递进（先概览 → 再搜索关键模式 → 再深入关键文件）`,
      `- 最后一步应是"总结分析发现"`,
      ``,
      `例如:`,
      `1. 获取项目概览和目录结构，识别核心模块`,
      `2. 搜索网络请求相关类，分析请求模式`,
      `3. 搜索错误处理和响应解析模式`,
      `4. 深入阅读 3-5 个典型实现文件，确认关键细节`,
      `5. 总结分析发现`,
      ``,
      `制定计划后请立即开始执行第 1 步（可在同一轮中同时输出计划文本并调用工具）。`,
    ].join('\n');
  }

  /**
   * 更新计划进度（从 ReasoningLayer 迁入）
   * 将本轮工具调用与 plan 步骤进行模糊匹配
   *
   * @param {import('./ReasoningTrace.js').ReasoningTrace} trace
   */
  updatePlanProgress(trace) {
    if (!this.#strategy.enablePlanning) return;

    const steps = trace?.getPlanStepsMutable?.() || [];
    if (steps.length === 0) return;

    const actions = trace?.getCurrentRoundActions?.() || [];
    if (actions.length === 0) return;

    let matchedThisRound = false;

    for (const action of actions) {
      const matchedStep = this.#findMatchingStep(steps, action);
      if (matchedStep) {
        matchedStep.status = 'done';
        matchedThisRound = true;
      } else {
        this.#planProgress.unplannedActions++;
      }
    }

    if (matchedThisRound) {
      this.#planProgress.consecutiveOffPlan = 0;
    } else {
      this.#planProgress.consecutiveOffPlan++;
    }

    this.#planProgress.coveredSteps = steps.filter((s) => s.status === 'done').length;
    this.#planProgress.totalSteps = steps.length;
    this.#planProgress.deviationScore =
      steps.length > 0 ? 1 - this.#planProgress.coveredSteps / steps.length : 0;

    // 处理 pending replan
    if (this.#pendingReplan) {
      const plan = trace?.getPlan?.();
      if (plan) {
        this.#planProgress.coveredSteps = plan.steps.filter((s) => s.status === 'done').length;
        this.#planProgress.totalSteps = plan.steps.length;
        this.#planProgress.unplannedActions = 0;
        this.#planProgress.consecutiveOffPlan = 0;
        this.#pendingReplan = false;
      }
    }
  }

  /**
   * 模糊匹配: 将工具调用匹配到 plan 步骤（从 ReasoningLayer 迁入）
   * @param {Array} steps
   * @param {object} action — { tool, params }
   * @returns {object|null}
   * @private
   */
  #findMatchingStep(steps, action) {
    const toolName = action.tool;
    const argsStr = JSON.stringify(action.params || {}).toLowerCase();

    for (const step of steps) {
      if (step.status === 'done') continue;

      // 策略 1: 关键词匹配
      if (step.keywords?.length > 0) {
        const matched = step.keywords.some((kw) => argsStr.includes(kw.toLowerCase()));
        if (matched) return step;
      }

      // 策略 2: 工具类型 → 步骤描述的语义匹配
      const desc = step.description.toLowerCase();
      if (
        toolName === 'get_project_overview' &&
        (desc.includes('概览') || desc.includes('overview') || desc.includes('结构') || desc.includes('项目'))
      ) return step;
      if (
        toolName === 'list_project_structure' &&
        (desc.includes('目录') || desc.includes('结构') || desc.includes('structure'))
      ) return step;
      if (
        (toolName === 'get_class_info' || toolName === 'get_class_hierarchy') &&
        (desc.includes('继承') || desc.includes('类') || desc.includes('hierarchy') || desc.includes('class'))
      ) return step;
      if (
        toolName === 'read_project_file' &&
        (desc.includes('阅读') || desc.includes('read') || desc.includes('深入') || desc.includes('查看') || desc.includes('文件'))
      ) return step;
      if (
        toolName === 'search_project_code' &&
        (desc.includes('搜索') || desc.includes('search') || desc.includes('查找') || desc.includes('分析'))
      ) return step;
    }

    return null;
  }

  // ─── 质量评分（从 ReasoningLayer 迁入，委托给 trace）────

  /**
   * 推理质量评分
   * @param {import('./ReasoningTrace.js').ReasoningTrace} trace
   * @returns {{ score: number, breakdown: object }}
   */
  getQualityMetrics(trace) {
    const stats = trace?.getStats?.() || { totalRounds: 0, thoughtCount: 0, totalActions: 0, totalObservations: 0, reflectionCount: 0 };
    const totalRounds = stats.totalRounds || 1;

    const thoughtRatio = stats.thoughtCount / totalRounds;
    const reflectionRatio = stats.reflectionCount / totalRounds;
    const actionEfficiency = Math.min(stats.totalActions / totalRounds / 3, 1);
    const observationCoverage = stats.totalObservations > 0 ? 1 : 0;

    const plan = trace?.getPlan?.();
    const hasPlan = plan && plan.steps.length > 0;
    let planScore = 0;
    if (hasPlan) {
      const completionRate =
        this.#planProgress.totalSteps > 0
          ? this.#planProgress.coveredSteps / this.#planProgress.totalSteps
          : 0;
      const adherenceRate = 1 - (this.#planProgress.deviationScore || 0);
      planScore = completionRate * 0.6 + adherenceRate * 0.4;
    }

    const score = hasPlan
      ? Math.round(
          (thoughtRatio * 0.3 +
            reflectionRatio * 0.15 +
            actionEfficiency * 0.15 +
            observationCoverage * 0.15 +
            planScore * 0.25) * 100
        )
      : Math.round(
          (thoughtRatio * 0.4 +
            reflectionRatio * 0.2 +
            actionEfficiency * 0.2 +
            observationCoverage * 0.2) * 100
        );

    const breakdown = {
      ...stats,
      thoughtRatio: Math.round(thoughtRatio * 100),
      reflectionRatio: Math.round(reflectionRatio * 100),
      actionEfficiency: Math.round(actionEfficiency * 100),
      observationCoverage: Math.round(observationCoverage * 100),
    };

    if (hasPlan) {
      breakdown.planCompletion = Math.round(
        (this.#planProgress.totalSteps > 0
          ? this.#planProgress.coveredSteps / this.#planProgress.totalSteps
          : 0) * 100
      );
      breakdown.planAdherence = Math.round((1 - (this.#planProgress.deviationScore || 0)) * 100);
      breakdown.planScore = Math.round(planScore * 100);
    }

    return { score, breakdown };
  }
}

export default ExplorationTracker;
