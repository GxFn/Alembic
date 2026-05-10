import type { LoopContext } from "./LoopContext.js";

export type ExitReason =
  | "abort_signal"
  | "tracker_exit"
  | "stage_timeout"
  | "policy_stop"
  | "iteration_exhausted"
  | "token_budget_exhausted"
  | "task_complete"
  | "empty_response"
  | "empty_response_terminal"
  | "error_accumulated"
  | "circuit_open"
  | "tool_choice_violation";

export interface ExitSignal {
  readonly action: "continue" | "exit" | "graceful_exit" | "retry";
  readonly reason?: ExitReason;
  readonly needsSummary?: boolean;
  readonly nudge?: string | null;
  readonly detail?: string;
}

export interface StepState {
  readonly iteration: number;
  readonly startTime: number;
  readonly totalTokens: number;
  readonly totalInputTokens: number;
}

export interface ExitControllerConfig {
  readonly tracker?: TrackerLike | null;
  readonly effectiveTimeoutMs: number;
  readonly abortSignal?: AbortSignal | null;
  readonly validateDuring: (stepState: StepState) => {
    readonly ok: boolean;
    readonly action?: string;
    readonly reason?: string;
  };
  readonly skipPolicyIterCheck: boolean;
  readonly loopStartTime: number;
  readonly maxIterations: number;
}

interface TrackerLike {
  readonly phase?: string;
  readonly iteration?: number;
  readonly totalSubmits?: number;
  readonly isGracefulExit?: boolean;
  readonly isHardExit?: boolean;
  readonly metrics?: { readonly phaseRounds?: number };
  tick?(): void;
  shouldExit?(): boolean;
  forceTerminal?(reason: string): void;
}

const CONTINUE: ExitSignal = { action: "continue" };

export class ExitController {
  readonly #tracker: TrackerLike | null;
  readonly #effectiveTimeoutMs: number;
  readonly #abortSignal: AbortSignal | null;
  readonly #validateDuring: ExitControllerConfig["validateDuring"];
  readonly #skipPolicyIterCheck: boolean;
  readonly #loopStartTime: number;
  readonly #maxIterations: number;
  #tokenGraceFired = false;
  #timeoutGraceFired = false;

  constructor(config: ExitControllerConfig) {
    this.#tracker = config.tracker ?? null;
    this.#effectiveTimeoutMs = config.effectiveTimeoutMs;
    this.#abortSignal = config.abortSignal ?? null;
    this.#validateDuring = config.validateDuring;
    this.#skipPolicyIterCheck = config.skipPolicyIterCheck;
    this.#loopStartTime = config.loopStartTime;
    this.#maxIterations = config.maxIterations;
  }

