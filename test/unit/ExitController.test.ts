/**
 * ExitController 单元测试
 *
 * 覆盖 6 个 check 方法中的全部退出分支（18 条路径）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExitSignal } from '../../lib/agent/runtime/ExitController.js';
import { createExitController, ExitController } from '../../lib/agent/runtime/ExitController.js';

/* ═══════════════════════════════════════════
 *  Helpers
 * ═══════════════════════════════════════════ */

function policyOk() {
  return { ok: true };
}

function policyStop() {
  return { ok: false, action: 'stop', reason: 'iteration limit' };
}

function policyTokenStop() {
  return { ok: false, action: 'stop', reason: 'session token budget exceeded' };
}

function makeCtrl(overrides: Partial<ConstructorParameters<typeof ExitController>[0]> = {}) {
  return new ExitController({
    tracker: null,
    effectiveTimeoutMs: 600_000,
    abortSignal: null,
    validateDuring: policyOk,
    skipPolicyIterCheck: false,
    loopStartTime: Date.now(),
    maxIterations: 20,
    ...overrides,
  });
}

function stubCtx(overrides: Record<string, unknown> = {}) {
  return {
    iteration: 1,
    isSystem: false,
    consecutiveEmptyResponses: 0,
    consecutiveAiErrors: 0,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any;
}

const tokenUsage = { input: 0, output: 0 };

/* ═══════════════════════════════════════════
 *  1. checkBeforeIteration
 * ═══════════════════════════════════════════ */

describe('ExitController.checkBeforeIteration', () => {
  it('exits on AbortSignal', () => {
    const ac = new AbortController();
    ac.abort();
    const ctrl = makeCtrl({ abortSignal: ac.signal });
    const sig = ctrl.checkBeforeIteration(stubCtx(), tokenUsage);
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('abort_signal');
  });

  it('exits on tracker.shouldExit()', () => {
    const tracker = {
      tick: vi.fn(),
      shouldExit: vi.fn().mockReturnValue(true),
      phase: 'EXPLORE',
      iteration: 5,
      totalSubmits: 2,
    };
    const ctrl = makeCtrl({ tracker: tracker as any });
    const sig = ctrl.checkBeforeIteration(stubCtx(), tokenUsage);
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('tracker_exit');
    expect(tracker.tick).toHaveBeenCalled();
  });

  it('exits on stage timeout', () => {
    const ctrl = makeCtrl({
      effectiveTimeoutMs: 1000,
      loopStartTime: Date.now() - 2000,
    });
    const sig = ctrl.checkBeforeIteration(stubCtx(), tokenUsage);
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('stage_timeout');
  });

  it('exits on token budget exhausted', () => {
    const ctrl = makeCtrl({ validateDuring: policyTokenStop });
    const sig = ctrl.checkBeforeIteration(stubCtx(), tokenUsage);
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('token_budget_exhausted');
  });

  it('exits on generic policy stop', () => {
    const ctrl = makeCtrl({ validateDuring: policyStop });
    const sig = ctrl.checkBeforeIteration(stubCtx(), tokenUsage);
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('policy_stop');
  });

  it('continues when all checks pass', () => {
    const tracker = {
      tick: vi.fn(),
      shouldExit: vi.fn().mockReturnValue(false),
      phase: 'EXPLORE',
      iteration: 1,
      totalSubmits: 0,
    };
    const ctrl = makeCtrl({ tracker: tracker as any });
    const sig = ctrl.checkBeforeIteration(stubCtx(), tokenUsage);
    expect(sig.action).toBe('continue');
  });

  it('skips policy iteration check when tracker present', () => {
    const validateDuring = vi.fn().mockReturnValue({ ok: true });
    const tracker = {
      tick: vi.fn(),
      shouldExit: vi.fn().mockReturnValue(false),
      phase: 'EXPLORE',
      iteration: 3,
      totalSubmits: 0,
    };
    const ctrl = makeCtrl({
      tracker: tracker as any,
      validateDuring,
      skipPolicyIterCheck: true,
    });
    ctrl.checkBeforeIteration(stubCtx({ iteration: 50 }), tokenUsage);
    expect(validateDuring).toHaveBeenCalledWith(expect.objectContaining({ iteration: 0 }));
  });
});

/* ═══════════════════════════════════════════
 *  2. checkAfterLLM
 * ═══════════════════════════════════════════ */

describe('ExitController.checkAfterLLM', () => {
  it('exits on null result', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterLLM(null, stubCtx());
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('empty_response');
  });

  it('retries on empty in SUMMARIZE phase with grace < 2', () => {
    const tracker = {
      phase: 'SUMMARIZE',
      metrics: { phaseRounds: 0 },
    };
    const ctrl = makeCtrl({ tracker: tracker as any });
    const sig = ctrl.checkAfterLLM({ text: null, functionCalls: [] }, stubCtx());
    expect(sig.action).toBe('retry');
    expect(sig.reason).toBe('empty_response_terminal');
  });

  it('exits on empty in SUMMARIZE phase with grace exhausted', () => {
    const tracker = {
      phase: 'SUMMARIZE',
      metrics: { phaseRounds: 2 },
    };
    const ctrl = makeCtrl({ tracker: tracker as any });
    const sig = ctrl.checkAfterLLM({ text: null, functionCalls: [] }, stubCtx());
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('empty_response_terminal');
  });

  it('retries on empty system response with consecutiveEmptyResponses < 2', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterLLM(
      { text: '', functionCalls: [] },
      stubCtx({ isSystem: true, consecutiveEmptyResponses: 0 })
    );
    expect(sig.action).toBe('retry');
    expect(sig.reason).toBe('empty_response');
  });

  it('exits on empty system response with consecutiveEmptyResponses >= 2', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterLLM(
      { text: '', functionCalls: [] },
      stubCtx({ isSystem: true, consecutiveEmptyResponses: 2 })
    );
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('empty_response');
  });

  it('continues on normal result with text', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterLLM({ text: 'Hello', functionCalls: null }, stubCtx());
    expect(sig.action).toBe('continue');
  });

  it('continues on normal result with function calls', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterLLM({ text: null, functionCalls: [{ name: 'test' }] }, stubCtx());
    expect(sig.action).toBe('continue');
  });
});

