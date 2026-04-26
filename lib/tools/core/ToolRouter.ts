import { randomUUID } from 'node:crypto';
import { GovernanceEngine } from '#tools/core/GovernanceEngine.js';
import type { ToolCallContext, ToolServiceLocator } from '#tools/core/ToolCallContext.js';
import type {
  ToolCallRequest,
  ToolExecutionAdapter,
  ToolExecutionRequest,
  ToolRouterContract,
} from '#tools/core/ToolContracts.js';
import type { ToolDecision } from '#tools/core/ToolDecision.js';
import { createGuardServiceContract } from '#tools/core/ToolGuardServices.js';
import { createInfraServiceContract } from '#tools/core/ToolInfraServices.js';
import { normalizeToolInput } from '#tools/core/ToolInputSchema.js';
import { createKnowledgeServiceContract } from '#tools/core/ToolKnowledgeServices.js';
import { createLifecycleServiceContract } from '#tools/core/ToolLifecycleServices.js';
import { createQualityServiceContract } from '#tools/core/ToolQualityServices.js';
import type { ToolResultEnvelope, ToolResultStatus } from '#tools/core/ToolResultEnvelope.js';
import { createToolRoutingServiceContract } from '#tools/core/ToolRoutingServices.js';
import type { CapabilityCatalog } from '../catalog/CapabilityCatalog.js';
import type { CapabilityKind, ToolCapabilityManifest } from '../catalog/CapabilityManifest.js';

interface TimeoutMarker {
  readonly __toolRouterTimeout: true;
  readonly timeoutMs: number;
  readonly startedAt: string;
  readonly startedAtMs: number;
}

export interface ToolRouterOptions {
  catalog: CapabilityCatalog;
  governance?: GovernanceEngine;
  adapters?: ToolExecutionAdapter[];
  projectRoot?: string;
  services?: ToolServiceLocator;
}

export class ToolRouter implements ToolRouterContract {
  #catalog: CapabilityCatalog;
  #governance: GovernanceEngine;
  #adapters = new Map<CapabilityKind, ToolExecutionAdapter>();
  #projectRoot: string;
  #services: ToolServiceLocator;
  #activeExecutionCount = 0;
  #activeByTool = new Map<string, number>();
  #exclusiveToolId: string | null = null;

