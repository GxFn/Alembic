/**
 * V2ToolRouterAdapter — V2 工具路由器适配到 V1 ToolRouterContract。
 *
 * 让 AgentRuntime 的 ToolExecutionPipeline 无缝调用 V2 handler。
 * ToolCallRequest → ToolCallV2 → ToolResult → ToolResultEnvelope
 */

import { randomUUID } from 'node:crypto';
import type { ToolCallRequest, ToolRouterContract } from '#tools/core/ToolContracts.js';
import type { ToolDecision } from '#tools/core/ToolDecision.js';
import type {
  ToolResultDiagnostics,
  ToolResultEnvelope,
  ToolResultTrust,
} from '#tools/core/ToolResultEnvelope.js';
import { ToolRouterV2 } from '../router.js';
import type { CapabilityV2Def, ToolResult } from '../types.js';
import type { ToolContextFactory } from './ToolContextFactory.js';

const EMPTY_DIAGNOSTICS: ToolResultDiagnostics = {
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

const DEFAULT_TRUST: ToolResultTrust = {
  source: 'internal',
  sanitized: true,
  containsUntrustedText: false,
  containsSecrets: false,
};

export class V2ToolRouterAdapter implements ToolRouterContract {
  readonly router: ToolRouterV2;
  readonly #contextFactory: ToolContextFactory;

  constructor(opts: {
    capability?: CapabilityV2Def;
    contextFactory: ToolContextFactory;
  }) {
    this.router = new ToolRouterV2({ capability: opts.capability });
    this.#contextFactory = opts.contextFactory;
  }

  async execute(request: ToolCallRequest): Promise<ToolResultEnvelope> {
    const startedAt = new Date().toISOString();
    const callId = randomUUID();
    const t0 = Date.now();

    try {
      const parsed = this.router.parseToolCall(request.toolId, request.args);
      if ('error' in parsed) {
        return this.#errorEnvelope(request.toolId, callId, startedAt, parsed.error);
      }

      const v2CacheHint =
        this.router.getToolSpec(parsed.tool)?.actions[parsed.action]?.cache ?? 'none';
      const cachePolicy = v2CacheHint === 'delta' ? 'session' : v2CacheHint;

      const ctx = this.#contextFactory.create(request);
      const result = await this.router.execute(parsed, ctx);
      const durationMs = Date.now() - t0;

      return this.#toEnvelope(result, request.toolId, callId, startedAt, durationMs, cachePolicy);
    } catch (err: unknown) {
      const durationMs = Date.now() - t0;
      return this.#errorEnvelope(
        request.toolId,
        callId,
        startedAt,
        err instanceof Error ? err.message : String(err),
        durationMs
      );
    }
  }

  async executeChildCall(
    request: ToolCallRequest & { parentCallId: string }
  ): Promise<ToolResultEnvelope> {
    return this.execute(request);
  }

  async explain(request: ToolCallRequest): Promise<ToolDecision> {
    const parsed = this.router.parseToolCall(request.toolId, request.args);
    if ('error' in parsed) {
      return { allowed: false, stage: 'discover', reason: parsed.error };
    }

    const spec = this.router.getToolSpec(parsed.tool);
    if (!spec) {
      return { allowed: false, stage: 'discover', reason: `Unknown tool: ${parsed.tool}` };
    }
    if (!spec.actions[parsed.action]) {
      return {
        allowed: false,
        stage: 'discover',
        reason: `Unknown action: ${parsed.tool}.${parsed.action}`,
      };
    }

    return { allowed: true, stage: 'execute' };
  }

  #toEnvelope(
    result: ToolResult,
    toolId: string,
    callId: string,
    startedAt: string,
    durationMs: number,
    cachePolicy: 'none' | 'session' | 'scope' | 'persistent' = 'none'
  ): ToolResultEnvelope {
    const text = result.ok
      ? typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data, null, 2)
      : result.error || 'Unknown error';

    return {
      ok: result.ok,
      toolId,
      callId,
      startedAt,
      durationMs,
      status: result.ok ? 'success' : 'error',
      text,
      structuredContent: result.data,
      cache: {
        hit: result._meta?.cached ?? false,
        policy: cachePolicy,
      },
      diagnostics: EMPTY_DIAGNOSTICS,
      trust: result.ok ? DEFAULT_TRUST : { ...DEFAULT_TRUST, containsUntrustedText: true },
    };
  }

  #errorEnvelope(
    toolId: string,
    callId: string,
    startedAt: string,
    error: string,
    durationMs = 0
  ): ToolResultEnvelope {
    return {
      ok: false,
      toolId,
      callId,
      startedAt,
      durationMs,
      status: 'error',
      text: error,
      diagnostics: EMPTY_DIAGNOSTICS,
      trust: DEFAULT_TRUST,
    };
  }
}