/* ═══════════════════════════════════════════
 *  3. checkAfterAiError
 * ═══════════════════════════════════════════ */

describe('ExitController.checkAfterAiError', () => {
  it('exits on AbortSignal during error', () => {
    const ac = new AbortController();
    ac.abort();
    const ctrl = makeCtrl({ abortSignal: ac.signal });
    const sig = ctrl.checkAfterAiError({ code: 'RATE_LIMIT' }, stubCtx());
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('abort_signal');
  });

  it('exits on CIRCUIT_OPEN', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterAiError(
      { code: 'CIRCUIT_OPEN', message: 'breaker open' },
      stubCtx()
    );
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('circuit_open');
  });

  it('exits on accumulated errors >= 2', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterAiError(
      { code: 'SERVER_ERROR' },
      stubCtx({ consecutiveAiErrors: 2 })
    );
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('error_accumulated');
  });

  it('retries on first error', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterAiError({ code: 'TIMEOUT' }, stubCtx({ consecutiveAiErrors: 1 }));
    expect(sig.action).toBe('retry');
    expect(sig.reason).toBe('error_accumulated');
  });
});

/* ═══════════════════════════════════════════
 *  4. checkAfterToolCalls
 * ═══════════════════════════════════════════ */

describe('ExitController.checkAfterToolCalls', () => {
  it('exits when no tracker and iteration >= maxIterations', () => {
    const ctrl = makeCtrl({ maxIterations: 10 });
    const sig = ctrl.checkAfterToolCalls(stubCtx({ iteration: 10 }));
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('iteration_exhausted');
  });

  it('continues when no tracker but iteration < maxIterations', () => {
    const ctrl = makeCtrl({ maxIterations: 10 });
    const sig = ctrl.checkAfterToolCalls(stubCtx({ iteration: 5 }));
    expect(sig.action).toBe('continue');
  });

  it('continues when tracker present regardless of iteration', () => {
    const tracker = { phase: 'EXPLORE' } as any;
    const ctrl = makeCtrl({ tracker, maxIterations: 5 });
    const sig = ctrl.checkAfterToolCalls(stubCtx({ iteration: 100 }));
    expect(sig.action).toBe('continue');
  });
});

/* ═══════════════════════════════════════════
 *  5. checkAfterTextResponse
 * ═══════════════════════════════════════════ */

