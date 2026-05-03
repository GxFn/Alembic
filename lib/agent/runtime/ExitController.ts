/**
 * ExitController — 统一 Agent 退出决策
 *
 * 合并散落在 AgentRuntime 各处的 13 条退出路径为单一检查点：
 *   - #shouldExit（abortSignal / tracker / stage timeout / policy）
 *   - #callLLM null 路径（空响应 / AI 错误 / 熔断 / toolChoice 违反）
 *   - #processToolCalls 末轮摘要
 *   - #processTextResponse 终答判定
 *
 * 设计原则：
 *   - 单一检查入口，明确优先级
 *   - 返回结构化 ExitSignal 而非分散的 boolean/null
 *   - 保留 ExplorationTracker 的 phase/grace 语义
 *   - 向后兼容：AgentRuntime 可逐步迁移到 ExitController
 *
 * @module core/ExitController
 */

import type { ExplorationTracker } from '../context/ExplorationTracker.js';
import type { StepState } from '../policies/Policy.js';
import type { LoopContext } from './LoopContext.js';

// ── Public Types ──

export type ExitReason =
  | 'abort_signal'
  | 'tracker_exit'
  | 'stage_timeout'
  | 'policy_stop'
  | 'iteration_exhausted'
  | 'token_budget_exhausted'
  | 'task_complete'
  | 'empty_response'
  | 'empty_response_terminal'
  | 'error_accumulated'
  | 'circuit_open'
  | 'tool_choice_violation';

export interface ExitSignal {
  action: 'continue' | 'exit' | 'graceful_exit' | 'retry';
  reason?: ExitReason;
  /** Whether #finalize should produce a forced summary */
  needsSummary?: boolean;
  /** Text to inject into message stream (digest/phase_transition nudge) */
  nudge?: string | null;
  /** Details for logging/diagnostics */
  detail?: string;
}

export interface ExitControllerConfig {
  tracker?: ExplorationTracker | null;
  /** Effective timeout = min(stage budget, policy timeout) */
  effectiveTimeoutMs: number;
  abortSignal?: AbortSignal | null;
  /** Policy validateDuring callback */
  validateDuring: (stepState: StepState) => { ok: boolean; action?: string; reason?: string };
  /** Whether tracker mode should bypass policy iteration check */
  skipPolicyIterCheck: boolean;
  loopStartTime: number;
  maxIterations: number;
}

const CONTINUE: ExitSignal = { action: 'continue' };

/**
 * Centralized exit-decision engine for the ReAct loop.
 *
 * Usage:
 *   const exitCtrl = new ExitController(config);
 *   // beginning of each iteration:
 *   const signal = exitCtrl.checkBeforeIteration(ctx, runtimeTokenUsage);
 *   if (signal.action !== 'continue') break;
 */
export class ExitController {
  readonly #tracker: ExplorationTracker | null;
  readonly #effectiveTimeoutMs: number;
  readonly #abortSignal: AbortSignal | null;
  readonly #validateDuring: ExitControllerConfig['validateDuring'];
  readonly #skipPolicyIterCheck: boolean;
  readonly #loopStartTime: number;
  readonly #maxIterations: number;

  /** token 超限后是否已给过一次 graceful 机会 */
  #tokenGraceFired = false;

  constructor(config: ExitControllerConfig) {
    this.#tracker = config.tracker ?? null;
    this.#effectiveTimeoutMs = config.effectiveTimeoutMs;
    this.#abortSignal = config.abortSignal ?? null;
    this.#validateDuring = config.validateDuring;
    this.#skipPolicyIterCheck = config.skipPolicyIterCheck;
    this.#loopStartTime = config.loopStartTime;
    this.#maxIterations = config.maxIterations;
  }

