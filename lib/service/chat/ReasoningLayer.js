/**
 * ReasoningLayer — ChatAgent ReAct 循环的推理中间件
 *
 * 职责:
 *   1. 管理 ReasoningTrace 生命周期
 *   2. 从 AI 响应中提取 Thought
 *   3. 从工具结果中构建结构化 Observation
 *   4. 在合适时机触发 Reflection（反思）
 *   5. 在合适时机触发 Planning（规划/重规划）
 *   6. 提供推理质量指标
 *
 * 不拥有的职责:
 *   - AI 调用 (仍由 ChatAgent 直接调 aiProvider)
 *   - 工具执行 (仍由 ChatAgent 通过 ToolRegistry)
 *   - 上下文压缩 (仍由 ContextWindow)
 *   - 阶段控制 (仍由 PhaseRouter)
 *
 * ChatAgent 在主循环的 4 个生命周期点调用:
 *   1. beforeAICall(iteration, opts)              — 开始新轮次 + 可选注入反思/规划
 *   2. afterAICall(aiResult, mode)                — 提取 Thought + 提取 Plan
 *   3. afterToolExec(name, args, result, metrics) — 构建 Observation
 *   4. afterRound(roundResults)                   — 关闭轮次 + 写入摘要 + 更新计划进度
 *
 * 回滚策略: new ReasoningLayer({ enabled: false }) 一键禁用全部功能
 *
 * @module ReasoningLayer
 */

import { ReasoningTrace } from './ReasoningTrace.js';
import Logger from '../../infrastructure/logging/Logger.js';

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

export class ReasoningLayer {
  /** @type {ReasoningTrace} */
  #trace;
  /** @type {object} */
  #config;
  /** @type {object} */
  #logger;
  /** @type {object} */
  #planProgress;
  /** @type {boolean} */
  #pendingReplan = false;

