/**
 * Strategies — Agent 执行策略
 *
 * 核心思想: "如何组织工作" 与 "能做什么" 正交。
 *
 * 四种策略:
 *   1. SingleStrategy   — 单次 ReAct 循环 (最简单，用于对话)
 *   2. PipelineStrategy — 顺序多阶段 + 质量门控 (分析→提交)
 *   3. FanOutStrategy   — 并行执行 + 合并 (多维度冷启动)
 *   4. AdaptiveStrategy — 运行时自动选择策略 (智能模式)
 *
 * 这就是为什么 "冷启动" 和 "扫描" 产出一致:
 *   - 冷启动 = FanOut(items=dimensions, itemStrategy=Pipeline(analyze→gate→produce))
 *   - 扫描   = Pipeline(analyze→gate→produce)
 *   - 唯一区别: 作用域 (全项目 vs 单目录) 和并行度
 *
 * 借鉴:
 *   - Anthropic: Prompt Chaining, Parallelization, Orchestrator-Worker
 *   - LangGraph: StateGraph, parallel branches
 *   - AutoGen: Sequential/Parallel teams
 *
 * @module strategies
 */

import { randomUUID } from 'node:crypto';
import { AgentEventBus, AgentEvents } from './AgentEventBus.js';
import { AgentMessage } from './AgentMessage.js';
import { ExplorationTracker } from './context/ExplorationTracker.js';

// ─── Base Strategy ─────────────────────────────

/**
 * Strategy 基类 — 定义 Agent 如何组织工作
 */
export class Strategy {
  /** @type {string} */
  get name() { throw new Error('Subclass must implement name'); }

  /**
   * 执行策略
   *
   * @param {Object} runtime — AgentRuntime 实例
   * @param {import('./AgentMessage.js').AgentMessage} message — 输入消息
   * @param {Object} [opts] — 策略特定选项
   * @returns {Promise<StrategyResult>}
   *
   * @typedef {Object} StrategyResult
   * @property {string} reply — 最终文本回复
   * @property {Array} toolCalls — 所有工具调用记录
   * @property {Object} tokenUsage — Token 统计
   * @property {number} iterations — 总循环次数
   * @property {Object} [phases] — 阶段详情 (Pipeline/FanOut)
   */
  async execute(_runtime, _message, _opts) {
    throw new Error('Subclass must implement execute()');
  }
}

// ─── SingleStrategy — 直接 ReAct ─────────────

/**
 * 最简单的策略: 直接运行 ReAct 循环。
 *
 * 适合: 用户对话、简单分析、任何单步骤任务。
 *
 * 等价于 Anthropic 的 "Augmented LLM" 模式。
 */
export class SingleStrategy extends Strategy {
  get name() { return 'single'; }

  async execute(runtime, message, opts = {}) {
    return runtime.reactLoop(message.content, {
      history: message.history,
      context: message.metadata.context || {},
      ...opts,
    });
  }
}

// ─── PipelineStrategy — 顺序多阶段 ──────────

/**
 * 多阶段顺序执行，每个阶段可以有不同的 Capability 和 Budget，
 * 阶段间可插入质量门控 (Quality Gate)。
 *
 * 适合: 分析→提交、扫描→审计→报告
 *
 * 等价于 Anthropic 的 "Prompt Chaining" + "Evaluator-Optimizer"。
 *
 * 增强特性 (v3):
 *   - Gate 支持自定义 evaluator 函数 (三态: pass/retry/degrade)
 *   - Gate retry: 失败时回退重新执行前一阶段
 *   - Stage 支持 promptBuilder(context) 替代简单 promptTransform
 *   - Stage 支持 systemPrompt 覆盖 (per-phase 系统提示词)
 *   - Stage 支持 onToolCall 钩子 (per-phase 工具调用通知)
 *   - strategyContext: 通过 opts 传入的领域级上下文 (Bootstrap 注入 dimConfig/sessionStore/...)
 *
 * @example
 * // 基础用法 (向后兼容)
 * new PipelineStrategy({
 *   stages: [
 *     { name: 'analyze', capabilities: ['code_analysis'], budget: { maxIterations: 16 } },
 *     { name: 'gate', gate: { minEvidenceLength: 500, minFileRefs: 3 } },
 *     { name: 'produce', capabilities: ['knowledge_production'], budget: { maxIterations: 16 },
 *       promptTransform: (input, prev) => `基于以下分析:\n${prev.analyze.reply}\n\n${input}` },
 *   ],
 * })
 *
 * @example
 * // 增强用法 (Bootstrap)
 * new PipelineStrategy({
 *   stages: [
 *     { name: 'analyze', capabilities: ['code_analysis'],
 *       systemPrompt: ANALYST_SYSTEM_PROMPT,
 *       promptBuilder: (ctx) => buildAnalystPrompt(ctx.dimConfig, ctx.projectInfo, ctx),
 *       retryPromptBuilder: (retryCtx, input, prev) => `${prev.analyze.reply}\n\n${buildRetryPrompt(retryCtx.reason)}`,
 *       onToolCall: (name, args, result, iter) => ac.recordToolCall(name, args, result, true),
 *     },
 *     { name: 'quality_gate', gate: {
 *       evaluator: (source, phaseResults, ctx) => ({ action: 'pass'|'retry'|'degrade', reason, artifact }),
 *       maxRetries: 1,
 *     }},
 *     { name: 'produce', capabilities: ['knowledge_production'],
 *       systemPrompt: PRODUCER_SYSTEM_PROMPT,
 *       promptBuilder: (ctx) => buildProducerPrompt(ctx.gateArtifact, ctx.dimConfig),
 *       skipOnDegrade: true,
 *     },
 *   ],
 * })
 */