  constructor(options: ToolRouterOptions) {
    this.#catalog = options.catalog;
    this.#governance = options.governance || new GovernanceEngine();
    this.#projectRoot = options.projectRoot || process.cwd();
    this.#services = options.services || {
      get(name: string) {
        throw new Error(`Service '${name}' is not available in ToolRouter context`);
      },
    };
    for (const adapter of options.adapters || []) {
      this.#adapters.set(adapter.kind, adapter);
    }
  }

  async execute(request: ToolCallRequest): Promise<ToolResultEnvelope> {
    const manifest = this.#catalog.getManifest(request.toolId);
    const plannedRequest = manifest ? normalizeRequestArgs(request, manifest) : request;
    const governanceDecision = await this.#governance.decide(plannedRequest, manifest, {
      services: this.#services,
    });
    const decision = this.#withExecutionPreview(governanceDecision, plannedRequest, manifest);
    const callId = randomUUID();
    if (!decision.allowed || decision.requiresConfirmation || !manifest) {
      const envelope = createRouterEnvelope({
        request: plannedRequest,
        callId,
        decision,
        status: statusForDecision(decision),
      });
      this.#recordEnvelope(envelope, plannedRequest, manifest);
      return envelope;
    }

    const adapter = this.#adapters.get(manifest.kind);
    if (!adapter) {
      const envelope = createRouterEnvelope({
        request: plannedRequest,
        callId,
        decision,
        status: 'blocked',
        text: `No execution adapter registered for capability kind '${manifest.kind}'`,
      });
      this.#recordEnvelope(envelope, plannedRequest, manifest);
      return envelope;
    }

    const cachedEnvelope = createCachedEnvelope(plannedRequest, manifest, callId);
    if (cachedEnvelope) {
      this.#recordEnvelope(cachedEnvelope, plannedRequest, manifest);
      return cachedEnvelope;
    }

    const concurrencySlot = this.#acquireConcurrencySlot(manifest);
    if (!concurrencySlot.acquired) {
      const envelope = createConcurrencyEnvelope({
        request: plannedRequest,
        callId,
        reason: concurrencySlot.reason,
      });
      this.#recordEnvelope(envelope, plannedRequest, manifest);
      return envelope;
    }

    const signalScope = createExecutionSignalScope(plannedRequest.abortSignal || null, manifest);
    const context: ToolCallContext = {
      callId,
      parentCallId: plannedRequest.parentCallId,
      toolId: plannedRequest.toolId,
      surface: plannedRequest.surface,
      actor: plannedRequest.actor,
      source: plannedRequest.source,
      runtime: plannedRequest.runtime,
      abortSignal: signalScope.signal,
      projectRoot: this.#projectRoot,
      services: this.#services,
      serviceContracts: {
        toolRouting: createToolRoutingServiceContract(this),
        knowledge: createKnowledgeServiceContract(this.#services),
        guard: createGuardServiceContract(this.#services),
        lifecycle: createLifecycleServiceContract(this.#services),
        infra: createInfraServiceContract(this.#services),
        quality: createQualityServiceContract(this.#services),
      },
    };
    const executionRequest: ToolExecutionRequest = {
      manifest,
      args: plannedRequest.args,
      context,
      decision,
    };
    try {
      const adapterResult = adapter.execute(executionRequest);
      const envelope = signalScope.timeout
        ? await Promise.race([adapterResult, signalScope.timeout])
        : await adapterResult;
      if (isTimeoutMarker(envelope)) {
        const timeoutEnvelope = createTimeoutEnvelope({
          request: plannedRequest,
          callId,
          timeoutMs: envelope.timeoutMs,
          startedAt: envelope.startedAt,
          durationMs: Date.now() - envelope.startedAtMs,
        });
        this.#recordEnvelope(timeoutEnvelope, plannedRequest, manifest);
        return timeoutEnvelope;
      }
      writeCachedEnvelope(plannedRequest, manifest, envelope);
      this.#recordEnvelope(envelope, plannedRequest, manifest);
      return envelope;
    } finally {
      signalScope.dispose();
      concurrencySlot.release();
    }
  }

  executeChildCall(request: ToolCallRequest & { parentCallId: string }) {
    return this.execute(request);
  }

  async explain(request: ToolCallRequest): Promise<ToolDecision> {
    const manifest = this.#catalog.getManifest(request.toolId);
    const plannedRequest = manifest ? normalizeRequestArgs(request, manifest) : request;
    const decision = await this.#governance.decide(plannedRequest, manifest, {
      services: this.#services,
    });
    return this.#withExecutionPreview(decision, plannedRequest, manifest);
  }

  #recordEnvelope(
    envelope: ToolResultEnvelope,
    request: ToolCallRequest,
    manifest: ToolCapabilityManifest | null
  ) {
    request.runtime?.diagnostics?.recordToolCallEnvelope(envelope, {
      kind: manifest?.kind,
      surface: request.surface,
      source: request.source.name || request.source.kind,
    });
  }

  #withExecutionPreview(
    decision: ToolDecision,
    request: ToolCallRequest,
    manifest: ToolCapabilityManifest | null
  ): ToolDecision {
    if (!manifest) {
      return decision;
    }
    const adapter = this.#adapters.get(manifest.kind);
    if (!adapter?.preview) {
      return decision;
    }
    try {
      const preview = adapter.preview({
        manifest,
        args: request.args,
        projectRoot: this.#projectRoot,
      });
      return preview ? { ...decision, preview } : decision;
    } catch {
      return decision;
    }
  }

  #acquireConcurrencySlot(
    manifest: ToolCapabilityManifest
  ): { acquired: true; release: () => void } | { acquired: false; reason: string } {
    const policy = manifest.execution.concurrency;
    if (this.#exclusiveToolId) {
      return {
        acquired: false,
        reason: `Capability '${manifest.id}' cannot start while exclusive capability '${this.#exclusiveToolId}' is running`,
      };
    }
    if (policy === 'single' && (this.#activeByTool.get(manifest.id) || 0) > 0) {
      return {
        acquired: false,
        reason: `Capability '${manifest.id}' is already running`,
      };
    }
    if (policy === 'exclusive' && this.#activeExecutionCount > 0) {
      return {
        acquired: false,
        reason: `Capability '${manifest.id}' requires exclusive execution but other capabilities are running`,
      };
    }

    this.#activeExecutionCount += 1;
    this.#activeByTool.set(manifest.id, (this.#activeByTool.get(manifest.id) || 0) + 1);
    if (policy === 'exclusive') {
      this.#exclusiveToolId = manifest.id;
    }

    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#activeExecutionCount = Math.max(0, this.#activeExecutionCount - 1);
        const activeForTool = (this.#activeByTool.get(manifest.id) || 1) - 1;
        if (activeForTool <= 0) {
          this.#activeByTool.delete(manifest.id);
        } else {
          this.#activeByTool.set(manifest.id, activeForTool);
        }
        if (this.#exclusiveToolId === manifest.id) {
          this.#exclusiveToolId = null;
        }
      },
    };
  }
}

function normalizeRequestArgs(
  request: ToolCallRequest,
  manifest: ToolCapabilityManifest
): ToolCallRequest {
  const normalized = normalizeToolInput(request.args, manifest.inputSchema);
  if (!normalized.changed) {
    return request;
  }
  return {
    ...request,
    args: normalized.args,
  };
}

function statusForDecision(decision: ToolDecision): ToolResultStatus {
  if (decision.requiresConfirmation) {
    return 'needs-confirmation';
  }
  return decision.resultStatus || 'blocked';
}

