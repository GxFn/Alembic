import { type ToolInvocation, type ToolResultEnvelope, toolFailure } from "../tools/index.js";
import type { ToolMetadata, ToolRouterContract } from "./AgentRuntimeTypes.js";
import type { DiagnosticsCollector } from "./DiagnosticsCollector.js";
import type { HookSystem } from "./HookSystem.js";

export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly id: string;
}

export interface ToolExecLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface ToolObservationSink {
  recordToolCall(entry: {
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly result: unknown;
    readonly iteration: number;
    readonly source?: string;
    readonly metadata: ToolMetadata;
  }): void | Promise<void>;
}

export interface ToolTrackerSink {
  signalToolCall(event: {
    readonly name: string;
    readonly ok: boolean;
    readonly blocked: boolean;
    readonly isNew: boolean;
    readonly iteration: number;
    readonly source?: string;
  }): void | Promise<void>;
}

export interface ToolTraceSink {
  recordToolCall(
    name: string,
    args: Record<string, unknown>,
    result: unknown,
    isNew: boolean,
  ): void | Promise<void>;
}

export interface ToolExecContext {
  readonly toolRouter: ToolRouterContract;
  readonly allowedToolIds: readonly string[];
  readonly iteration: number;
  readonly source?: string;
  readonly diagnostics?: DiagnosticsCollector | null;
  readonly hooks?: HookSystem | null;
  readonly logger?: ToolExecLogger | null;
  readonly observationSink?: ToolObservationSink | null;
  readonly trackerSink?: ToolTrackerSink | null;
  readonly traceSink?: ToolTraceSink | null;
  readonly onToolCall?:
    | ((name: string, args: Record<string, unknown>, result: unknown, iteration: number) => void)
    | null;
}

export interface ToolExecutionResult {
  readonly result: unknown;
  readonly metadata: ToolMetadata;
}

interface BeforeVerdict {
  readonly blocked?: boolean;
  readonly result?: unknown;
  readonly envelope?: ToolResultEnvelope;
}

export interface ToolMiddleware {
  readonly name: string;
  before?(
    call: ToolCall,
    context: ToolExecContext,
    metadata: ToolMetadata,
  ): BeforeVerdict | undefined | Promise<BeforeVerdict | undefined>;
  after?(
    call: ToolCall,
    result: unknown,
    context: ToolExecContext,
    metadata: ToolMetadata,
  ): void | Promise<void>;
}

const nullLogger: ToolExecLogger = {
  info() {},
  warn() {},
};

export class ToolExecutionPipeline {
  readonly #middlewares: ToolMiddleware[] = [];

  use(middleware: ToolMiddleware): this {
    this.#middlewares.push(middleware);
    return this;
  }

  async execute(call: ToolCall, context: ToolExecContext): Promise<ToolExecutionResult> {
    const metadata: ToolMetadata = { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };
    let toolResult: unknown;

    for (const middleware of this.#middlewares) {
      const verdict = await middleware.before?.(call, context, metadata);
      if (verdict?.blocked) {
        metadata.blocked = true;
        if (verdict.envelope) {
          metadata.envelope = verdict.envelope;
        }
        toolResult = verdict.result;
        context.diagnostics?.recordBlockedTool(call.name, diagnosticReason(toolResult));
        break;
      }
      if (verdict && "result" in verdict) {
        metadata.cacheHit = true;
        if (verdict.envelope) {
          metadata.envelope = verdict.envelope;
        }
        toolResult = verdict.result;
        break;
      }
    }

    if (toolResult === undefined) {
      const allowed = await context.hooks?.emit("tool:execute:before", {
        toolId: call.name,
        args: call.args,
        callId: call.id,
      });
      if (allowed === false) {
        metadata.blocked = true;
        toolResult = { error: `Tool "${call.name}" blocked by hook.` };
        context.diagnostics?.recordBlockedTool(call.name, "blocked_by_hook");
      } else {
        const startedAt = Date.now();
        const envelope = await context.toolRouter.invoke(toInvocation(call));
        metadata.durationMs = Date.now() - startedAt;
        metadata.envelope = envelope;
        metadata.blocked = !envelope.ok;
        context.diagnostics?.recordToolCallEnvelope(envelope, {
          surface: "runtime",
          kind: "tool",
          ...(context.source ? { source: context.source } : {}),
        });
        toolResult = envelopeToResult(envelope);
        await context.hooks?.emit("tool:execute:after", {
          toolId: call.name,
          ok: envelope.ok,
          durationMs: metadata.durationMs,
          callId: call.id,
        });
      }
    }

    for (const middleware of this.#middlewares) {
      await middleware.after?.(call, toolResult, context, metadata);
    }

    return { result: toolResult, metadata };
  }
}

