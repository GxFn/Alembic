/**
 * PipelineStrategy — 顺序多阶段执行策略
 *
 * 从 strategies.js 提取的独立模块。
 * 每个阶段可以有不同的 Capability 和 Budget，
 * 阶段间可插入质量门控 (Quality Gate)。
 *
 * 等价于 Anthropic 的 "Prompt Chaining" + "Evaluator-Optimizer"。
 *
 * 增强特性 (v3):
 *   - Gate 支持自定义 evaluator 函数 (三态: pass/retry/degrade)
 *   - Gate retry: 失败时回退重新执行前一阶段
 *   - Stage 支持 promptBuilder(context), systemPrompt, onToolCall
 *   - Per-stage 硬超时保护
 *   - 阶段隔离 (ContextWindow/ExplorationTracker 状态)
 *
 * @module PipelineStrategy
 */

import Logger from '../../infrastructure/logging/Logger.js';
import { AgentEventBus, AgentEvents } from './AgentEventBus.js';
import { ExplorationTracker } from './context/ExplorationTracker.js';
import { Strategy, StrategyRegistry } from './strategies.js';

const _pipelineLogger = Logger.getInstance();

export class PipelineStrategy extends Strategy {
  /** @type {Array<Object>} */
  #stages: any[];

  /** @type {number} 最大重试次数 (Gate 失败时全局兜底) */
  #maxRetries;

  constructor({ stages = [], maxRetries = 1 } = {}) {
    super();
    this.#stages = stages;
    this.#maxRetries = maxRetries;
  }

  get name() {
    return 'pipeline';
  }