function createExecutionSignalScope(
  upstreamSignal: AbortSignal | null,
  manifest: ToolCapabilityManifest
): {
  signal: AbortSignal | null;
  timeout: Promise<TimeoutMarker> | null;
  dispose: () => void;
} {
  const timeoutMs = manifest.execution.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      signal: upstreamSignal,
      timeout: null,
      dispose: () => {},
    };
  }

  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const onAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(upstreamSignal?.reason);
    }
  };
  upstreamSignal?.addEventListener('abort', onAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<TimeoutMarker>((resolve) => {
    timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`Tool execution timed out after ${timeoutMs}ms`));
      }
      resolve({
        __toolRouterTimeout: true,
        timeoutMs,
        startedAt,
        startedAtMs,
      });
    }, timeoutMs);
  });

  return {
    signal: controller.signal,
    timeout,
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
      }
      upstreamSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function createRouterEnvelope(input: {
  request: ToolCallRequest;
  callId: string;
  decision: ToolDecision;
  status: ToolResultStatus;
  text?: string;
}): ToolResultEnvelope {
  const text = input.text || input.decision.reason || `Tool '${input.request.toolId}' was blocked`;
  return {
    ok: false,
    toolId: input.request.toolId,
    callId: input.callId,
    parentCallId: input.request.parentCallId,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    status: input.status,
    text,
    structuredContent: input.decision.preview
      ? {
          preview: input.decision.preview,
        }
      : undefined,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [{ tool: input.request.toolId, reason: text }],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [
        {
          stage: input.decision.stage,
          action: 'block',
          reason: input.decision.reason || text,
        },
      ],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
    nextActionHint: input.decision.requiresConfirmation
      ? 'Ask for confirmation before retrying.'
      : undefined,
  };
}

function createTimeoutEnvelope(input: {
  request: ToolCallRequest;
  callId: string;
  timeoutMs: number;
  startedAt: string;
  durationMs: number;
}): ToolResultEnvelope {
  const text = `Tool '${input.request.toolId}' timed out after ${input.timeoutMs}ms`;
  return {
    ok: false,
    toolId: input.request.toolId,
    callId: input.callId,
    parentCallId: input.request.parentCallId,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    status: 'timeout',
    text,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [input.request.toolId],
      blockedTools: [{ tool: input.request.toolId, reason: text }],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [
        {
          stage: 'execute',
          action: 'timeout',
          reason: text,
        },
      ],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
    nextActionHint: 'Retry with a smaller request or a longer timeout.',
  };
}

function createConcurrencyEnvelope(input: {
  request: ToolCallRequest;
  callId: string;
  reason: string;
}): ToolResultEnvelope {
  return {
    ok: false,
    toolId: input.request.toolId,
    callId: input.callId,
    parentCallId: input.request.parentCallId,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    status: 'blocked',
    text: input.reason,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [{ tool: input.request.toolId, reason: input.reason }],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [
        {
          stage: 'execute',
          action: 'concurrency',
          reason: input.reason,
        },
      ],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
    nextActionHint: 'Retry after the running tool call completes.',
  };
}

function createCachedEnvelope(
  request: ToolCallRequest,
  manifest: ToolCapabilityManifest,
  callId: string
): ToolResultEnvelope | null {
  if (manifest.execution.cachePolicy === 'none') {
    return null;
  }
  const cached = request.runtime?.cache?.getCachedResult(request.toolId, request.args);
  if (cached === null || cached === undefined) {
    return null;
  }
  if (isToolResultEnvelope(cached)) {
    return {
      ...cached,
      callId,
      parentCallId: request.parentCallId,
      cache: { hit: true, policy: manifest.execution.cachePolicy },
    };
  }
  return {
    ok: true,
    toolId: request.toolId,
    callId,
    parentCallId: request.parentCallId,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    status: 'success',
    text: `Cached result for ${request.toolId}`,
    structuredContent: cached,
    cache: { hit: true, policy: manifest.execution.cachePolicy },
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
}

function writeCachedEnvelope(
  request: ToolCallRequest,
  manifest: ToolCapabilityManifest,
  envelope: ToolResultEnvelope
) {
  if (manifest.execution.cachePolicy === 'none' || !envelope.ok || envelope.cache?.hit) {
    return;
  }
  request.runtime?.cache?.cacheToolResult?.(request.toolId, request.args, {
    ...envelope,
    cache: { hit: false, policy: manifest.execution.cachePolicy },
  });
}

function isTimeoutMarker(value: unknown): value is TimeoutMarker {
  return (
    !!value && typeof value === 'object' && (value as TimeoutMarker).__toolRouterTimeout === true
  );
}

function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
  return (
    !!value &&
    typeof value === 'object' &&
    'ok' in value &&
    'toolId' in value &&
    'status' in value &&
    'text' in value
  );
}

export default ToolRouter;