describe('ExitController.checkAfterTextResponse', () => {
  it('exits when textResult is null', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterTextResponse(null, false, stubCtx());
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('task_complete');
  });

  it('graceful exit on metrics transition + final answer', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterTextResponse(
      { isFinalAnswer: true, needsDigestNudge: false, shouldContinue: false, nudge: null },
      true,
      stubCtx()
    );
    expect(sig.action).toBe('graceful_exit');
    expect(sig.reason).toBe('task_complete');
  });

  it('exits on final answer without metrics transition', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterTextResponse(
      { isFinalAnswer: true, needsDigestNudge: false, shouldContinue: false, nudge: null },
      false,
      stubCtx()
    );
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('task_complete');
  });

  it('continues with nudge on needsDigestNudge', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterTextResponse(
      {
        isFinalAnswer: false,
        needsDigestNudge: true,
        shouldContinue: false,
        nudge: 'digest please',
      },
      false,
      stubCtx()
    );
    expect(sig.action).toBe('continue');
    expect(sig.nudge).toBe('digest please');
  });

  it('continues on shouldContinue', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterTextResponse(
      { isFinalAnswer: false, needsDigestNudge: false, shouldContinue: true, nudge: 'keep going' },
      false,
      stubCtx()
    );
    expect(sig.action).toBe('continue');
    expect(sig.nudge).toBe('keep going');
  });

  it('falls through to exit on non-final, non-continue', () => {
    const ctrl = makeCtrl();
    const sig = ctrl.checkAfterTextResponse(
      { isFinalAnswer: false, needsDigestNudge: false, shouldContinue: false, nudge: null },
      false,
      stubCtx()
    );
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('task_complete');
  });
});

/* ═══════════════════════════════════════════
 *  6. checkToolChoiceViolation
 * ═══════════════════════════════════════════ */

describe('ExitController.checkToolChoiceViolation', () => {
  it('exits with text when SUMMARIZE + function calls + text present', () => {
    const tracker = { phase: 'SUMMARIZE', isGracefulExit: false } as any;
    const ctrl = makeCtrl({ tracker });
    const sig = ctrl.checkToolChoiceViolation({
      text: 'final answer',
      functionCalls: [{ name: 'tool1' }],
    });
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('tool_choice_violation');
  });

  it('retries without text when SUMMARIZE + function calls + no text', () => {
    const tracker = { phase: 'SUMMARIZE', isGracefulExit: false } as any;
    const ctrl = makeCtrl({ tracker });
    const sig = ctrl.checkToolChoiceViolation({
      text: null,
      functionCalls: [{ name: 'tool1' }],
    });
    expect(sig.action).toBe('retry');
    expect(sig.reason).toBe('tool_choice_violation');
  });

  it('exits with text when gracefulExit + function calls + text present', () => {
    const tracker = { phase: 'PRODUCE', isGracefulExit: true } as any;
    const ctrl = makeCtrl({ tracker });
    const sig = ctrl.checkToolChoiceViolation({
      text: 'here is my summary',
      functionCalls: [{ name: 'search' }],
    });
    expect(sig.action).toBe('exit');
    expect(sig.reason).toBe('tool_choice_violation');
  });

  it('continues when not terminal/graceful', () => {
    const tracker = { phase: 'EXPLORE', isGracefulExit: false } as any;
    const ctrl = makeCtrl({ tracker });
    const sig = ctrl.checkToolChoiceViolation({
      text: 'hello',
      functionCalls: [{ name: 'search' }],
    });
    expect(sig.action).toBe('continue');
  });

  it('continues when terminal but no function calls', () => {
    const tracker = { phase: 'FINALIZE', isGracefulExit: false } as any;
    const ctrl = makeCtrl({ tracker });
    const sig = ctrl.checkToolChoiceViolation({
      text: 'final answer',
      functionCalls: [],
    });
    expect(sig.action).toBe('continue');
  });

  it('continues when no tracker', () => {
    const ctrl = makeCtrl({ tracker: null });
    const sig = ctrl.checkToolChoiceViolation({
      text: 'hello',
      functionCalls: [{ name: 'search' }],
    });
    expect(sig.action).toBe('continue');
  });
});

/* ═══════════════════════════════════════════
 *  Factory: createExitController
 * ═══════════════════════════════════════════ */

describe('createExitController', () => {
  it('creates from LoopContext with tracker', () => {
    const tracker = {
      tick: vi.fn(),
      shouldExit: vi.fn().mockReturnValue(false),
      phase: 'EXPLORE',
      iteration: 1,
      totalSubmits: 0,
    };
    const ctx = stubCtx({
      tracker,
      budget: { timeoutMs: 120_000 },
      abortSignal: null,
      loopStartTime: Date.now(),
      maxIterations: 24,
    });
    const policies = { validateDuring: policyOk };
    const ctrl = createExitController(ctx, policies);
    expect(ctrl).toBeInstanceOf(ExitController);

    const sig = ctrl.checkBeforeIteration(ctx, tokenUsage);
    expect(sig.action).toBe('continue');
  });

  it('creates from LoopContext without tracker', () => {
    const ctx = stubCtx({
      tracker: null,
      budget: { timeoutMs: 60_000 },
      abortSignal: null,
      loopStartTime: Date.now(),
      maxIterations: 10,
    });
    const policies = { validateDuring: policyOk };
    const ctrl = createExitController(ctx, policies);
    expect(ctrl).toBeInstanceOf(ExitController);
  });
});
