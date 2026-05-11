/**
 * LightweightRouter — 非 Agent 表面的轻量工具路由器。
 *
 * 替代重型 V1 ToolRouter (含 GovernanceEngine / SchemaValidator / 5 Service 文件)。
 * 仅做: adapter 查找 → 分发执行 → 包装结果。
 * Dashboard / Terminal / Skill / Mac / Workflow / MCP 等平台适配器通过此路由执行。
 */

import { randomUUID } from 'node:crypto';
import type { ToolCallContext, ToolServiceLocator } from '#tools/core/ToolCallContext.js';
import type {
  ToolCallRequest,
  ToolExecutionAdapter,
  ToolExecutionRequest,
  ToolRouterContract,
} from '#tools/core/ToolContracts.js';
import type { ToolDecision } from '#tools/core/ToolDecision.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
import type { CapabilityCatalog } from '../catalog/CapabilityCatalog.js';
import type { CapabilityKind } from '../catalog/CapabilityManifest.js';

export interface LightweightRouterOptions {
  catalog: CapabilityCatalog;
  adapters?: ToolExecutionAdapter[];
  projectRoot?: string;
  dataRoot?: string;
  services?: ToolServiceLocator;
}

export class LightweightRouter implements ToolRouterContract {
  readonly #catalog: CapabilityCatalog;
  readonly #adapters = new Map<CapabilityKind, ToolExecutionAdapter>();
  readonly #projectRoot: string;
  readonly #dataRoot: string;
  readonly #services: ToolServiceLocator;

  constructor(options: LightweightRouterOptions) {
    this.#catalog = options.catalog;
    this.#projectRoot = options.projectRoot || process.cwd();
    this.#dataRoot = options.dataRoot || this.#projectRoot;
    this.#services = options.services || {
      get(name: string) {
        throw new Error(`Service '${name}' not available`);
      },
    };
    for (const adapter of options.adapters || []) {
      this.#adapters.set(adapter.kind, adapter);
    }
  }

  async execute(request: ToolCallRequest): Promise<ToolResultEnvelope> {
    const startMs = Date.now();
    const callId = randomUUID();
    const startedAt = new Date().toISOString();

    try {
      const manifest = this.#catalog.getManifest(request.toolId);
      if (!manifest) {
        return this.#errorEnvelope(
          request.toolId,
          callId,
          startedAt,
          startMs,
          `Unknown tool: ${request.toolId}`
        );
      }

      const adapter = this.#adapters.get(manifest.kind);
      if (!adapter) {
        return this.#errorEnvelope(
          request.toolId,
          callId,
          startedAt,
          startMs,
          `No adapter for kind: ${manifest.kind}`
        );
      }

      const context = this.#buildContext(request, callId);
      const decision: ToolDecision = {
        allowed: true,
        stage: 'approve',
      };

      const execReq: ToolExecutionRequest = {
        manifest,
        args: request.args,
        context,
        decision,
      };

      return await adapter.execute(execReq);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.#errorEnvelope(request.toolId, callId, startedAt, startMs, msg);
    }
  }

  async executeChildCall(
    request: ToolCallRequest & { parentCallId: string }
  ): Promise<ToolResultEnvelope> {
    return this.execute(request);
  }

  async explain(request: ToolCallRequest): Promise<ToolDecision> {
    const manifest = this.#catalog.getManifest(request.toolId);
    return {
      allowed: !!manifest,
      stage: 'approve',
      reason: manifest ? undefined : `Unknown tool: ${request.toolId}`,
    };
  }

  #buildContext(request: ToolCallRequest, callId: string): ToolCallContext {
    return {
      callId,
      toolId: request.toolId,
      surface: request.surface,
      actor: request.actor,
      source: request.source,
      projectRoot: this.#projectRoot,
      dataRoot: this.#dataRoot,
      services: this.#services,
      abortSignal: request.abortSignal ?? null,
      parentCallId: request.parentCallId,
      runtime: request.runtime,
    };
  }

  #errorEnvelope(
    toolId: string,
    callId: string,
    startedAt: string,
    startMs: number,
    error: string
  ): ToolResultEnvelope {
    return {
      ok: false,
      toolId,
      callId,
      startedAt,
      status: 'error',
      text: error,
      durationMs: Date.now() - startMs,
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
        sanitized: false,
        containsUntrustedText: false,
        containsSecrets: false,
      },
    };
  }
}