export const allowlistGate: ToolMiddleware = {
  name: "allowlistGate",
  before(call, context): BeforeVerdict | undefined {
    const allowedNames = new Set(context.allowedToolIds);
    if (allowedNames.has(call.name)) {
      return undefined;
    }

    // 白名单在 ToolRouter 前执行；模型幻觉出的未知工具不会进入路由层。
    const logger = context.logger ?? nullLogger;
    logger.warn(`[ToolPipeline] Tool "${call.name}" not in allowlist; blocked before ToolRouter.`);
    const available = [...allowedNames].slice(0, 5).join(", ");
    const message =
      allowedNames.size === 0
        ? `工具 "${call.name}" 不可用。当前阶段未开放任何工具。`
        : `工具 "${call.name}" 不可用。当前可用工具: ${available}${allowedNames.size > 5 ? "..." : ""}`;
    return {
      blocked: true,
      result: { error: message },
      envelope: toolFailure(
        { name: call.name, resource: "unknown", action: "unknown" },
        "error",
        { code: "tool_not_allowed", message },
        { requestId: call.id },
      ),
    };
  },
};

export const observationRecord: ToolMiddleware = {
  name: "observationRecord",
  async after(call, result, context, metadata) {
    context.onToolCall?.(call.name, call.args, result, context.iteration);
    await context.observationSink?.recordToolCall({
      name: call.name,
      args: call.args,
      result,
      iteration: context.iteration,
      ...(context.source ? { source: context.source } : {}),
      metadata,
    });
  },
};

export const trackerSignal: ToolMiddleware = {
  name: "trackerSignal",
  async after(call, _result, context, metadata) {
    await context.trackerSink?.signalToolCall({
      name: call.name,
      ok: !metadata.blocked,
      blocked: metadata.blocked,
      isNew: metadata.isNew,
      iteration: context.iteration,
      ...(context.source ? { source: context.source } : {}),
    });
  },
};

export const traceRecord: ToolMiddleware = {
  name: "traceRecord",
  async after(call, result, context, metadata) {
    await context.traceSink?.recordToolCall(call.name, call.args, result, metadata.isNew);
  },
};

export const submitDedup: ToolMiddleware = {
  name: "submitDedup",
  after(call, result, _context, metadata) {
    if (call.name !== "knowledge.submit" || !isRecord(result) || "error" in result) {
      if (call.name === "knowledge.search" && isRecord(result) && !("error" in result)) {
        metadata.isSubmit = false;
      }
      return;
    }

    metadata.isSubmit = true;
    const status = stringValue(result.status);
    if (status === "duplicate_blocked") {
      metadata.isNew = false;
      metadata.dedupMessage = "Knowledge submission blocked as duplicate.";
      return;
    }
    if (status === "created" || status === "candidate_created" || status === "processed") {
      metadata.isNew = true;
    }
  },
};

export function createToolPipeline(): ToolExecutionPipeline {
  return new ToolExecutionPipeline()
    .use(allowlistGate)
    .use(submitDedup)
    .use(observationRecord)
    .use(trackerSignal)
    .use(traceRecord);
}

function toInvocation(call: ToolCall): ToolInvocation {
  return { name: call.name, input: call.args, requestId: call.id };
}

function envelopeToResult(envelope: ToolResultEnvelope): unknown {
  if (envelope.ok) {
    return envelope.data;
  }
  return { error: envelope.error.message, code: envelope.error.code, status: envelope.status };
}

function diagnosticReason(result: unknown): string {
  if (isRecord(result) && typeof result.error === "string") {
    return result.error;
  }
  return "blocked";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