export class PipelineStrategy extends Strategy {
  /** @type {Array<Object>} */
  #stages;
  /** @type {number} 最大重试次数 (Gate 失败时全局兜底) */
  #maxRetries;

  constructor({ stages = [], maxRetries = 1 } = {}) {
    super();
    this.#stages = stages;
    this.#maxRetries = maxRetries;
  }

  get name() { return 'pipeline'; }

  async execute(runtime, message, opts = {}) {
    const bus = AgentEventBus.getInstance();
    const phaseResults = {};
    const strategyContext = opts.strategyContext || {};
    let totalToolCalls = [];
    let totalTokenUsage = { input: 0, output: 0 };
    let totalIterations = 0;
    let gateArtifact = null;
    let degraded = false;
    let execStageCount = 0;  // 已执行的阶段计数 (用于阶段隔离)

    for (let i = 0; i < this.#stages.length; i++) {
      const stage = this.#stages[i];

      // ── Quality Gate 阶段 ──
      if (stage.gate) {
        // 跳过 degrade 之后的 gate
        if (degraded) continue;

        const sourceName = stage.source || this.#prevStageName(stage);
        const source = phaseResults[sourceName];
        let gateResult;

        // v3: 自定义评估器 (Bootstrap 用)
        if (typeof stage.gate.evaluator === 'function') {
          gateResult = stage.gate.evaluator(source, phaseResults, strategyContext);
          // 规范化: 确保 action 字段存在
          if (!gateResult.action) {
            gateResult.action = gateResult.pass ? 'pass' : 'retry';
          }
        } else {
          // 向后兼容: 阈值评估
          const legacyResult = this.#evaluateGate(stage.gate, phaseResults, sourceName);
          gateResult = {
            action: legacyResult.pass ? 'pass' : 'retry',
            pass: legacyResult.pass,
            reason: legacyResult.reason,
          };
        }

        bus.publish(AgentEvents.PROGRESS, {
          type: 'quality_gate',
          pass: gateResult.action === 'pass',
          action: gateResult.action,
          reason: gateResult.reason,
          stage: stage.name || 'gate',
        });

        // 存储 gate 结果和产物
        phaseResults[stage.name || 'gate'] = {
          pass: gateResult.action === 'pass',
          action: gateResult.action,
          reason: gateResult.reason || '',
          artifact: gateResult.artifact || null,
        };
        if (gateResult.artifact) gateArtifact = gateResult.artifact;

        // v3: 三态处理
        if (gateResult.action === 'pass') {
          continue;
        }

        if (gateResult.action === 'degrade') {
          degraded = true;
          break;
        }

        if (gateResult.action === 'retry') {
          const maxRetries = stage.gate.maxRetries ?? this.#maxRetries;
          const retryKey = `_retries_${stage.name || 'gate'}`;
          phaseResults[retryKey] = (phaseResults[retryKey] || 0) + 1;

          if (phaseResults[retryKey] <= maxRetries) {
            const prevIdx = this.#findPrevExecStageIdx(i);
            if (prevIdx >= 0) {
              const retryTargetStage = this.#stages[prevIdx];
              phaseResults._retryContext = {
                reason: gateResult.reason,
                artifact: gateResult.artifact,
              };
              // 标记目标阶段为 retry, 供 retryBudget 判定
              phaseResults[`_was_retry_${retryTargetStage.name}`] = true;
              i = prevIdx - 1; // 循环 i++ 后回到 prevIdx
              continue;
            }
          }
          // 重试次数耗尽: 向后兼容 skipOnFail 逻辑
          if (stage.skipOnFail !== false) break;
          continue;
        }

        // 兜底: 未知 action 视为失败
        if (stage.skipOnFail !== false) break;
        continue;
      }

      // ── 执行阶段 ──

      // 跳过 degrade 后的阶段 (除非显式标记 skipOnDegrade: false)
      if (degraded && stage.skipOnDegrade !== false) continue;

      bus.publish(AgentEvents.PROGRESS, {
        type: 'pipeline_stage_start',
        stage: stage.name,
        capabilities: stage.capabilities?.map(c => typeof c === 'string' ? c : c.name),
      });

      // 构建阶段 prompt (优先级: retryPromptBuilder > promptBuilder > promptTransform > 原始)
      let stagePrompt;
      if (phaseResults._retryContext && stage.retryPromptBuilder) {
        stagePrompt = stage.retryPromptBuilder(
          phaseResults._retryContext, message.content, phaseResults,
        );
        delete phaseResults._retryContext;
      } else if (stage.promptBuilder) {
        // v3: 完整上下文感知的 prompt 构建
        stagePrompt = stage.promptBuilder({
          message: message.content,
          phaseResults,
          gateArtifact,
          ...strategyContext,
        });
      } else if (stage.promptTransform) {
        stagePrompt = stage.promptTransform(message.content, phaseResults);
      } else {
        stagePrompt = message.content;
      }

      // 清除已消费的 retryContext
      if (phaseResults._retryContext) delete phaseResults._retryContext;

      // Fork runtime with stage-specific capabilities and budget
      // v3.1: retry 时使用 retryBudget (缩减预算, 如 Producer 拒绝修正轮)
      const isRetry = !!phaseResults[`_was_retry_${stage.name}`];
      const effectiveBudget = (isRetry && stage.retryBudget) ? stage.retryBudget : stage.budget;
      delete phaseResults[`_was_retry_${stage.name}`];

      // ── 阶段隔离 (v3.2) ──
      // 避免 ContextWindow / ExplorationTracker 状态在阶段间泄漏
      const ctxWin = strategyContext.contextWindow || null;
      if (ctxWin && execStageCount > 0) {
        ctxWin.resetForNewStage();
      }

      // 为每个阶段创建适当范围的 ExplorationTracker:
      //   - analyze → 复用 orchestrator 创建的 bootstrap tracker (首个阶段)
      //   - produce → 创建 producer 策略的独立 tracker
      //   - 其他   → 创建 analyst 策略的独立 tracker
      let stageTracker = strategyContext.tracker || null;
      if (stageTracker && execStageCount > 0) {
        const trackerStrategy = (stage.name === 'produce' || stage.name === 'producer')
          ? 'producer'
          : 'analyst';
        // 从 stage 配置中读取提交工具名，透传给 ExplorationTracker
        const submitToolName = stage.submitToolName || strategyContext.submitToolName || undefined;
        stageTracker = ExplorationTracker.resolve(
          { source: strategyContext.source || 'system', strategy: trackerStrategy },
          { ...(effectiveBudget || {}), ...(submitToolName ? { submitToolName } : {}) },
        );
      }
      execStageCount++;

      // ── 执行 reactLoop (含 per-stage 硬超时保护) ──
      const reactPromise = runtime.reactLoop(stagePrompt, {
        history: message.history,
        context: { ...message.metadata.context, pipelinePhase: stage.name, previousPhases: phaseResults },
        capabilityOverride: stage.capabilities,
        budgetOverride: effectiveBudget,
        systemPromptOverride: stage.systemPrompt,     // v3: per-phase 系统提示词
        onToolCall: stage.onToolCall,                  // v3: per-phase 工具调用钩子
        // ── 引擎增强参数: 从 strategyContext 透传 (tracker 使用阶段级实例) ──
        contextWindow: ctxWin,
        tracker: stageTracker,
        trace: strategyContext.trace || null,
        memoryCoordinator: strategyContext.memoryCoordinator || null,
        sharedState: strategyContext.sharedState || null,
        source: strategyContext.source || null,
      });

      // ── Per-stage hard timeout (安全网) ──
      // 协作超时由 AgentRuntime.#shouldExit() 中的 budget.timeoutMs 检查处理 (优雅退出)
      // 此处的硬超时 = budget.timeoutMs + 30s 缓冲，防止单次 LLM/Tool 调用阻塞过久
      const stageTimeoutMs = effectiveBudget?.timeoutMs;
      let stageResult;
      if (stageTimeoutMs) {
        const hardLimitMs = stageTimeoutMs + 30_000;
        let hardTimer;
        stageResult = await Promise.race([
          reactPromise,
          new Promise((_, reject) => {
            hardTimer = setTimeout(
              () => reject(new Error('__STAGE_HARD_TIMEOUT__')),
              hardLimitMs,
            );
          }),
        ]).catch(err => {
          if (err.message === '__STAGE_HARD_TIMEOUT__') {
            runtime.logger?.info?.(
              `[PipelineStrategy] ⏰ Stage "${stage.name}" hard timeout (${hardLimitMs}ms) — continuing pipeline`,
            );
            bus.publish(AgentEvents.PROGRESS, {
              type: 'pipeline_stage_timeout',
              stage: stage.name,
              timeoutMs: hardLimitMs,
            });
            return {
              reply: '',
              toolCalls: [],
              iterations: 0,
              tokenUsage: { input: 0, output: 0 },
              timedOut: true,
            };
          }
          throw err;
        }).finally(() => clearTimeout(hardTimer));
      } else {
        stageResult = await reactPromise;
      }

      phaseResults[stage.name] = stageResult;
      totalToolCalls.push(...(stageResult.toolCalls || []));
      totalIterations += stageResult.iterations || 0;
      if (stageResult.tokenUsage) {
        totalTokenUsage.input += stageResult.tokenUsage.input || 0;
        totalTokenUsage.output += stageResult.tokenUsage.output || 0;
      }

      bus.publish(AgentEvents.PROGRESS, {
        type: 'pipeline_stage_done',
        stage: stage.name,
        iterations: stageResult.iterations,
      });
    }

    // 最终回复 = 最后一个执行阶段的输出
    const lastStage = Object.values(phaseResults).filter(r => r.reply).pop();

    return {
      reply: lastStage?.reply || '',
      toolCalls: totalToolCalls,
      tokenUsage: totalTokenUsage,
      iterations: totalIterations,
      phases: phaseResults,
      degraded,
    };
  }

