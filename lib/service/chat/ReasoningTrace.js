/**
 * ReasoningTrace — 单次 execute() 的完整推理链记录
 *
 * 记录每轮 ReAct 循环的四要素:
 *   Thought     → AI 在执行工具前的推理文本
 *   Action      → 调用了什么工具、什么参数
 *   Observation  → 工具返回的结构化观察
 *   Reflection   → 周期性自我评估
 *
 * 设计原则:
 *   - 纯数据收集，不影响主循环控制流
 *   - 零 token 开销 — 不向 LLM 上下文注入额外内容
 *   - 可序列化 — toJSON() 用于审计日志和 API 返回
 *
 * @module ReasoningTrace
 */

/**
 * @typedef {Object} Round
 * @property {number} iteration       — 轮次编号
 * @property {string|null} thought    — AI 的推理文本
 * @property {Array<{tool: string, params: object}>} actions — 本轮工具调用
 * @property {Array<{tool: string, gotNewInfo: boolean, resultType: string, keyFacts: string[], resultSize: number}>} observations — 结构化观察
 * @property {string|null} reflection — 反思内容
 * @property {object|null} roundSummary — 轮次摘要
 * @property {number} startTime       — 轮次开始时间
 * @property {number|null} endTime    — 轮次结束时间
 */

/**
 * @typedef {Object} PlanStep
 * @property {string} description — 步骤描述
 * @property {'pending'|'done'|'skipped'} status — 当前状态
 * @property {string[]} keywords — 从描述中提取的匹配关键词
 */

/**
 * @typedef {Object} Plan
 * @property {string} text               — 原始计划文本
 * @property {Array<PlanStep>} steps     — 解析出的步骤列表
 * @property {number} createdAtIteration — 创建于第几轮
 * @property {number} lastUpdatedAtIteration — 最近更新于第几轮
 */

export class ReasoningTrace {
  /** @type {Array<Round>} */
  #rounds = [];
  /** @type {Round|null} */
  #currentRound = null;
  /** @type {Plan|null} */
  #plan = null;
  /** @type {Array<Plan>} */
  #planHistory = [];

  /**
   * 开始新一轮推理
   * @param {number} iteration — 轮次编号
   */
  startRound(iteration) {
    if (this.#currentRound) this.endRound(); // 安全关闭上一轮
    this.#currentRound = {
      iteration,
      thought: null,
      actions: [],
      observations: [],
      reflection: null,
      roundSummary: null,
      startTime: Date.now(),
      endTime: null,
    };
  }

  /**
   * 记录 AI 的推理文本（从 aiResult.text 提取）
   * @param {string} text
   */
  setThought(text) {
    if (this.#currentRound && text) {
      this.#currentRound.thought = text;
    }
  }

  /**
   * 记录一次工具调用
   * @param {string} toolName
   * @param {object} params
   */
  addAction(toolName, params) {
    this.#currentRound?.actions.push({ tool: toolName, params });
  }

  /**
   * 记录一次工具结果的结构化观察
   * @param {string} toolName
   * @param {object} meta — { gotNewInfo, resultType, resultSize, keyFacts }
   */
  addObservation(toolName, meta) {
    this.#currentRound?.observations.push({ tool: toolName, ...meta });
  }

  /**
   * 记录反思内容
   * @param {string} text
   */
  setReflection(text) {
    if (this.#currentRound && text) {
      this.#currentRound.reflection = text;
    }
  }

  /**
   * 记录轮次摘要
   * @param {object} summary — { newInfoCount, totalCalls, submits, cumulativeFiles, cumulativePatterns }
   */
  setRoundSummary(summary) {
    if (this.#currentRound) {
      this.#currentRound.roundSummary = summary;
    }
  }

  /**
   * 结束当前轮次
   */
  endRound() {
    if (this.#currentRound) {
      this.#currentRound.endTime = Date.now();
      this.#rounds.push(this.#currentRound);
      this.#currentRound = null;
    }
  }

  // ─── 分析方法 ──────────────────────────────────────────

  /**
   * 获取所有有 Thought 的轮次
   * @returns {Array<{iteration: number, thought: string}>}
   */
  getThoughts() {
    return this.#rounds
      .filter(r => r.thought)
      .map(r => ({ iteration: r.iteration, thought: r.thought }));
  }

  /**
   * 获取最近 N 轮的紧凑摘要（用于 Reflection 注入）
   * @param {number} [n=3] — 回看轮数
   * @returns {object|null}
   */
  getRecentSummary(n = 3) {
    const recent = this.#rounds.slice(-n);
    if (recent.length === 0) return null;

    const thoughts = recent
      .filter(r => r.thought)
      .map(r => r.thought.length > 100 ? r.thought.substring(0, 100) + '…' : r.thought);

    const tools = recent.flatMap(r => r.actions.map(a => a.tool));

    const newInfoCount = recent.reduce((c, r) =>
      c + r.observations.filter(o => o.gotNewInfo).length, 0
    );
    const totalObs = recent.reduce((c, r) => c + r.observations.length, 0);

    return {
      roundCount: recent.length,
      thoughts,
      toolCalls: tools,
      newInfoRatio: totalObs > 0 ? newInfoCount / totalObs : 0,
      lastIteration: recent[recent.length - 1].iteration,
    };
  }

