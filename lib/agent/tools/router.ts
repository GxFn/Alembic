import { InMemoryToolDeltaCache, InMemoryToolSearchCache } from "./cache-store.js";
import { ToolOutputCompressor } from "./compressor.js";
import { createDefaultToolHandlers } from "./handlers/index.js";
import { InMemoryToolMemoryStore } from "./memory-store.js";
import { createDefaultToolRegistry } from "./registry.js";
import { validateToolInputSchema } from "./schema.js";
import { DefaultToolTerminalOutputCompressor } from "./terminal-output-compressor.js";
import type {
  ToolHandler,
  ToolIdentity,
  ToolInvocation,
  ToolRegistryReader,
  ToolResultEnvelope,
  ToolRuntimeDependencies,
} from "./types.js";
import { isRecord, toolFailure } from "./types.js";

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
  readonly #toolLocks = new Map<string, Promise<void>>();
  #exclusiveLock: Promise<void> | null = null;
  #exclusivePending: Promise<void> | null = null;
  #exclusiveRelease: (() => void) | null = null;
  #activeNonExclusiveTools = 0;
  readonly #nonExclusiveIdleWaiters: Array<() => void> = [];

  constructor(options: ToolRouterOptions = {}) {
    this.#registry = options.registry ?? createDefaultToolRegistry();
    this.#handlers = options.handlers ?? createDefaultToolHandlers();
    // 中文注释：内部 tools 默认拥有一次 Router 生命周期内的工作记忆；
    // 外部如果有更持久的 memory coordinator，可以通过 dependencies 覆盖。
    const memoryStore = new InMemoryToolMemoryStore(
      options.dependencies?.now ? { now: options.dependencies.now } : {},
    );
    this.#dependencies = {
      deltaCache: new InMemoryToolDeltaCache(),
      searchCache: new InMemoryToolSearchCache(),
      terminalCompressor: new DefaultToolTerminalOutputCompressor(),
      memoryStore,
      ...options.dependencies,
    };
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

    const schemaCheck = validateToolInputSchema(descriptor.inputSchema, invocation.input);
    if (!schemaCheck.ok) {
      return toolFailure(descriptor, "error", {
        code: "invalid_input_schema",
        message: schemaCheck.errors.join("; "),
        details: { errors: schemaCheck.errors },
      });
    }

    const release = await this.#acquireLock(descriptor);
    try {
      const envelope = await handler(invocation, {
        descriptor,
        registry: this.#registry,
        dependencies: this.#dependencies,
      });
      // 中文注释：registry 的 maxOutputTokens 是默认保护网，调用方仍可用
      // invocation.compression 覆盖，或显式传 false 关闭压缩。
      const defaultCompression = descriptor.maxOutputTokens
        ? { maxStringLength: descriptor.maxOutputTokens * 4 }
        : undefined;
      const compression =
        invocation.compression === false
          ? undefined
          : (invocation.compression ?? defaultCompression);
      return compression ? this.#compressor.compressEnvelope(envelope, compression) : envelope;
    } catch (error) {
      return toolFailure(descriptor, "error", {
        code: "handler_error",
        message: error instanceof Error ? error.message : "Tool handler failed.",
      });
    } finally {
      release();
    }
  }

  async invokeParallel(invocations: readonly ToolInvocation[]): Promise<ToolResultEnvelope[]> {
    return Promise.all(invocations.map((invocation) => this.invoke(invocation)));
  }

  parseToolCall(
    name: string,
    rawArguments: string | Record<string, unknown>,
  ): ToolInvocation | { readonly error: string } {
    let args: Record<string, unknown>;
    try {
      const parsed = typeof rawArguments === "string" ? JSON.parse(rawArguments) : rawArguments;
      if (!isRecord(parsed)) {
        return { error: "Tool arguments must decode to an object." };
      }
      args = parsed;
    } catch (error) {
      return {
        error: `Failed to parse tool arguments: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const action = stringValue(args.action);
    const nestedInput = isRecord(args.params)
      ? args.params
      : isRecord(args.input)
        ? args.input
        : {};
    const topLevelInput = Object.fromEntries(
      Object.entries(args).filter(([key]) => !["action", "params", "input"].includes(key)),
    );
    const input = { ...topLevelInput, ...nestedInput };
    const requestedName = name.includes(".") ? name : action ? `${name}.${action}` : name;
    if (!this.#registry.get(requestedName)) {
      return { error: `Unknown tool: ${requestedName}` };
    }
    return { name: requestedName, input };
  }

  async #acquireLock(descriptor: { readonly name: string; readonly concurrency?: string }) {
    const mode = descriptor.concurrency ?? "parallel";
    if (mode === "exclusive") {
      await this.#acquireExclusiveLock();
      return () => this.#releaseExclusiveLock();
    }
    if (mode === "single") {
      await this.#waitForExclusiveClear();
      await this.#acquireToolLock(descriptor.name);
      await this.#waitForExclusiveClear();
      this.#activeNonExclusiveTools += 1;
      return () => {
        this.#releaseNonExclusiveTool();
        this.#releaseToolLock(descriptor.name);
      };
    }
    await this.#waitForExclusiveClear();
    this.#activeNonExclusiveTools += 1;
    return () => this.#releaseNonExclusiveTool();
  }

  async #acquireToolLock(name: string): Promise<void> {
    while (this.#toolLocks.has(name)) {
      await this.#toolLocks.get(name);
    }
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    (promise as Promise<void> & { release: () => void }).release = release;
    this.#toolLocks.set(name, promise);
  }

  #releaseToolLock(name: string): void {
    const promise = this.#toolLocks.get(name);
    this.#toolLocks.delete(name);
    (promise as (Promise<void> & { release?: () => void }) | undefined)?.release?.();
  }

  async #waitForExclusiveClear(): Promise<void> {
    while (this.#exclusivePending || this.#exclusiveLock) {
      await (this.#exclusivePending ?? this.#exclusiveLock);
    }
  }

  async #acquireExclusiveLock(): Promise<void> {
    await this.#waitForExclusiveClear();
    let releasePending!: () => void;
    this.#exclusivePending = new Promise<void>((resolve) => {
      releasePending = resolve;
    });

    try {
      await this.#waitForNonExclusiveToolsIdle();
      let release!: () => void;
      this.#exclusiveLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.#exclusiveRelease = release;
    } finally {
      this.#exclusivePending = null;
      releasePending();
    }
  }

  async #waitForNonExclusiveToolsIdle(): Promise<void> {
    while (this.#activeNonExclusiveTools > 0) {
      await new Promise<void>((resolve) => {
        this.#nonExclusiveIdleWaiters.push(resolve);
      });
    }
  }

  #releaseNonExclusiveTool(): void {
    this.#activeNonExclusiveTools = Math.max(0, this.#activeNonExclusiveTools - 1);
    if (this.#activeNonExclusiveTools > 0) {
      return;
    }
    for (const resolve of this.#nonExclusiveIdleWaiters.splice(0)) {
      resolve();
    }
  }

  #releaseExclusiveLock(): void {
    const release = this.#exclusiveRelease;
    this.#exclusiveLock = null;
    this.#exclusiveRelease = null;
    release?.();
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