  /**
   * 质量门控评估 (向后兼容: 阈值模式)
   */
  #evaluateGate(gateConfig, phaseResults, sourceName) {
    const source = phaseResults[sourceName];
    if (!source?.reply) {
      return { pass: false, reason: `No output from stage "${sourceName}"` };
    }

    const reply = source.reply;
    const reasons = [];

    if (gateConfig.minEvidenceLength && reply.length < gateConfig.minEvidenceLength) {
      reasons.push(`分析长度不足: ${reply.length} < ${gateConfig.minEvidenceLength}`);
    }

    if (gateConfig.minFileRefs) {
      const fileRefCount = (reply.match(/[\w/]+\.\w+/g) || []).length;
      if (fileRefCount < gateConfig.minFileRefs) {
        reasons.push(`文件引用不足: ${fileRefCount} < ${gateConfig.minFileRefs}`);
      }
    }

    if (gateConfig.minToolCalls) {
      const toolCalls = source.toolCalls?.length || 0;
      if (toolCalls < gateConfig.minToolCalls) {
        reasons.push(`工具调用不足: ${toolCalls} < ${gateConfig.minToolCalls}`);
      }
    }

    if (gateConfig.custom && typeof gateConfig.custom === 'function') {
      const customResult = gateConfig.custom(source);
      if (!customResult.pass) reasons.push(customResult.reason);
    }