  /**
   * 统计指标
   * @returns {object}
   */
  getStats() {
    return {
      totalRounds: this.#rounds.length,
      thoughtCount: this.#rounds.filter(r => r.thought).length,
      totalActions: this.#rounds.reduce((c, r) => c + r.actions.length, 0),
      totalObservations: this.#rounds.reduce((c, r) => c + r.observations.length, 0),
      reflectionCount: this.#rounds.filter(r => r.reflection).length,
      totalDurationMs: this.#rounds.reduce((d, r) =>
        d + ((r.endTime || Date.now()) - r.startTime), 0
      ),
    };
  }

  // ─── Planning 方法 ──────────────────────────────────────

  /**
   * 设置初始计划
   * @param {string} planText — AI 输出的计划文本
   * @param {number} iteration — 创建轮次
   */
  setPlan(planText, iteration) {
    this.#plan = {
      text: planText,
      steps: this.#parsePlanSteps(planText),
      createdAtIteration: iteration,
      lastUpdatedAtIteration: iteration,
    };
  }

  /**
   * 更新计划（replan 后调用）
   * @param {string} replanText — AI 输出的新计划文本
   * @param {number} iteration — 更新轮次
   */
  updatePlan(replanText, iteration) {
    if (!this.#plan) {
      this.setPlan(replanText, iteration);
      return;
    }
    this.#planHistory.push({ ...this.#plan, steps: this.#plan.steps.map(s => ({ ...s })) });
    this.#plan.text = replanText;
    this.#plan.steps = this.#parsePlanSteps(replanText);
    this.#plan.lastUpdatedAtIteration = iteration;
  }

  /**
   * 获取当前计划（只读副本）
   * @returns {Plan|null}
   */
  getPlan() {
    if (!this.#plan) return null;
    return {
      ...this.#plan,
      steps: this.#plan.steps.map(s => ({ ...s })),
    };
  }

  /**
   * 获取计划步骤的可变引用（内部用于匹配更新状态）
   * @returns {Array<PlanStep>}
   */
  getPlanStepsMutable() {
    return this.#plan?.steps || [];
  }

  /**
   * 获取计划历史
   * @returns {Array<Plan>}
   */
  getPlanHistory() {
    return this.#planHistory.map(p => ({ ...p, steps: p.steps.map(s => ({ ...s })) }));
  }

  /**
   * 获取当前轮次的 actions （供 Planning 匹配使用）
   * @returns {Array<{tool: string, params: object}>}
   */
  getCurrentRoundActions() {
    return this.#currentRound?.actions || [];
  }

  /**
   * 获取当前轮次的 iteration 编号
   * @returns {number|null}
   */
  getCurrentIteration() {
    return this.#currentRound?.iteration || null;
  }

  // ─── 私有: Plan 解析 ──────────────────────────────────

  /**
   * 从 AI 文本中解析计划步骤（编号列表提取）
   * @param {string} text
   * @returns {Array<PlanStep>}
   * @private
   */
  #parsePlanSteps(text) {
    if (!text) return [];
    const lines = text.split('\n');
    const steps = [];
    for (const line of lines) {
      // 匹配: 1. xxx / - xxx / * xxx / 1) xxx
      const m = line.match(/^\s*(?:\d+[\.\)]\s*|[-*]\s+)(.+)/);
      if (m && m[1].trim().length > 5) {
        steps.push({
          description: m[1].trim(),
          status: 'pending',
          keywords: this.#extractKeywords(m[1]),
        });
      }
    }
    return steps;
  }

  /**
   * 从步骤描述中提取关键词（用于模糊匹配工具调用）
   * @param {string} text
   * @returns {string[]}
   * @private
   */
  #extractKeywords(text) {
    // 提取反引号/引号内的标识符
    const quoted = [...text.matchAll(/[`"']([A-Za-z_]\w{2,})[`"']/g)].map(m => m[1]);
    // 提取 CamelCase 词
    const camelCase = [...text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)].map(m => m[0]);
    // 提取全大写缩写 (如 API, HTTP, URL)
    const acronyms = [...text.matchAll(/\b([A-Z]{2,}[a-z]\w+)\b/g)].map(m => m[0]);
    return [...new Set([...quoted, ...camelCase, ...acronyms])];
  }

  /**
   * 可序列化输出
   * @returns {object}
   */
  toJSON() {
    return {
      rounds: this.#rounds.map(r => ({ ...r })),
      stats: this.getStats(),
      ...(this.#plan ? {
        plan: {
          text: this.#plan.text,
          steps: this.#plan.steps.map(s => ({ ...s })),
          createdAtIteration: this.#plan.createdAtIteration,
          lastUpdatedAtIteration: this.#plan.lastUpdatedAtIteration,
        },
        planHistory: this.#planHistory.length,
      } : {}),
    };
  }
}

export default ReasoningTrace;
