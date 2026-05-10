import { ToolOutputCompressor } from "./compressor.js";
import { createDefaultToolHandlers } from "./handlers/index.js";
import { createDefaultToolRegistry } from "./registry.js";
import type {
  ToolHandler,
  ToolIdentity,
  ToolInvocation,
  ToolRegistryReader,
  ToolResultEnvelope,
  ToolRuntimeDependencies,
} from "./types.js";
import { toolFailure } from "./types.js";

export interface ToolRouterOptions {
  readonly registry?: ToolRegistryReader;
  readonly handlers?: ReadonlyMap<string, ToolHandler>;
  readonly dependencies?: ToolRuntimeDependencies;
  readonly compressor?: ToolOutputCompressor;
}

export class ToolRouter {
  readonly #registry: ToolRegistryReader;
  readonly #handlers: ReadonlyMap<string, ToolHandler>;
  readonly #dependencies: ToolRuntimeDependencies;
  readonly #compressor: ToolOutputCompressor;

  constructor(options: ToolRouterOptions = {}) {
    this.#registry = options.registry ?? createDefaultToolRegistry();
    this.#handlers = options.handlers ?? createDefaultToolHandlers();
    this.#dependencies = options.dependencies ?? {};
    this.#compressor = options.compressor ?? new ToolOutputCompressor();
  }

  async invoke(invocation: ToolInvocation): Promise<ToolResultEnvelope> {
    const identity = resolveInvocationIdentity(invocation);
    const descriptor = this.#registry.get(identity.name);
    if (!descriptor) {
      return toolFailure(identity, "error", {
        code: "unknown_tool",
        message: `Unknown tool: ${identity.name}`,
      });
    }

    const handler = this.#handlers.get(descriptor.name);
    if (!handler) {
      // 新 ToolRouter 只调用显式注册的 handler，不做 legacy fallback。
      return toolFailure(descriptor, "unavailable", {
        code: "handler_unavailable",
        message: `No handler registered for ${descriptor.name}.`,
      });
    }

    try {
      const envelope = await handler(invocation, {
        descriptor,
        registry: this.#registry,
        dependencies: this.#dependencies,
      });
      return invocation.compression
        ? this.#compressor.compressEnvelope(envelope, invocation.compression)
        : envelope;
    } catch (error) {
      return toolFailure(descriptor, "error", {
        code: "handler_error",
        message: error instanceof Error ? error.message : "Tool handler failed.",
      });
    }
  }
}

export function resolveInvocationIdentity(invocation: ToolInvocation): ToolIdentity {
  const requestedName = stringValue(invocation.name) ?? stringValue(invocation.tool);
  if (requestedName) {
    const [resource, action] = splitToolName(requestedName);
    return { name: requestedName, resource, action };
  }

  const resource = stringValue(invocation.resource) ?? "unknown";
  const action = stringValue(invocation.action) ?? "unknown";
  return { name: `${resource}.${action}`, resource, action };
}

function splitToolName(name: string): readonly [string, string] {
  const separator = name.indexOf(".");
  if (separator <= 0 || separator === name.length - 1) {
    return ["unknown", "unknown"];
  }
  return [name.slice(0, separator), name.slice(separator + 1)];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