    return reasons.length === 0
      ? { pass: true }
      : { pass: false, reason: reasons.join('; ') };
  }

  /**
   * 找到当前 gate 之前最近的执行阶段索引 (用于 retry 回退)
   */
  #findPrevExecStageIdx(currentIdx) {
    for (let j = currentIdx - 1; j >= 0; j--) {
      if (!this.#stages[j].gate) return j;
    }
    return -1;
  }

  #prevStageName(currentStage) {
    const idx = this.#stages.indexOf(currentStage);
    for (let i = idx - 1; i >= 0; i--) {
      if (!this.#stages[i].gate && this.#stages[i].name) {
        return this.#stages[i].name;
      }
    }
    return null;
  }
}

// ─── FanOutStrategy — 并行执行 ──────────────

/**
 * 并行执行多个子任务，每个子任务使用 itemStrategy (通常是 Pipeline)。
 * 支持分层并发控制 (Tier)。
 *
 * 适合: 冷启动多维度、批量分析
 *
 * 等价于 Anthropic 的 "Parallelization" + "Orchestrator-Worker" 组合。
 *
 * @example
 * new FanOutStrategy({
 *   itemStrategy: new PipelineStrategy({
 *     stages: [
 *       { name: 'analyze', capabilities: ['code_analysis'], budget: { maxIterations: 24 } },
 *       { name: 'gate', gate: { minEvidenceLength: 500, minFileRefs: 3 } },
 *       { name: 'produce', capabilities: ['knowledge_production'], budget: { maxIterations: 24 },
 *         promptTransform: (_, prev) => `将以下分析转为知识候选:\n${prev.analyze.reply}` },
 *     ],
 *   }),
 *   tiers: { 1: { concurrency: 3 }, 2: { concurrency: 2 }, 3: { concurrency: 1 } },
 * })
 */
