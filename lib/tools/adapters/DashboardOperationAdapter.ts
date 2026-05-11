import type { DashboardOperationHandler } from '#tools/adapters/DashboardOperations.js';
import type { ToolExecutionAdapter, ToolExecutionRequest } from '#tools/core/ToolContracts.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';

export class DashboardOperationAdapter implements ToolExecutionAdapter {
  readonly kind = 'dashboard-operation' as const;
  #handlers: Record<string, DashboardOperationHandler>;

  constructor(handlers: Record<string, DashboardOperationHandler>) {
    this.#handlers = handlers;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope> {
    const startedAt = new Date();
    const startedMs = Date.now();
    const handler = this.#handlers[request.manifest.id];
    if (!handler) {
      return envelopeForError(
        request,
        startedAt,
        startedMs,
        'Dashboard operation handler not found'
      );
    }

    try {
      const result = await handler(request);
      const errorMessage = extractErrorMessage(result);
      if (errorMessage) {
        return envelopeForError(request, startedAt, startedMs, errorMessage, result);
      }
      return {
        ok: true,
        toolId: request.manifest.id,
        callId: request.context.callId,
        parentCallId: request.context.parentCallId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedMs,
        status: 'success',
        text: summarizeResult(result),
        structuredContent: result,
        diagnostics: emptyDiagnostics(),
        trust: {
          source: 'user',
          sanitized: true,
          containsUntrustedText: false,
          containsSecrets: false,
        },
      };
    } catch (err) {
      return envelopeForError(
        request,
        startedAt,
        startedMs,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

function envelopeForError(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number,
  message: string,
  structuredContent: unknown = { error: message }
): ToolResultEnvelope {
  return {
    ok: false,
    toolId: request.manifest.id,
    callId: request.context.callId,
    parentCallId: request.context.parentCallId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    status: 'error',
    text: message,
    structuredContent,
    diagnostics: {
      ...emptyDiagnostics(),
      warnings: [{ code: 'dashboard_operation_error', message, tool: request.manifest.id }],
    },
    trust: {
      source: 'user',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

function emptyDiagnostics() {
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

function extractErrorMessage(result: unknown) {
  if (result && typeof result === 'object' && 'error' in result) {
    return String((result as { error?: unknown }).error || 'Dashboard operation failed');
  }
  return null;
}

function summarizeResult(result: unknown) {
  if (result === undefined) {
    return 'Dashboard operation completed with no structured result.';
  }
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result === 'object') {
    const resultObj = result as { message?: unknown };
    if (typeof resultObj.message === 'string' && resultObj.message) {
      return resultObj.message;
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return 'Dashboard operation completed.';
  }
}

export default DashboardOperationAdapter;
