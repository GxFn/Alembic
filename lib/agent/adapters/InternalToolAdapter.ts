import { contextFromToolCall, type InternalToolHandlerStore } from '../core/InternalToolHandler.js';
import type { ToolExecutionAdapter, ToolExecutionRequest } from '../core/ToolContracts.js';
import type { ToolResultEnvelope } from '../core/ToolResultEnvelope.js';

export class InternalToolAdapter implements ToolExecutionAdapter {
  readonly kind = 'internal-tool' as const;
  #handlers: InternalToolHandlerStore;

  constructor(handlers: InternalToolHandlerStore) {
    this.#handlers = handlers;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope> {
    const startedAt = new Date();
    const startedMs = Date.now();
    try {
      const tool = this.#handlers.getInternalTool(request.manifest.id);
      if (!tool) {
        throw new Error(`Internal tool '${request.manifest.id}' not found`);
      }
      const result = await tool.handler(request.args, contextFromToolCall(request.context));
      const errorMessage = extractErrorMessage(result);
      return {
        ok: !errorMessage,
        toolId: request.manifest.id,
        callId: request.context.callId,
        parentCallId: request.context.parentCallId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedMs,
        status: errorMessage ? 'error' : 'success',
        text: errorMessage || summarizeResult(result),
        structuredContent: result,
        diagnostics: {
          degraded: false,
          fallbackUsed: false,
          warnings: [],
          timedOutStages: [],
          blockedTools: [],
          truncatedToolCalls: 0,
          emptyResponses: 0,
          aiErrorCount: 0,
          gateFailures: [],
        },
        trust: {
          source: 'internal',
          sanitized: true,
          containsUntrustedText: false,
          containsSecrets: false,
        },
      };
    } catch (err) {
      const message = (err as Error).message;
      return {
        ok: false,
        toolId: request.manifest.id,
        callId: request.context.callId,
        parentCallId: request.context.parentCallId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedMs,
        status: 'error',
        text: message,
        structuredContent: { error: message },
        diagnostics: {
          degraded: false,
          fallbackUsed: false,
          warnings: [{ code: 'internal_tool_error', message, tool: request.manifest.id }],
          timedOutStages: [],
          blockedTools: [],
          truncatedToolCalls: 0,
          emptyResponses: 0,
          aiErrorCount: 0,
          gateFailures: [],
        },
        trust: {
          source: 'internal',
          sanitized: true,
          containsUntrustedText: false,
          containsSecrets: false,
        },
      };
    }
  }
}

function extractErrorMessage(result: unknown) {
  if (result && typeof result === 'object' && 'error' in result) {
    return String((result as { error?: unknown }).error || 'Tool execution failed');
  }
  return null;
}

function summarizeResult(result: unknown) {
  if (result === undefined) {
    return 'Tool completed with no structured result.';
  }
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return 'Tool completed.';
  }
}

export default InternalToolAdapter;