  checkBeforeIteration(
    ctx: LoopContext,
    runtimeTokenUsage: { readonly input: number; readonly output: number },
  ): ExitSignal {
    if (this.#abortSignal?.aborted) {
      return {
        action: "exit",
        reason: "abort_signal",
        needsSummary: true,
        detail: "AbortSignal fired before iteration",
      };
    }

    this.#tracker?.tick?.();
    if (this.#tracker?.shouldExit?.()) {
      return {
        action: "exit",
        reason: "tracker_exit",
        needsSummary: true,
        detail: `phase=${this.#tracker.phase ?? "unknown"}, iter=${this.#tracker.iteration ?? ctx.iteration}, submits=${this.#tracker.totalSubmits ?? 0}`,
      };
    }

    const elapsed = Date.now() - this.#loopStartTime;
    if (this.#effectiveTimeoutMs > 0 && elapsed > this.#effectiveTimeoutMs) {
      if (this.#tracker && !this.#timeoutGraceFired) {
        this.#timeoutGraceFired = true;
        if (!this.#isTrackerTerminal()) {
          this.#tracker.forceTerminal?.("stage timeout");
        }
        return {
          action: "continue",
          reason: "stage_timeout",
          detail: `${this.#effectiveTimeoutMs}ms exceeded (elapsed: ${elapsed}ms)`,
        };
      }
      return {
        action: "exit",
        reason: "stage_timeout",
        needsSummary: true,
        detail: `${this.#effectiveTimeoutMs}ms exceeded (elapsed: ${elapsed}ms)`,
      };
    }

    const duringCheck = this.#validateDuring({
      iteration: this.#skipPolicyIterCheck ? 0 : ctx.iteration,
      startTime: this.#loopStartTime,
      totalTokens: runtimeTokenUsage.input + runtimeTokenUsage.output,
      totalInputTokens: runtimeTokenUsage.input,
    });
    if (!duringCheck.ok) {
      const reason = duringCheck.reason ?? "Policy stopped the run";
      const isTokenIssue = reason.includes("token");
      if (isTokenIssue && !this.#tokenGraceFired && this.#tracker && !this.#isTrackerTerminal()) {
        this.#tokenGraceFired = true;
        this.#tracker.forceTerminal?.(reason);
        return { action: "continue", reason: "token_budget_exhausted", detail: reason };
      }
      return {
        action: "exit",
        reason: isTokenIssue ? "token_budget_exhausted" : "policy_stop",
        needsSummary: true,
        detail: reason,
      };
    }

    return CONTINUE;
  }

  checkAfterLLM(
    llmResult: {
      readonly text?: string | null;
      readonly functionCalls?: readonly unknown[] | null;
    } | null,
    ctx: LoopContext,
  ): ExitSignal {
    if (!llmResult) {
      return { action: "exit", reason: "empty_response", needsSummary: true };
    }
    const hasText = !!llmResult.text;
    const hasCalls = (llmResult.functionCalls?.length ?? 0) > 0;
    if (!hasText && !hasCalls) {
      const isTerminal = this.#tracker?.phase === "SUMMARIZE";
      if (isTerminal && this.#tracker) {
        const phaseRounds = this.#tracker.metrics?.phaseRounds ?? 0;
        if (phaseRounds < 2) {
          return {
            action: "retry",
            reason: "empty_response_terminal",
            detail: `grace ${phaseRounds + 1}/2`,
          };
        }
        return {
          action: "exit",
          reason: "empty_response_terminal",
          needsSummary: true,
          detail: "grace exhausted",
        };
      }
      if (ctx.isSystem && ctx.consecutiveEmptyResponses < 2) {
        return {
          action: "retry",
          reason: "empty_response",
          detail: `retry ${ctx.consecutiveEmptyResponses + 1}/2`,
        };
      }
      return { action: "exit", reason: "empty_response", needsSummary: true };
    }
    return CONTINUE;
  }

  checkAfterAiError(
    aiErr: { readonly code?: string; readonly message?: string },
    ctx: LoopContext,
  ): ExitSignal {
    if (this.#abortSignal?.aborted) {
      return {
        action: "exit",
        reason: "abort_signal",
        detail: "AbortSignal fired during LLM call",
      };
    }
    if (aiErr.code === "CIRCUIT_OPEN") {
      return {
        action: "exit",
        reason: "circuit_open",
        ...(aiErr.message ? { detail: aiErr.message } : {}),
      };
    }
    if (ctx.consecutiveAiErrors >= 2) {
      return {
        action: "exit",
        reason: "error_accumulated",
        needsSummary: true,
        detail: `${ctx.consecutiveAiErrors} consecutive AI errors`,
      };
    }
    return {
      action: "retry",
      reason: "error_accumulated",
      detail: `attempt ${ctx.consecutiveAiErrors}`,
    };
  }

  checkAfterToolCalls(ctx: LoopContext): ExitSignal {
    if (!this.#tracker && ctx.iteration >= this.#maxIterations) {
      return {
        action: "exit",
        reason: "iteration_exhausted",
        needsSummary: true,
        detail: `iteration ${ctx.iteration} >= maxIterations ${this.#maxIterations}`,
      };
    }
    return CONTINUE;
  }

  checkAfterTextResponse(
    textResult: {
      readonly isFinalAnswer: boolean;
      readonly needsDigestNudge: boolean;
      readonly shouldContinue: boolean;
      readonly nudge: string | null;
    } | null,
    metricsTransitionedToTerminal: boolean,
  ): ExitSignal {
    if (!textResult) {
      return { action: "exit", reason: "task_complete" };
    }
    if (metricsTransitionedToTerminal && textResult.isFinalAnswer) {
      return {
        action: "graceful_exit",
        reason: "task_complete",
        nudge: null,
        detail: "metrics-transition to terminal",
      };
    }
    if (textResult.isFinalAnswer) {
      return { action: "exit", reason: "task_complete" };
    }
    if (textResult.needsDigestNudge) {
      return { action: "continue", nudge: textResult.nudge, detail: "digest nudge injected" };
    }
    if (textResult.shouldContinue) {
      return { action: "continue", nudge: textResult.nudge };
    }
    return { action: "exit", reason: "task_complete" };
  }

  checkToolChoiceViolation(llmResult: {
    readonly text?: string | null;
    readonly functionCalls?: readonly unknown[] | null;
  }): ExitSignal {
    const isTerminal = this.#tracker?.phase === "SUMMARIZE" || this.#tracker?.phase === "FINALIZE";
    const isGraceful = this.#tracker?.isGracefulExit;
    if ((isGraceful || isTerminal) && llmResult.functionCalls?.length) {
      if (llmResult.text) {
        return {
          action: "exit",
          reason: "tool_choice_violation",
          detail: `AI returned ${llmResult.functionCalls.length} tool calls despite toolChoice=none; using text as final answer`,
        };
      }
      return {
        action: "retry",
        reason: "tool_choice_violation",
        detail: `AI returned ${llmResult.functionCalls.length} tool calls despite toolChoice=none; retrying`,
      };
    }
    return CONTINUE;
  }

  #isTrackerTerminal(): boolean {
    return (
      !!this.#tracker?.isGracefulExit ||
      !!this.#tracker?.isHardExit ||
      this.#tracker?.phase === "SUMMARIZE" ||
      this.#tracker?.phase === "FINALIZE"
    );
  }
}

export function createExitController(
  ctx: LoopContext,
  policies: {
    readonly validateDuring: (stepState: StepState) => {
      readonly ok: boolean;
      readonly action?: string;
      readonly reason?: string;
    };
  },
): ExitController {
  const tracker = isTrackerLike(ctx.tracker) ? ctx.tracker : null;
  const stageTimeoutMs = typeof ctx.budget.timeoutMs === "number" ? ctx.budget.timeoutMs : 0;
  const boundValidate = policies.validateDuring.bind(policies);
  return new ExitController({
    tracker,
    effectiveTimeoutMs: stageTimeoutMs,
    abortSignal: ctx.abortSignal,
    validateDuring: boundValidate,
    skipPolicyIterCheck: !!tracker,
    loopStartTime: ctx.loopStartTime,
    maxIterations: ctx.maxIterations,
  });
}

function isTrackerLike(value: unknown): value is TrackerLike {
  return !!value && typeof value === "object";
}