  async execute(runtime: any, message: any, opts: any = {}) {
    const bus = AgentEventBus.getInstance();
    const ctx = {
      phaseResults: {},
      strategyContext: opts.strategyContext || {},
      totalToolCalls: [],
      totalTokenUsage: { input: 0, output: 0 },
      totalIterations: 0,
      gateArtifact: null,
      degraded: false,
      execStageCount: 0,
      lastExecutedStageName: null,
    };

    for (let i = 0; i < this.#stages.length; i++) {
      const stage = this.#stages[i];

      // ── Quality Gate 阶段 ──
      if (stage.gate) {
        if (ctx.degraded) {
          continue;
        }
        const gateAction = this.#processGate(stage, i, ctx, bus);
        if (gateAction === 'break') {
          break;
        }
        if (gateAction === 'continue') {
          continue;
        }
        if (typeof gateAction === 'number') {
          i = gateAction; // retry: jump back
          continue;
        }
        break; // unknown action fallback
      }

      // ── 执行阶段 ──
      if (ctx.degraded && stage.skipOnDegrade !== false) {
        continue;
      }

      await this.#executeStage(runtime, message, stage, ctx, bus);
    }

    // 最终回复 = 最后一个执行阶段的输出
    const lastStage = Object.values(ctx.phaseResults)
      .filter((r: any) => r.reply)
      .pop();

    return {
      reply: (lastStage as any)?.reply || '',
      toolCalls: ctx.totalToolCalls,
      tokenUsage: ctx.totalTokenUsage,
      iterations: ctx.totalIterations,
      phases: ctx.phaseResults,
      degraded: ctx.degraded,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // Private: Gate 处理
  // ═══════════════════════════════════════════════════════════

  /**
   * 处理 Quality Gate 阶段
   *
   * @returns {'break'|'continue'|number} - break/continue 或 retry 回退索引 (i-1)
   */
  #processGate(stage: any, stageIndex: any, ctx: any, bus: any) {
    const { phaseResults, strategyContext } = ctx;
    const sourceName = stage.source || this.#prevStageName(stage);
    const source = phaseResults[sourceName];
    let gateResult;

    // v3: 自定义评估器 (Bootstrap 用)
    if (typeof stage.gate.evaluator === 'function') {
      gateResult = stage.gate.evaluator(source, phaseResults, strategyContext);
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
    if (gateResult.artifact) {
      ctx.gateArtifact = gateResult.artifact;
    }

    // 三态处理
    if (gateResult.action === 'pass') {
      return 'continue';
    }

    if (gateResult.action === 'degrade') {
      ctx.degraded = true;
      return 'break';
    }

    if (gateResult.action === 'retry') {
      const maxRetries = stage.gate.maxRetries ?? this.#maxRetries;
      const retryKey = `_retries_${stage.name || 'gate'}`;
      phaseResults[retryKey] = (phaseResults[retryKey] || 0) + 1;

      if (phaseResults[retryKey] <= maxRetries) {
        const prevIdx = this.#findPrevExecStageIdx(stageIndex);
        if (prevIdx >= 0) {
          const retryTargetStage = this.#stages[prevIdx];
          phaseResults._retryContext = {
            reason: gateResult.reason,
            artifact: gateResult.artifact,
          };
          phaseResults[`_was_retry_${retryTargetStage.name}`] = true;
          return prevIdx - 1; // 循环 i++ 后回到 prevIdx
        }
      }
      // 重试次数耗尽
      if (stage.skipOnFail !== false) {
        return 'break';
      }
      return 'continue';
    }

    // 兜底: 未知 action
    if (stage.skipOnFail !== false) {
      return 'break';
    }
    return 'continue';
  }

  // ═══════════════════════════════════════════════════════════
  // Private: Stage 执行
  // ═══════════════════════════════════════════════════════════

  /**
   * 执行单个 Pipeline 阶段
   */
  async #executeStage(runtime: any, message: any, stage: any, ctx: any, bus: any) {
    const { phaseResults, strategyContext } = ctx;

    bus.publish(AgentEvents.PROGRESS, {
      type: 'pipeline_stage_start',
      stage: stage.name,
      capabilities: stage.capabilities?.map((c: any) => (typeof c === 'string' ? c : c.name)),
    });

    // 构建阶段 prompt
    const stagePrompt = this.#buildStagePrompt(stage, message, phaseResults, strategyContext, ctx);

    // Budget (retry 时使用 retryBudget)
    const isRetry = !!phaseResults[`_was_retry_${stage.name}`];
    const effectiveBudget = isRetry && stage.retryBudget ? stage.retryBudget : stage.budget;
    delete phaseResults[`_was_retry_${stage.name}`];

    // 阶段隔离 (ContextWindow + ExplorationTracker)
    const ctxWin = strategyContext.contextWindow || null;
    const isNewStage = ctx.lastExecutedStageName !== stage.name;
    if (ctxWin && ctx.execStageCount > 0 && isNewStage) {
      ctxWin.resetForNewStage();
    } else if (ctxWin && ctx.execStageCount > 0 && !isNewStage) {
      _pipelineLogger.info(
        `[PipelineStrategy] ♻️ Retry stage "${stage.name}" — preserving ContextWindow (${ctxWin.tokenCount || 0} tokens)`
      );
    }

    // ExplorationTracker (per-stage)
    const stageTracker = this.#resolveStageTracker(stage, ctx, strategyContext, effectiveBudget);

    ctx.lastExecutedStageName = stage.name;
    ctx.execStageCount++;

    const submitToolName = stage.submitToolName || strategyContext.submitToolName || undefined;
    _pipelineLogger.info(
      `[PipelineStrategy] ▶ Stage "${stage.name}"${isRetry ? ' (retry)' : ''} — ` +
        `budget: ${effectiveBudget?.maxIterations || '∞'} iters, ` +
        `timeout: ${effectiveBudget?.timeoutMs ? `${effectiveBudget.timeoutMs / 1000}s` : '∞'}, ` +
        `tracker: ${stageTracker?.constructor?.name || 'none'}` +
        `${submitToolName ? `, submitTool: ${submitToolName}` : ''}`
    );

    // 执行 reactLoop (含 per-stage 硬超时保护)
    const stageResult = await this.#runWithTimeout(
      runtime,
      stagePrompt,
      message,
      stage,
      effectiveBudget,
      ctxWin,
      stageTracker,
      strategyContext,
      phaseResults,
      bus
    );

    // 累计结果
    phaseResults[stage.name] = stageResult;
    ctx.totalToolCalls.push(...(stageResult.toolCalls || []));
    ctx.totalIterations += stageResult.iterations || 0;
    if (stageResult.tokenUsage) {
      ctx.totalTokenUsage.input += stageResult.tokenUsage.input || 0;
      ctx.totalTokenUsage.output += stageResult.tokenUsage.output || 0;
    }

    _pipelineLogger.info(
      `[PipelineStrategy] ✅ Stage "${stage.name}" done — ` +
        `${stageResult.iterations || 0} iters, ${stageResult.toolCalls?.length || 0} tool calls, ` +
        `reply: ${stageResult.reply?.length || 0} chars${stageResult.timedOut ? ' (TIMED OUT)' : ''}`
    );

    bus.publish(AgentEvents.PROGRESS, {
      type: 'pipeline_stage_done',
      stage: stage.name,
      iterations: stageResult.iterations,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Private: Helpers
  // ═══════════════════════════════════════════════════════════

  /**
   * 构建阶段 prompt (优先级: retryPromptBuilder > promptBuilder > promptTransform > 原始)
   */
  #buildStagePrompt(stage: any, message: any, phaseResults: any, strategyContext: any, ctx: any) {
    let prompt;
    if (phaseResults._retryContext && stage.retryPromptBuilder) {
      prompt = stage.retryPromptBuilder(phaseResults._retryContext, message.content, phaseResults);
      delete phaseResults._retryContext;
    } else if (stage.promptBuilder) {
      prompt = stage.promptBuilder({
        message: message.content,
        phaseResults,
        gateArtifact: ctx.gateArtifact,
        ...strategyContext,
      });
    } else if (stage.promptTransform) {
      prompt = stage.promptTransform(message.content, phaseResults);
    } else {
      prompt = message.content;
    }

    // 清除已消费的 retryContext
    if (phaseResults._retryContext) {
      delete phaseResults._retryContext;
    }
    return prompt;
  }

  /**
   * 为阶段解析 ExplorationTracker
   */
  #resolveStageTracker(stage: any, ctx: any, strategyContext: any, effectiveBudget: any) {
    let stageTracker = strategyContext.tracker || null;
    const submitToolName = stage.submitToolName || strategyContext.submitToolName || undefined;

    if (stageTracker && ctx.execStageCount > 0) {
      const trackerStrategy =
        stage.name === 'produce' || stage.name === 'producer' ? 'producer' : 'analyst';
      stageTracker = ExplorationTracker.resolve(
        { source: strategyContext.source || 'system', strategy: trackerStrategy },
        {
          ...(effectiveBudget || {}),
          ...(submitToolName ? { submitToolName } : {}),
        }
      );
    } else if (stageTracker && ctx.execStageCount === 0 && submitToolName) {
      if (stageTracker.submitToolName !== submitToolName) {
        stageTracker = ExplorationTracker.resolve(
          { source: strategyContext.source || 'system', strategy: 'analyst' },
          { ...(effectiveBudget || {}), submitToolName }
        );
      }
    }

    return stageTracker;
  }

  /**
   * 执行 reactLoop 并添加硬超时保护
   */
  async #runWithTimeout(
    runtime: any,
    stagePrompt: any,
    message: any,
    stage: any,
    effectiveBudget: any,
    ctxWin: any,
    stageTracker: any,
    strategyContext: any,
    phaseResults: any,
    bus: any
  ) {
    const reactPromise = runtime.reactLoop(stagePrompt, {
      history: message.history,
      context: {
        ...message.metadata.context,
        pipelinePhase: stage.name,
        previousPhases: phaseResults,
      },
      capabilityOverride: stage.capabilities,
      budgetOverride: effectiveBudget,
      systemPromptOverride: stage.systemPrompt,
      onToolCall: stage.onToolCall,
      contextWindow: ctxWin,
      tracker: stageTracker,
      trace: strategyContext.trace || null,
      memoryCoordinator: strategyContext.memoryCoordinator || null,
      sharedState: strategyContext.sharedState || null,
      source: strategyContext.source || null,
    });

    const stageTimeoutMs = effectiveBudget?.timeoutMs;
    if (!stageTimeoutMs) {
      return reactPromise;
    }

    // 硬超时 = budget.timeoutMs + 30s 缓冲
    const hardLimitMs = stageTimeoutMs + 30_000;
    let hardTimer: any;

    return Promise.race([
      reactPromise,
      new Promise((_, reject) => {
        hardTimer = setTimeout(() => reject(new Error('__STAGE_HARD_TIMEOUT__')), hardLimitMs);
      }),
    ])
      .catch((err) => {
        if (err.message === '__STAGE_HARD_TIMEOUT__') {
          runtime.logger?.info?.(
            `[PipelineStrategy] ⏰ Stage "${stage.name}" hard timeout (${hardLimitMs}ms) — continuing pipeline`
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
      })
      .finally(() => clearTimeout(hardTimer));
  }

  /**
   * 质量门控评估 (向后兼容: 阈值模式)
   */
  #evaluateGate(gateConfig: any, phaseResults: any, sourceName: any) {
    const source = phaseResults[sourceName];
    if (!source?.reply) {
      return { pass: false, reason: `No output from stage "${sourceName}"` };
    }

    const reply = source.reply;
    const reasons: string | any[] = [];

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
      if (!customResult.pass) {
        reasons.push(customResult.reason);
      }
    }

    return reasons.length === 0 ? { pass: true } : { pass: false, reason: reasons.join('; ') };
  }

  /**
   * 找到当前 gate 之前最近的执行阶段索引 (用于 retry 回退)
   */
  #findPrevExecStageIdx(currentIdx: any) {
    for (let j = currentIdx - 1; j >= 0; j--) {
      if (!this.#stages[j].gate) {
        return j;
      }
    }
    return -1;
  }

  #prevStageName(currentStage: any) {
    const idx = this.#stages.indexOf(currentStage);
    for (let i = idx - 1; i >= 0; i--) {
      if (!this.#stages[i].gate && this.#stages[i].name) {
        return this.#stages[i].name;
      }
    }
    return null;
  }
}

// 自注册: 避免 strategies.js ↔ PipelineStrategy.js 循环依赖
StrategyRegistry.register('pipeline', PipelineStrategy);
