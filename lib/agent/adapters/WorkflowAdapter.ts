import type { ToolExecutionAdapter, ToolExecutionRequest } from '../core/ToolContracts.js';
import type { ToolResultEnvelope } from '../core/ToolResultEnvelope.js';
import { resolveToolRouterFromContext } from '../core/ToolRoutingServices.js';
import type { WorkflowHandlerContext, WorkflowRegistry } from '../workflow/WorkflowRegistry.js';

export class WorkflowAdapter implements ToolExecutionAdapter {
  readonly kind = 'workflow' as const;
  #registry: WorkflowRegistry;

  constructor(registry: WorkflowRegistry) {
    this.#registry = registry;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope> {
    const startedAt = new Date();
    const startedMs = Date.now();
    const workflow = this.#registry.get(request.manifest.id);
    if (!workflow) {
      return envelopeForError(request, startedAt, startedMs, 'Workflow handler not found');
    }

    try {
      const result = await workflow.handler(request.args, createWorkflowHandlerContext(request));
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
          source: 'internal',
          sanitized: true,
          containsUntrustedText: false,
          containsSecrets: false,
        },
      };
    } catch (err: unknown) {
      return envelopeForError(
        request,
        startedAt,
        startedMs,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

function createWorkflowHandlerContext(request: ToolExecutionRequest): WorkflowHandlerContext {
  return {
    toolCallContext: request.context,
    toolRouter: resolveToolRouterFromContext(request.context),
  };
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
      warnings: [{ code: 'workflow_error', message, tool: request.manifest.id }],
    },
    trust: {
      source: 'internal',
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
    return String((result as { error?: unknown }).error || 'Workflow execution failed');
  }
  return null;
}

function summarizeResult(result: unknown) {
  if (result === undefined) {
    return 'Workflow completed with no structured result.';
  }
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return 'Workflow completed.';
  }
}

export default WorkflowAdapter;