export class FanOutStrategy extends Strategy {
  /** @type {Strategy} 每个子任务的执行策略 */
  #itemStrategy;
  /** @type {Object} 分层并发配置 */
  #tiers;
  /** @type {Function} 结果合并函数 */
  #merge;

  /**
   * @param {Object} opts
   * @param {Strategy} opts.itemStrategy — 每个子任务使用的策略
   * @param {Object} [opts.tiers] — { 1: { concurrency: 3 }, 2: { concurrency: 2 }, ... }
   * @param {Function} [opts.merge] — 自定义合并函数 (results[]) => finalResult
   */
  constructor({ itemStrategy, tiers, merge } = {}) {
    super();
    this.#itemStrategy = itemStrategy || new SingleStrategy();
    this.#tiers = tiers || { 1: { concurrency: 3 } };
    this.#merge = merge || FanOutStrategy.#defaultMerge;
  }

  get name() { return 'fan_out'; }

  /**
   * @param {Object} runtime
   * @param {import('./AgentMessage.js').AgentMessage} message
   * @param {Object} opts
   * @param {Array<{id: string, label: string, tier?: number, prompt?: string, guide?: string}>} opts.items — 子任务列表
   */
  async execute(runtime, message, opts = {}) {
    const { items = [] } = opts;
    const bus = AgentEventBus.getInstance();

    if (items.length === 0) {
      return { reply: 'No items to process', toolCalls: [], tokenUsage: { input: 0, output: 0 }, iterations: 0 };
    }

    // 按 tier 分组
    const tierGroups = this.#groupByTier(items);
    const allResults = [];

    for (const [tier, tierItems] of Object.entries(tierGroups).sort(([a], [b]) => a - b)) {
      const tierConfig = this.#tiers[tier] || this.#tiers[1] || { concurrency: 2 };

      bus.publish(AgentEvents.PROGRESS, {
        type: 'fan_out_tier_start',
        tier: Number(tier),
        count: tierItems.length,
        concurrency: tierConfig.concurrency,
      });

      // 按并发度分批执行
      const chunks = this.#chunk(tierItems, tierConfig.concurrency);
      for (const chunk of chunks) {
        const chunkPromises = chunk.map(async (item) => {
          const itemMessage = AgentMessage.internal(
            item.prompt || `${message.content}\n\n## 当前维度: ${item.label}\n${item.guide || ''}`,
            {
              sessionId: message.session.id,
              dimension: item.id,
              parentAgentId: runtime.id,
              history: message.history,
              metadata: { ...message.metadata, dimension: item },
            }
          );

          bus.publish(AgentEvents.PROGRESS, {
            type: 'fan_out_item_start',
            itemId: item.id,
            label: item.label,
          });

          try {
            const result = await this.#itemStrategy.execute(runtime, itemMessage, {
              dimension: item,
            });
            return { id: item.id, label: item.label, status: 'completed', ...result };
          } catch (err) {
            return { id: item.id, label: item.label, status: 'failed', error: err.message, reply: '', toolCalls: [], tokenUsage: { input: 0, output: 0 } };
          }
        });

        const chunkResults = await Promise.all(chunkPromises);
        allResults.push(...chunkResults);
      }

