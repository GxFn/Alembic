import type { AgentDiagnostics, AgentDiagnosticWarning } from '../AgentRuntimeTypes.js';

function emptyDiagnostics(): AgentDiagnostics {
  return {
    degraded: false,
    fallbackUsed: false,
    warnings: [],
    timedOutStages: [],
    blockedTools: [],
    truncatedToolCalls: 0,
    emptyResponses: 0,
    aiErrorCount: 0,
    gateFailures: [],
  };
}

function isDiagnostics(value: unknown): value is Partial<AgentDiagnostics> {
  return !!value && typeof value === 'object';
}

export class DiagnosticsCollector {
  #diagnostics: AgentDiagnostics;

  constructor(seed?: Partial<AgentDiagnostics>) {
    this.#diagnostics = emptyDiagnostics();
    if (seed) {
      this.merge(seed);
    }
  }

  static from(value: unknown) {
    if (value instanceof DiagnosticsCollector) {
      return value;
    }
    return new DiagnosticsCollector(isDiagnostics(value) ? value : undefined);
  }

  markDegraded() {
    this.#diagnostics.degraded = true;
  }

  markFallbackUsed() {
    this.#diagnostics.fallbackUsed = true;
  }

  warn(warning: AgentDiagnosticWarning) {
    this.#diagnostics.warnings.push(warning);
  }

  recordTimedOutStage(stage: string) {
    if (!this.#diagnostics.timedOutStages.includes(stage)) {
      this.#diagnostics.timedOutStages.push(stage);
    }
  }

  recordBlockedTool(tool: string, reason: string) {
    this.#diagnostics.blockedTools.push({ tool, reason });
  }

  recordTruncatedToolCalls(count: number) {
    if (count > 0) {
      this.#diagnostics.truncatedToolCalls += count;
    }
  }

  recordEmptyResponse() {
    this.#diagnostics.emptyResponses++;
  }

  recordAiError(message: string) {
    this.#diagnostics.aiErrorCount++;
    this.warn({ code: 'ai_error', message });
  }

  recordGateFailure(stage: string, action: string, reason?: string) {
    this.#diagnostics.gateFailures.push({ stage, action, ...(reason ? { reason } : {}) });
    if (action === 'degrade') {
      this.markDegraded();
    }
  }

  merge(input: unknown) {
    if (!isDiagnostics(input)) {
      return;
    }

    if (input.degraded) {
      this.markDegraded();
    }
    if (input.fallbackUsed) {
      this.markFallbackUsed();
    }
    for (const warning of input.warnings || []) {
      this.warn(warning);
    }
    for (const stage of input.timedOutStages || []) {
      this.recordTimedOutStage(stage);
    }
    for (const blockedTool of input.blockedTools || []) {
      this.recordBlockedTool(blockedTool.tool, blockedTool.reason);
    }
    this.recordTruncatedToolCalls(input.truncatedToolCalls || 0);
    for (let index = 0; index < (input.emptyResponses || 0); index++) {
      this.recordEmptyResponse();
    }
    for (let index = 0; index < (input.aiErrorCount || 0); index++) {
      this.#diagnostics.aiErrorCount++;
    }
    for (const gateFailure of input.gateFailures || []) {
      this.recordGateFailure(gateFailure.stage, gateFailure.action, gateFailure.reason);
    }
  }

  isEmpty() {
    return (
      !this.#diagnostics.degraded &&
      !this.#diagnostics.fallbackUsed &&
      this.#diagnostics.warnings.length === 0 &&
      this.#diagnostics.timedOutStages.length === 0 &&
      this.#diagnostics.blockedTools.length === 0 &&
      this.#diagnostics.truncatedToolCalls === 0 &&
      this.#diagnostics.emptyResponses === 0 &&
      this.#diagnostics.aiErrorCount === 0 &&
      this.#diagnostics.gateFailures.length === 0
    );
  }

  toJSON(): AgentDiagnostics {
    return {
      degraded: this.#diagnostics.degraded,
      fallbackUsed: this.#diagnostics.fallbackUsed,
      warnings: [...this.#diagnostics.warnings],
      timedOutStages: [...this.#diagnostics.timedOutStages],
      blockedTools: [...this.#diagnostics.blockedTools],
      truncatedToolCalls: this.#diagnostics.truncatedToolCalls,
      emptyResponses: this.#diagnostics.emptyResponses,
      aiErrorCount: this.#diagnostics.aiErrorCount,
      gateFailures: [...this.#diagnostics.gateFailures],
    };
  }
}