  /**
   * @param {object} [config]
   * @param {boolean} [config.enabled=true]              — 总开关
   * @param {boolean} [config.reflectionEnabled=true]    — 反思开关
   * @param {number}  [config.reflectionInterval=5]      — 周期性反思间隔轮次
   * @param {number}  [config.staleThreshold=2]          — 停滞触发阈值（连续无新信息轮次）
   * @param {boolean} [config.planningEnabled=false]     — 规划开关
   * @param {number}  [config.replanInterval=8]          — 周期性重规划间隔轮次
   * @param {number}  [config.deviationThreshold=0.6]    — 偏差触发重规划的阈值
   */
  constructor(config = {}) {
    this.#config = {
      enabled: config.enabled !== false,
      reflectionEnabled: config.reflectionEnabled !== false,
      reflectionInterval: config.reflectionInterval ?? DEFAULT_REFLECTION_INTERVAL,
      staleThreshold: config.staleThreshold ?? DEFAULT_STALE_THRESHOLD,
      planningEnabled: config.planningEnabled ?? false,
      replanInterval: config.replanInterval ?? DEFAULT_REPLAN_INTERVAL,
      deviationThreshold: config.deviationThreshold ?? DEFAULT_DEVIATION_THRESHOLD,
    };
    this.#trace = new ReasoningTrace();
    this.#logger = Logger.getInstance();
    this.#planProgress = {
      coveredSteps: 0,
      totalSteps: 0,
      deviationScore: 0,
      unplannedActions: 0,
      lastReplanIteration: null,
      consecutiveOffPlan: 0,
    };
  }

  /**
   * 获取推理链引用（只读）
   * @returns {ReasoningTrace}
   */
  get trace() {
    return this.#trace;
  }

  // ─── 生命周期 Hook ────────────────────────────────────

  /**
   * Hook 1: AI 调用前
   *   - 开始新轮次
   *   - 检查是否应触发 Planning（第 1 轮 plan elicitation，或周期性 replan）
   *   - 检查是否应触发 Reflection
   *   - Planning 和 Reflection 同时触发时合并为一个 nudge
   *
   * @param {number} iteration — 当前迭代轮次
   * @param {object} [opts]
   * @param {object} [opts.explorationMetrics] — 探索指标
   * @param {object} [opts.budget]             — 预算配置 { maxIterations }
   * @param {string} [opts.phase]              — 当前 PhaseRouter 阶段
   * @returns {string|null} — 反思/规划提示（null = 不触发）
   */
  beforeAICall(iteration, { explorationMetrics, budget, phase } = {}) {
    if (!this.#config.enabled) return null;

    this.#trace.startRound(iteration);

    // ── Planning: 第 1 轮注入 plan elicitation ──
    if (this.#config.planningEnabled && iteration === 1) {
      return this.#buildPlanElicitationPrompt(budget);
    }

    // ── Planning: 周期性/偏差触发 replan ──
    let replanNudge = null;
    if (this.#config.planningEnabled && this.#trace.getPlan()) {
      replanNudge = this.#checkReplan(iteration, explorationMetrics, budget, phase);
    }

    // ── Reflection ──
    let reflectionNudge = null;
    if (this.#config.reflectionEnabled) {
      reflectionNudge = this.#checkReflection({ iteration, explorationMetrics, budget, phase });
    }

    // ── 合并 replan + reflection ──
    if (replanNudge && reflectionNudge) {
      // 两者同时触发 → 合并，避免两条独立 nudge
      return replanNudge + '\n\n' + reflectionNudge;
    }
    return replanNudge || reflectionNudge || null;
  }

  /**
   * Hook 2: AI 调用后
   *   - 从 AI 响应中提取 Thought
   *   - 从 AI 响应中提取 Plan（首次 / replan 后）
   *
   * @param {object|string} aiResult — AI 返回结果
   * @param {'native'|'text'} [mode='native'] — 调用模式
   */
  afterAICall(aiResult, mode = 'native') {
    if (!this.#config.enabled) return;

    let extractedText = null;

    if (mode === 'native') {
      // Native 模式: 当 AI 同时返回文本和工具调用时，文本就是 thought
      if (aiResult?.text && aiResult?.functionCalls?.length > 0) {
        this.#trace.setThought(aiResult.text);
        extractedText = aiResult.text;
        this.#logger.info(`[ReasoningLayer] 💭 thought: ${aiResult.text.substring(0, 150).replace(/\n/g, '↵')}…`);
      } else if (aiResult?.text) {
        extractedText = aiResult.text;
      }
    } else {
      // Text 模式: 需要从完整响应中切分出 thought 部分（Action 块之前的文本）
      const text = typeof aiResult === 'string' ? aiResult : aiResult?.text;
      extractedText = text;
      const thought = this.#extractThoughtFromText(text);
      if (thought) {
        this.#trace.setThought(thought);
        this.#logger.info(`[ReasoningLayer] 💭 thought (text): ${thought.substring(0, 150).replace(/\n/g, '↵')}…`);
      }
    }

    // ── Planning: 从 AI 响应中提取 plan ──
    if (this.#config.planningEnabled && extractedText) {
      if (!this.#trace.getPlan()) {
        // 首次: 提取初始 plan
        const planText = this.#extractPlanFromText(extractedText);
        if (planText) {
          const iteration = this.#trace.getCurrentIteration() || 1;
          this.#trace.setPlan(planText, iteration);
          const plan = this.#trace.getPlan();
          this.#planProgress.totalSteps = plan.steps.length;
          this.#logger.info(`[ReasoningLayer] 📋 plan extracted (${plan.steps.length} steps)`);
        }
      } else if (this.#pendingReplan) {
        // replan 后: 提取更新的 plan
        const replanText = this.#extractPlanFromText(extractedText);
        if (replanText) {
          const iteration = this.#trace.getCurrentIteration() || 1;
          this.#trace.updatePlan(replanText, iteration);
          const plan = this.#trace.getPlan();
          // 重置进度追踪
          this.#planProgress.coveredSteps = plan.steps.filter(s => s.status === 'done').length;
          this.#planProgress.totalSteps = plan.steps.length;
          this.#planProgress.unplannedActions = 0;
          this.#planProgress.consecutiveOffPlan = 0;
          this.#pendingReplan = false;
          this.#logger.info(`[ReasoningLayer] 📋 plan updated (${plan.steps.length} steps)`);
        }
      }
    }
  }

  /**
   * Hook 3: 单个工具执行后
   *   - 记录 Action
   *   - 构建结构化 Observation
   *
   * @param {string} toolName
   * @param {object} args
   * @param {any} result — 工具返回的原始结果
   * @param {object} [explorationMetrics] — 探索指标（用于判断是否新信息）
   */
  afterToolExec(toolName, args, result, explorationMetrics) {
    if (!this.#config.enabled) return;

    this.#trace.addAction(toolName, args);

    const meta = this.#buildObservationMeta(toolName, args, result, explorationMetrics);
    this.#trace.addObservation(toolName, meta);
  }

  /**
   * Hook 4: 本轮所有工具执行后
   *   - 写入轮次摘要
   *   - 更新计划进度
   *   - 关闭当前轮次
   *
   * @param {object} [roundResults]
   * @param {number} [roundResults.newInfoCount]     — 本轮获取新信息的工具数
   * @param {number} [roundResults.totalCalls]       — 本轮工具调用总数
   * @param {number} [roundResults.submitCount]      — 本轮提交候选数
   * @param {object} [roundResults.explorationMetrics] — 探索指标
   */
  afterRound({ newInfoCount, totalCalls, submitCount, explorationMetrics } = {}) {
    if (!this.#config.enabled) return;

    this.#trace.setRoundSummary({
      newInfoCount: newInfoCount || 0,
      totalCalls: totalCalls || 0,
      submits: submitCount || 0,
      cumulativeFiles: explorationMetrics?.uniqueFiles?.size || 0,
      cumulativePatterns: explorationMetrics?.uniquePatterns?.size || 0,
    });

    // ── Planning: 更新 plan 进度 ──
    if (this.#config.planningEnabled && this.#trace.getPlan()) {
      this.#updatePlanProgress();
    }

    this.#trace.endRound();
  }

  /**
   * 推理质量评分（最终回传给调用方）
   *
   * 评分维度:
   *   Planning 未启用时:
   *     - thoughtRatio: 有推理文本的轮次占比 (权重 40%)
   *     - reflectionRatio: 有反思的轮次占比 (权重 20%)
   *     - actionEfficiency: 平均每轮 action 数 (权重 20%)
   *     - observationCoverage: 有结构化观察的轮次占比 (权重 20%)
   *   Planning 启用时 (有 plan):
   *     - thoughtRatio: 30%, reflectionRatio: 15%, actionEfficiency: 15%
   *     - observationCoverage: 15%, planScore: 25%
   *
   * @returns {{ score: number, breakdown: object }}
   */
  getQualityMetrics() {
    const stats = this.#trace.getStats();
    const totalRounds = stats.totalRounds || 1; // 避免除零

    const thoughtRatio = stats.thoughtCount / totalRounds;
    const reflectionRatio = stats.reflectionCount / totalRounds;
    const actionEfficiency = Math.min(stats.totalActions / totalRounds / 3, 1); // 每轮 3 个 action 为满分
    const observationCoverage = stats.totalObservations > 0 ? 1 : 0;

    // ── Planning 指标 ──
    const plan = this.#trace.getPlan();
    const hasPlan = plan && plan.steps.length > 0;
    let planScore = 0;
    if (hasPlan) {
      const completionRate = this.#planProgress.totalSteps > 0
        ? this.#planProgress.coveredSteps / this.#planProgress.totalSteps
        : 0;
      const adherenceRate = 1 - (this.#planProgress.deviationScore || 0);
      planScore = completionRate * 0.6 + adherenceRate * 0.4;
    }

    const score = hasPlan
      ? Math.round(
          (thoughtRatio * 0.30 +
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

  /**
   * 获取当前计划进度（供外部查询）
   * @returns {object}
   */
  getPlanProgress() {
    return { ...this.#planProgress };
  }

  // ─── 内部方法 ──────────────────────────────────────────

  /**
   * 判断是否应该触发反思 + 生成反思内容
   *
   * 触发条件（任一满足）:
   *   1. 周期性: 每 reflectionInterval 轮
   *   2. 停滞: 连续 N 轮无新信息 (staleRounds >= staleThreshold)
   *
   * @param {object} opts
   * @returns {string|null}
   * @private
   */
  #checkReflection({ iteration, explorationMetrics, budget, phase }) {
    const interval = this.#config.reflectionInterval;
    const staleThreshold = this.#config.staleThreshold;

    // 触发条件
    const periodicTrigger = iteration > 1 && interval > 0 && iteration % interval === 0;
    const staleTrigger = explorationMetrics?.staleRounds >= staleThreshold
                         && iteration >= MIN_ITERS_FOR_STALE_REFLECTION;

    if (!periodicTrigger && !staleTrigger) return null;

    const summary = this.#trace.getRecentSummary(interval || 3);
    if (!summary) return null;

    const stats = this.#trace.getStats();
    const maxIter = budget?.maxIterations || 30;
    const remaining = maxIter - iteration;
    const progressPct = Math.round((iteration / maxIter) * 100);

    // ── 构建反思提示 ──
    const parts = [];

    if (staleTrigger) {
      parts.push(`📊 停滞反思 (第 ${iteration}/${maxIter} 轮, 连续 ${explorationMetrics.staleRounds} 轮无新信息):`);
    } else {
      parts.push(`📊 中期反思 (第 ${iteration}/${maxIter} 轮, ${progressPct}% 预算):`);
    }

    // 过去推理回顾
    if (summary.thoughts.length > 0) {
      parts.push(`\n你最近的思考方向:\n${summary.thoughts.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}`);
    }

    // 行动效率统计
    parts.push(`\n行动效率: 最近 ${summary.roundCount} 轮中 ${Math.round(summary.newInfoRatio * 100)}% 获取到新信息`);

    // 累计进度
    parts.push(`累计: ${explorationMetrics?.uniqueFiles?.size || 0} 文件, ${explorationMetrics?.uniquePatterns?.size || 0} 搜索模式, ${stats.totalActions} 次工具调用`);

    // ── Planning 进度附加 ──
    if (this.#config.planningEnabled) {
      const plan = this.#trace.getPlan();
      if (plan && plan.steps.length > 0) {
        const doneCount = plan.steps.filter(s => s.status === 'done').length;
        parts.push(`\n📋 计划进度: ${doneCount}/${plan.steps.length} 步骤已完成`);
      }
    }

    // 阶段化评估问题
    if (phase === 'EXPLORE' || !phase) {
      parts.push(`\n请评估:\n1. 到目前为止最重要的发现是什么？\n2. 还有哪些关键方面未覆盖？\n3. 剩余 ${remaining} 轮，最有价值的下一步是什么？`);
    } else if (phase === 'PRODUCE') {
      parts.push(`\n请评估:\n1. 已提交的候选是否覆盖了核心发现？\n2. 是否有高价值知识点被遗漏？`);
    }

    const reflectionText = parts.join('\n');

    // 记录到 trace
    this.#trace.setReflection(reflectionText);

    this.#logger.info(`[ReasoningLayer] 💭 reflection triggered at iteration ${iteration} (${staleTrigger ? 'stale' : 'periodic'})`);

    return reflectionText;
  }

  /**
   * 从工具执行结果中提取结构化观察元数据
   *
   * 不改变工具结果传给 AI 的内容，只影响 ReasoningTrace 记录
   *
   * @param {string} toolName
   * @param {object} args
   * @param {any} result
   * @param {object} [metrics] — explorationMetrics
   * @returns {object}
   * @private
   */
  #buildObservationMeta(toolName, args, result, metrics) {
    const meta = {
      gotNewInfo: false,
      resultType: 'unknown',
      keyFacts: [],
      resultSize: 0,
    };

    const resultStr = typeof result === 'string' ? result : JSON.stringify(result || '');
    meta.resultSize = resultStr.length;

    switch (toolName) {
      case 'search_project_code': {
        meta.resultType = 'search';
        const matches = result?.matches || [];
        const batchResults = result?.batchResults;
        const totalMatches = batchResults
          ? Object.values(batchResults).reduce((s, br) => s + (br.matches?.length || 0), 0)
          : matches.length;
        meta.keyFacts.push(`${totalMatches} matches found`);
        // 新文件检测
        if (metrics?.uniqueFiles) {
          const allFiles = [];
          for (const m of matches) {
            if (m.file) allFiles.push(m.file);
          }
          if (batchResults) {
            for (const sub of Object.values(batchResults)) {
              for (const m of (sub.matches || [])) {
                if (m.file) allFiles.push(m.file);
              }
            }
          }
          const newFiles = allFiles.filter(f => !metrics.uniqueFiles.has(f));
          meta.gotNewInfo = newFiles.length > 0;
          if (newFiles.length > 0) meta.keyFacts.push(`${newFiles.length} new files`);
        } else {
          meta.gotNewInfo = totalMatches > 0;
        }
        break;
      }

      case 'read_project_file': {
        meta.resultType = 'file_content';
        const fp = args?.filePath || '';
        const fps = args?.filePaths || [];
        const allPaths = fp ? [fp, ...fps] : fps;
        if (metrics?.uniqueFiles) {
          const newPaths = allPaths.filter(p => !metrics.uniqueFiles.has(p));
          meta.gotNewInfo = newPaths.length > 0;
        } else {
          meta.gotNewInfo = allPaths.length > 0;
        }
        meta.keyFacts.push(`read ${allPaths.length} file(s)`);
        break;
      }

      case 'submit_knowledge':
      case 'submit_with_check': {
        meta.resultType = 'submit';
        meta.gotNewInfo = true; // submit 本身就是进展
        const status = typeof result === 'object' ? (result?.status || 'ok') : 'ok';
        const title = args?.title || '(untitled)';
        meta.keyFacts.push(`submit "${title}": ${status}`);
        break;
      }

      case 'list_project_structure': {
        meta.resultType = 'structure';
        const dir = args?.directory || '/';
        if (metrics?.uniqueQueries) {
          const qKey = `list:${dir}`;
          meta.gotNewInfo = !metrics.uniqueQueries.has(qKey);
        } else {
          meta.gotNewInfo = true;
        }
        meta.keyFacts.push(`list ${dir}`);
        break;
      }

      case 'get_class_info':
      case 'get_class_hierarchy':
      case 'get_protocol_info':
      case 'get_method_overrides':
      case 'get_category_map': {
        meta.resultType = 'ast_query';
        const target = args?.className || args?.protocolName || args?.name || '';
        if (metrics?.uniqueQueries) {
          const qKey = `${toolName}:${target}`;
          meta.gotNewInfo = !metrics.uniqueQueries.has(qKey);
        } else {
          meta.gotNewInfo = true;
        }
        meta.keyFacts.push(`${toolName}(${target})`);
        break;
      }

      case 'get_project_overview': {
        meta.resultType = 'overview';
        if (metrics?.uniqueQueries) {
          meta.gotNewInfo = !metrics.uniqueQueries.has('overview');
        } else {
          meta.gotNewInfo = true;
        }
        meta.keyFacts.push('project overview');
        break;
      }

      case 'semantic_search_code':
      case 'get_file_summary':
      case 'get_previous_analysis': {
        meta.resultType = 'query';
        meta.gotNewInfo = true; // 保守假设
        meta.keyFacts.push(`${toolName}`);
        break;
      }

      default: {
        meta.resultType = 'other';
        meta.gotNewInfo = true; // 保守假设
        meta.keyFacts.push(`${toolName}`);
      }
    }

    return meta;
  }

  /**
   * 从 LLM 文本响应中提取 Thought 部分（Action 块之前的文本）
   *
   * 不改变 #parseActions 逻辑，纯粹数据提取。
   *
   * @param {string} response — LLM 完整文本响应
   * @returns {string|null}
   * @private
   */
  #extractThoughtFromText(response) {
    if (!response) return null;

    // Thought 在第一个 Action 标记之前
    const markers = [
      /```(?:action|batch_actions|tool_code)/,
      /Action\s*:\s*\w+/i,
      /<tool_call>/,
      /```json\s*\n\s*\{\s*"(?:tool|name|function)"/,
    ];

    let cutoff = response.length;
    for (const m of markers) {
      const idx = response.search(m);
      if (idx !== -1 && idx < cutoff) cutoff = idx;
    }

    const thought = response.substring(0, cutoff).trim();

    // 过短的（< 20 字符）不算有效 thought
    return thought.length >= 20 ? thought : null;
  }

  // ─── Planning 内部方法 ─────────────────────────────────

  /**
   * 构建第 1 轮的 plan elicitation prompt
   * @param {object} [budget]
   * @returns {string}
   * @private
   */
  #buildPlanElicitationPrompt(budget) {
    const maxIter = budget?.maxIterations || 30;
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
   * 检查是否应触发重规划（replan）
   *
   * 触发条件（任一满足）:
   *   1. 周期性: 距上次 replan 超过 replanInterval 轮
   *   2. 偏差: 连续 3 轮执行计划外行为 或 偏差分数超阈值
   *
   * @param {number} iteration
   * @param {object} [explorationMetrics]
   * @param {object} [budget]
   * @param {string} [phase]
   * @returns {string|null}
   * @private
   */
  #checkReplan(iteration, explorationMetrics, budget, phase) {
    const plan = this.#trace.getPlan();
    if (!plan) return null;

    const progress = this.#planProgress;
    const interval = this.#config.replanInterval;
    const deviationThreshold = this.#config.deviationThreshold;

    // 触发条件
    const baseIteration = progress.lastReplanIteration || plan.createdAtIteration;
    const periodicTrigger = interval > 0 && iteration > 1
      && (iteration - baseIteration) >= interval;
    const deviationTrigger = progress.consecutiveOffPlan >= 3
      || (progress.totalSteps > 0 && progress.deviationScore > deviationThreshold);

    if (!periodicTrigger && !deviationTrigger) return null;

    // 构建 replan nudge
    const maxIter = budget?.maxIterations || 30;
    const remaining = maxIter - iteration;

    const parts = [];

    if (deviationTrigger) {
      parts.push(`📋 计划偏差检查 (第 ${iteration}/${maxIter} 轮):`);
      if (progress.consecutiveOffPlan >= 3) {
        parts.push(`你的行为已连续 ${progress.consecutiveOffPlan} 轮偏离原定计划。`);
      }
    } else {
      parts.push(`📋 计划进度回顾 (第 ${iteration}/${maxIter} 轮):`);
    }

    // 步骤完成情况
    const doneSteps = plan.steps.filter(s => s.status === 'done');
    const pendingSteps = plan.steps.filter(s => s.status === 'pending');

    if (doneSteps.length > 0) {
      parts.push(`\n✅ 已完成 (${doneSteps.length}/${plan.steps.length}):`);
      for (const s of doneSteps) {
        parts.push(`  - ${s.description}`);
      }
    }
    if (pendingSteps.length > 0) {
      parts.push(`\n⏳ 未完成 (${pendingSteps.length}/${plan.steps.length}):`);
      for (const s of pendingSteps) {
        parts.push(`  - ${s.description}`);
      }
    }
    if (progress.unplannedActions > 0) {
      parts.push(`\n⚡ 计划外行为: ${progress.unplannedActions} 次`);
    }

    parts.push(`\n剩余 ${remaining} 轮。请评估:`);
    parts.push(`1. 未完成的步骤是否仍然相关？`);
    parts.push(`2. 是否需要根据新发现调整后续步骤？`);
    parts.push(`3. 请更新你的探索计划（用编号列表）。`);

    progress.lastReplanIteration = iteration;
    this.#pendingReplan = true;

    this.#logger.info(`[ReasoningLayer] 📋 replan triggered at iteration ${iteration} (${deviationTrigger ? 'deviation' : 'periodic'})`);

    return parts.join('\n');
  }

  /**
   * 每轮结束后更新计划进度
   *   - 将本轮工具调用与 plan 步骤进行模糊匹配
   *   - 更新步骤状态和偏差指标
   * @private
   */
  #updatePlanProgress() {
    const steps = this.#trace.getPlanStepsMutable();
    if (steps.length === 0) return;

    const actions = this.#trace.getCurrentRoundActions();
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

    // 更新偏差追踪
    if (matchedThisRound) {
      this.#planProgress.consecutiveOffPlan = 0;
    } else {
      this.#planProgress.consecutiveOffPlan++;
    }

    // 重新计算进度
    this.#planProgress.coveredSteps = steps.filter(s => s.status === 'done').length;
    this.#planProgress.totalSteps = steps.length;
    this.#planProgress.deviationScore = steps.length > 0
      ? 1 - (this.#planProgress.coveredSteps / steps.length)
      : 0;
  }

  /**
   * 模糊匹配: 将工具调用匹配到 plan 步骤
   *
   * 匹配策略:
   *   1. 步骤关键词出现在工具参数中
   *   2. 工具类型匹配步骤描述的语义
   *
   * @param {Array} steps — plan steps (mutable reference)
   * @param {object} action — { tool, params }
   * @returns {object|null} — 匹配到的 step，或 null
   * @private
   */
  #findMatchingStep(steps, action) {
    const toolName = action.tool;
    const argsStr = JSON.stringify(action.params || {}).toLowerCase();

    for (const step of steps) {
      if (step.status === 'done') continue;

      // 策略 1: 关键词匹配
      if (step.keywords?.length > 0) {
        const matched = step.keywords.some(kw => argsStr.includes(kw.toLowerCase()));
        if (matched) return step;
      }

      // 策略 2: 工具类型 → 步骤描述的语义匹配
      const desc = step.description.toLowerCase();
      if (toolName === 'get_project_overview'
        && (desc.includes('概览') || desc.includes('overview') || desc.includes('结构') || desc.includes('项目'))) {
        return step;
      }
      if (toolName === 'list_project_structure'
        && (desc.includes('目录') || desc.includes('结构') || desc.includes('structure'))) {
        return step;
      }
      if ((toolName === 'get_class_info' || toolName === 'get_class_hierarchy')
        && (desc.includes('继承') || desc.includes('类') || desc.includes('hierarchy') || desc.includes('class'))) {
        return step;
      }
      if (toolName === 'read_project_file'
        && (desc.includes('阅读') || desc.includes('read') || desc.includes('深入') || desc.includes('查看') || desc.includes('文件'))) {
        return step;
      }
      // search_project_code 匹配更宽松：任何含"搜索/查找/search"的待处理步骤
      if (toolName === 'search_project_code'
        && (desc.includes('搜索') || desc.includes('search') || desc.includes('查找') || desc.includes('分析'))) {
        return step;
      }
    }

    return null;
  }

  /**
   * 从 AI 响应文本中提取"计划"部分
   *
   * 策略:
   *   1. 查找"计划/plan/步骤"标记后的编号列表
   *   2. 如果没有明确标记，提取文本前部分的编号列表
   *
   * @param {string} text — AI 完整响应文本
   * @returns {string|null} — 提取的 plan 文本，或 null
   * @private
   */
  #extractPlanFromText(text) {
    if (!text || text.length < 30) return null;

    // 在文本的前 2000 字符中搜索计划
    const searchArea = text.substring(0, 2000);

    // 策略 1: 查找"计划"标记
    const planMarkers = [
      /(?:探索|分析)?计划[:：\s]/i,
      /(?:my\s+)?plan[:：\s]/i,
      /步骤[:：\s]/i,
      /以下是.*(?:计划|步骤)/i,
    ];

    let planStart = -1;
    for (const marker of planMarkers) {
      const match = searchArea.match(marker);
      if (match) {
        planStart = match.index + match[0].length;
        break;
      }
    }

    // 策略 2: 如果没有标记，查找第一个编号列表的起始位置
    if (planStart === -1) {
      const listMatch = searchArea.match(/\n\s*1[\.\)]\s+/);
      if (listMatch) {
        planStart = listMatch.index;
      }
    }

    if (planStart === -1) return null;

    // 从 planStart 开始提取到列表结束
    const remaining = searchArea.substring(planStart);
    const lines = remaining.split('\n');
    const planLines = [];
    let inList = false;

    for (const line of lines) {
      if (/^\s*(?:\d+[\.\)]\s+|[-*]\s+)/.test(line)) {
        inList = true;
        planLines.push(line);
      } else if (inList && line.trim() === '') {
        // 空行 — 列表可能结束
        break;
      } else if (inList) {
        // 非列表行 — 列表结束
        break;
      }
    }

    if (planLines.length < 2) return null;

    return planLines.join('\n').trim();
  }
}

export default ReasoningLayer;