      bus.publish(AgentEvents.PROGRESS, {
        type: 'fan_out_tier_done',
        tier: Number(tier),
        completed: allResults.filter(r => r.status === 'completed').length,
        failed: allResults.filter(r => r.status === 'failed').length,
      });
    }

    return this.#merge(allResults);
  }

  #groupByTier(items) {
    const groups = {};
    for (const item of items) {
      const tier = item.tier || 1;
      if (!groups[tier]) groups[tier] = [];
      groups[tier].push(item);
    }
    return groups;
  }

  #chunk(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  static #defaultMerge(results) {
    const successful = results.filter(r => r.status === 'completed');
    const failed = results.filter(r => r.status === 'failed');
    return {
      reply: [
        `## 执行总结\n完成: ${successful.length}, 失败: ${failed.length}\n`,
        ...successful.map(r => `### ${r.label}\n${r.reply || '(无输出)'}`),
        ...failed.map(r => `### ${r.label} ❌\n${r.error}`),
      ].join('\n\n'),
      toolCalls: results.flatMap(r => r.toolCalls || []),
      tokenUsage: {
        input: results.reduce((sum, r) => sum + (r.tokenUsage?.input || 0), 0),
        output: results.reduce((sum, r) => sum + (r.tokenUsage?.output || 0), 0),
      },
      iterations: results.reduce((sum, r) => sum + (r.iterations || 0), 0),
      itemResults: results,
    };
  }
}

// ─── AdaptiveStrategy — 智能自适应 ──────────

/**
 * 根据输入复杂度自动选择合适的策略。
 *
 * 判断逻辑:
 *   - 简单问答 → SingleStrategy
 *   - 单模块深度分析 → PipelineStrategy
 *   - 多维度/全项目 → FanOutStrategy
 *
 * 等价于 LangGraph 的 Router 节点 + 条件边。
 *
 * @example
 * new AdaptiveStrategy({
 *   single: new SingleStrategy(),
 *   pipeline: new PipelineStrategy({ stages: [...] }),
 *   fanOut: new FanOutStrategy({ itemStrategy: ..., tiers: ... }),
 * })
 */
export class AdaptiveStrategy extends Strategy {
  #strategies;

  /**
   * @param {Object} [strategies]
   * @param {Strategy} [strategies.single]
   * @param {Strategy} [strategies.pipeline]
   * @param {Strategy} [strategies.fanOut]
   */
  constructor(strategies = {}) {
    super();
    this.#strategies = {
      single: strategies.single || new SingleStrategy(),
      pipeline: strategies.pipeline || null,
      fanOut: strategies.fanOut || null,
    };
  }

  get name() { return 'adaptive'; }

  async execute(runtime, message, opts = {}) {
    const complexity = this.#assessComplexity(message, opts);
    const bus = AgentEventBus.getInstance();

    bus.publish(AgentEvents.PROGRESS, {
      type: 'adaptive_classification',
      complexity,
      selectedStrategy: complexity,
    });

    switch (complexity) {
      case 'fan_out':
        if (this.#strategies.fanOut) {
          return this.#strategies.fanOut.execute(runtime, message, opts);
        }
        // fallthrough
      case 'pipeline':
        if (this.#strategies.pipeline) {
          return this.#strategies.pipeline.execute(runtime, message, opts);
        }
        // fallthrough
      default:
        return this.#strategies.single.execute(runtime, message, opts);
    }
  }

  /**
   * 复杂度评估
   */
  #assessComplexity(message, opts) {
    const text = message.content.toLowerCase();

    // 有显式 items → fan_out
    if (opts.items?.length > 1) return 'fan_out';

    // 关键词启发
    if (/冷启动|cold[\s-]?start|bootstrap|全项目|所有.*维度|all.*dimensions/i.test(text)) {
      return 'fan_out';
    }

    if (/深度.*分析|扫描|审计|scan|deep.*analy|audit|知识提取|extract/i.test(text)) {
      return 'pipeline';
    }

    return 'single';
  }
}

// ─── Strategy 注册表 ─────────────────────────

export const StrategyRegistry = {
  _registry: new Map([
    ['single', SingleStrategy],
    ['pipeline', PipelineStrategy],
    ['fan_out', FanOutStrategy],
    ['adaptive', AdaptiveStrategy],
  ]),

  create(name, opts = {}) {
    const Cls = this._registry.get(name);
    if (!Cls) throw new Error(`Unknown strategy: ${name}`);
    return new Cls(opts);
  },

  register(name, cls) {
    this._registry.set(name, cls);
  },
};

export default { Strategy, SingleStrategy, PipelineStrategy, FanOutStrategy, AdaptiveStrategy, StrategyRegistry };