  #isTrackerTerminal(): boolean {
    if (!this.#tracker) {
      return false;
    }
    return this.#tracker.isGracefulExit || this.#tracker.isHardExit;
  }

  // ── 1. Pre-iteration check (replaces #shouldExit) ──

  checkBeforeIteration(
    ctx: LoopContext,
    runtimeTokenUsage: { input: number; output: number }
  ): ExitSignal {
    // P0: abort signal — highest priority
    if (this.#abortSignal?.aborted) {
      return {
        action: 'exit',
        reason: 'abort_signal',
        needsSummary: true,
        detail: 'AbortSignal fired before iteration',
      };
    }

    // P1: tracker exit (manages its own iteration/grace logic)
    if (this.#tracker) {
      this.#tracker.tick();
      if (this.#tracker.shouldExit()) {
        return {
          action: 'exit',
          reason: 'tracker_exit',
          needsSummary: true,
          detail: `phase=${this.#tracker.phase}, iter=${this.#tracker.iteration}, submits=${this.#tracker.totalSubmits}`,
        };
      }
    }

    // P2: stage budget timeout (unified — eliminates triple timeout)
    const elapsed = Date.now() - this.#loopStartTime;
    if (this.#effectiveTimeoutMs > 0 && elapsed > this.#effectiveTimeoutMs) {
      return {
        action: 'exit',
        reason: 'stage_timeout',
        needsSummary: true,
        detail: `${this.#effectiveTimeoutMs}ms exceeded (elapsed: ${elapsed}ms)`,
      };
    }

    // P3: policy validation (with token budget)
    const duringCheck = this.#validateDuring({
      iteration: this.#skipPolicyIterCheck ? 0 : ctx.iteration,
      startTime: this.#loopStartTime,
      totalTokens: runtimeTokenUsage.input + runtimeTokenUsage.output,
      totalInputTokens: runtimeTokenUsage.input,
    } as StepState);
    if (!duringCheck.ok) {
      const reasonStr = typeof duringCheck.reason === 'string' ? duringCheck.reason : '';
      const isTokenIssue = reasonStr.includes('token');

      // Token 超限 + 首次触发 + tracker 未在终结阶段 → graceful exit
      // 给 tracker 一次机会完成 SUMMARIZE，避免直接硬杀丢失已有分析
      if (isTokenIssue && !this.#tokenGraceFired && this.#tracker && !this.#isTrackerTerminal()) {
        this.#tokenGraceFired = true;
        this.#tracker.forceTerminal(reasonStr);
        return {
          action: 'continue',
          reason: 'token_budget_exhausted',
          detail: `${reasonStr} — forced SUMMARIZE, allowing one final round`,
        };
      }

      return {
        action: 'exit',
        reason: isTokenIssue ? 'token_budget_exhausted' : 'policy_stop',
        needsSummary: true,
        detail: reasonStr || 'Policy stopped the run',
      };
    }

    return CONTINUE;
  }

  // ── 2. Post-LLM check (replaces null-return paths in #callLLM) ──

  checkAfterLLM(
    llmResult: { text?: string | null; functionCalls?: unknown[] | null } | null,
    ctx: LoopContext
  ): ExitSignal {
    if (!llmResult) {
      return { action: 'exit', reason: 'empty_response', needsSummary: true };
    }

    const hasText = !!llmResult.text;
    const hasCalls = (llmResult.functionCalls?.length ?? 0) > 0;

    if (!hasText && !hasCalls) {
      // SUMMARIZE grace
      const isTerminal = this.#tracker?.phase === 'SUMMARIZE';
      if (isTerminal && this.#tracker) {
        const phaseRounds =
          (this.#tracker as unknown as { metrics?: { phaseRounds?: number } }).metrics
            ?.phaseRounds ?? 0;
        if (phaseRounds < 2) {
          return {
            action: 'retry',
            reason: 'empty_response_terminal',
            detail: `grace ${phaseRounds + 1}/2`,
          };
        }
        return {
          action: 'exit',
          reason: 'empty_response_terminal',
          needsSummary: true,
          detail: 'grace exhausted',
        };
      }
      if (ctx.isSystem && ctx.consecutiveEmptyResponses < 2) {
        return {
          action: 'retry',
          reason: 'empty_response',
          detail: `retry ${ctx.consecutiveEmptyResponses + 1}/2`,
        };
      }
      return { action: 'exit', reason: 'empty_response', needsSummary: true };
    }

    return CONTINUE;
  }

  // ── 3. AI error check (replaces #handleAiError exit paths) ──

  checkAfterAiError(aiErr: { code?: string; message?: string }, ctx: LoopContext): ExitSignal {
    if (this.#abortSignal?.aborted) {
      return {
        action: 'exit',
        reason: 'abort_signal',
        detail: 'AbortSignal fired during LLM call',
      };
    }

    if (aiErr.code === 'CIRCUIT_OPEN') {
      return { action: 'exit', reason: 'circuit_open', detail: aiErr.message };
    }

    if (ctx.consecutiveAiErrors >= 2) {
      return {
        action: 'exit',
        reason: 'error_accumulated',
        needsSummary: true,
        detail: `${ctx.consecutiveAiErrors} consecutive AI errors`,
      };
    }

    return {
      action: 'retry',
      reason: 'error_accumulated',
      detail: `attempt ${ctx.consecutiveAiErrors}`,
    };
  }

  // ── 4. Post-tool-calls check (replaces #processToolCalls exit path) ──

  checkAfterToolCalls(ctx: LoopContext): ExitSignal {
    if (!this.#tracker && ctx.iteration >= this.#maxIterations) {
      return {
        action: 'exit',
        reason: 'iteration_exhausted',
        needsSummary: true,
        detail: `iteration ${ctx.iteration} >= maxIterations ${this.#maxIterations}`,
      };
    }
    return CONTINUE;
  }

  // ── 5. Post-text check (replaces #processTextResponse exit paths) ──

  checkAfterTextResponse(
    textResult: {
      isFinalAnswer: boolean;
      needsDigestNudge: boolean;
      shouldContinue: boolean;
      nudge: string | null;
    } | null,
    metricsTransitionedToTerminal: boolean,
    _ctx: LoopContext
  ): ExitSignal {
    if (!textResult) {
      return { action: 'exit', reason: 'task_complete' };
    }

    if (metricsTransitionedToTerminal && textResult.isFinalAnswer) {
      return {
        action: 'graceful_exit',
        reason: 'task_complete',
        nudge: null, // caller should generate analyst-specific digest nudge
        detail: 'metrics-transition to terminal — inject digest nudge',
      };
    }

    if (textResult.isFinalAnswer) {
      return { action: 'exit', reason: 'task_complete' };
    }

    if (textResult.needsDigestNudge) {
      return {
        action: 'continue',
        nudge: textResult.nudge,
        detail: 'digest nudge injected',
      };
    }

    if (textResult.shouldContinue) {
      return {
        action: 'continue',
        nudge: textResult.nudge,
      };
    }

    return { action: 'exit', reason: 'task_complete' };
  }

  // ── 6. Graceful exit: toolChoice violation check ──

  checkToolChoiceViolation(llmResult: {
    text?: string | null;
    functionCalls?: unknown[] | null;
  }): ExitSignal {
    const isTerminal = this.#tracker?.phase === 'SUMMARIZE' || this.#tracker?.phase === 'FINALIZE';
    const isGraceful = this.#tracker?.isGracefulExit;

    if (
      (isGraceful || isTerminal) &&
      llmResult.functionCalls?.length &&
      llmResult.functionCalls.length > 0
    ) {
      if (llmResult.text) {
        return {
          action: 'exit',
          reason: 'tool_choice_violation',
          detail: `AI returned ${llmResult.functionCalls.length} tool calls despite toolChoice=none — using text as final answer`,
        };
      }
      return {
        action: 'retry',
        reason: 'tool_choice_violation',
        detail: `AI returned ${llmResult.functionCalls.length} tool calls despite toolChoice=none — no text, retrying`,
      };
    }

    return CONTINUE;
  }
}

// ── Factory ──

export function createExitController(
  ctx: LoopContext,
  policies: {
    validateDuring: (stepState: StepState) => { ok: boolean; action?: string; reason?: string };
  }
): ExitController {
  const tracker = ctx.tracker;
  const stageTimeoutMs = ctx.budget?.timeoutMs ?? 0;

  return new ExitController({
    tracker,
    effectiveTimeoutMs: stageTimeoutMs,
    abortSignal: ctx.abortSignal,
    validateDuring: policies.validateDuring.bind(policies),
    skipPolicyIterCheck: !!tracker,
    loopStartTime: ctx.loopStartTime,
    maxIterations: ctx.maxIterations,
  });
}
