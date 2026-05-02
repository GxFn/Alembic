/**
 * @module tools/v2/router
 *
 * V2 ToolRouter — 工具调用的统一入口。
 *
 * 流程: 参数解析 → Schema 校验 → Capability 权限检查 → 并发控制 → Handler 分发 → 输出截断
 */

import { generateLightweightSchemas, TOOL_REGISTRY } from './registry.js';
import type {
  CapabilityV2Def,
  ToolAction,
  ToolCallV2,
  ToolContext,
  ToolResult,
  ToolSpec,
} from './types.js';
import { estimateTokens, fail } from './types.js';

export interface RouterConfig {
  capability?: CapabilityV2Def;
}

export class ToolRouterV2 {
  readonly #config: RouterConfig;
  readonly #toolLocks = new Map<string, Promise<void>>();
  #globalLock: Promise<void> | null = null;
  #globalRelease: (() => void) | null = null;

  constructor(config: RouterConfig = {}) {
    this.#config = config;
  }

  /**
   * 执行工具调用。
   *
   * 完整流程: 参数校验 → Capability 检查 → 并发控制 → handler → 输出截断
   */
  async execute(call: ToolCallV2, ctx: ToolContext): Promise<ToolResult> {
    const startMs = Date.now();

    try {
      const spec = TOOL_REGISTRY[call.tool];
      const action = spec?.actions[call.action];
      if (!spec || !action) {
        return fail(
          `Invalid call: ${call.tool}.${call.action} — use parseToolCall() first to validate`
        );
      }

      const paramError = validateParams(call, action);
      if (paramError) {
        return fail(paramError);
      }

      const capCheck = this.#checkCapability(call.tool, call.action);
      if (!capCheck.allowed) {
        return fail(`Permission denied: ${call.tool}.${call.action} — ${capCheck.reason}`);
      }

      const mode = action.concurrency ?? 'parallel';
      if (mode === 'exclusive') {
        await this.#acquireGlobalLock();
      } else if (mode === 'single') {
        await this.#acquireToolLock(call.tool);
      }

      ctx.toolRegistry = TOOL_REGISTRY;

      try {
        const result = await action.handler(call.params, ctx);

        if (result._meta) {
          result._meta.durationMs = Date.now() - startMs;
        }

        if (action.maxOutputTokens && result.ok) {
          enforceOutputLimit(result, action.maxOutputTokens);
        }

        return result;
      } finally {
        if (mode === 'exclusive') {
          this.#releaseGlobalLock();
        } else if (mode === 'single') {
          this.#releaseToolLock(call.tool);
        }
      }
    } catch (err: unknown) {
      return fail(
        `Tool execution error (${call.tool}.${call.action}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * 并行执行多个工具调用，按均分策略分配 token budget。
   */
  async executeParallel(calls: ToolCallV2[], ctx: ToolContext): Promise<ToolResult[]> {
    if (calls.length === 0) {
      return [];
    }
    const perCallBudget = Math.floor(ctx.tokenBudget / calls.length);
    return Promise.all(
      calls.map((call) => {
        const callCtx = { ...ctx, tokenBudget: Math.max(perCallBudget, 1000) };
        return this.execute(call, callCtx);
      })
    );
  }

  /**
   * 从 LLM 的原始 function call 参数解析 ToolCallV2。
   *
   * LLM 返回: { name: "code", arguments: '{"action":"search","params":{...}}' }
   * 解析为:  { tool: "code", action: "search", params: {...} }
   *
   * 验证层级: 解析 → action 存在性检查 → 返回强类型 ToolCallV2
   */
  parseToolCall(
    name: string,
    rawArguments: string | Record<string, unknown>
  ): ToolCallV2 | { error: string } {
    try {
      const args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
      const action = args.action as string;
      const params = (args.params ?? {}) as Record<string, unknown>;

      if (!action) {
        return { error: `Missing "action" in tool call for ${name}` };
      }

      const spec = TOOL_REGISTRY[name];
      if (!spec) {
        return {
          error: `Unknown tool: ${name}. Available: ${Object.keys(TOOL_REGISTRY).join(', ')}`,
        };
      }
      if (!spec.actions[action]) {
        return {
          error: `Unknown action: ${name}.${action}. Available: ${Object.keys(spec.actions).join(', ')}`,
        };
      }

      return { tool: name, action, params };
    } catch (err: unknown) {
      return {
        error: `Failed to parse tool arguments: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 生成当前 capability 允许的轻量 schema 列表。
   */
  getSchemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    const allowed = this.#config.capability?.allowedTools;
    return generateLightweightSchemas(allowed);
  }

  /**
   * 获取单个工具的完整 spec（用于 meta.tools）。
   */
  getToolSpec(name: string): ToolSpec | undefined {
    return TOOL_REGISTRY[name];
  }

  /* ------------------------------------------------------------------ */
  /*  Capability 权限检查                                                */
  /* ------------------------------------------------------------------ */

  #checkCapability(tool: string, action: string): { allowed: boolean; reason?: string } {
    const cap = this.#config.capability;
    if (!cap) {
      return { allowed: true };
    }

    const allowedActions = cap.allowedTools[tool];
    if (!allowedActions) {
      return { allowed: false, reason: `Tool "${tool}" not allowed in capability "${cap.name}"` };
    }
    if (!allowedActions.includes(action)) {
      return {
        allowed: false,
        reason: `Action "${action}" not allowed for "${tool}" in capability "${cap.name}". Allowed: ${allowedActions.join(', ')}`,
      };
    }
    return { allowed: true };
  }

  /* ------------------------------------------------------------------ */
  /*  并发控制 — single (同工具互斥) / exclusive (全局独占)               */
  /* ------------------------------------------------------------------ */

  async #acquireToolLock(tool: string): Promise<void> {
    while (this.#toolLocks.has(tool)) {
      await this.#toolLocks.get(tool);
    }
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    (promise as unknown as { _release: () => void })._release = release;
    this.#toolLocks.set(tool, promise);
  }

  #releaseToolLock(tool: string): void {
    const p = this.#toolLocks.get(tool);
    this.#toolLocks.delete(tool);
    if (p) {
      (p as unknown as { _release: () => void })._release();
    }
  }

  async #acquireGlobalLock(): Promise<void> {
    while (this.#globalLock) {
      await this.#globalLock;
    }
    let release!: () => void;
    this.#globalLock = new Promise<void>((r) => {
      release = r;
    });
    this.#globalRelease = release;
  }

  #releaseGlobalLock(): void {
    const release = this.#globalRelease;
    this.#globalLock = null;
    this.#globalRelease = null;
    release?.();
  }
}

/* ------------------------------------------------------------------ */
/*  参数 Schema 校验 — 轻量内联，不依赖 ajv                             */
/* ------------------------------------------------------------------ */

function validateParams(call: ToolCallV2, action: ToolAction): string | null {
  const schema = action.params as {
    required?: string[];
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
  };

  if (schema.required) {
    for (const field of schema.required) {
      if (call.params[field] === undefined || call.params[field] === null) {
        return `Missing required param "${field}" for ${call.tool}.${call.action}`;
      }
    }
  }

  if (schema.properties) {
    for (const [key, val] of Object.entries(call.params)) {
      const prop = schema.properties[key];
      if (!prop) {
        continue;
      }
      if (prop.enum && !prop.enum.includes(val)) {
        return (
          `Invalid value "${String(val)}" for ${call.tool}.${call.action}.${key}. ` +
          `Expected: ${prop.enum.join(', ')}`
        );
      }
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  输出 token 截断 — 按 action.maxOutputTokens 强制执行                */
/* ------------------------------------------------------------------ */

function enforceOutputLimit(result: ToolResult, maxTokens: number): void {
  if (typeof result.data !== 'string') {
    return;
  }
  const tokens = estimateTokens(result.data);
  if (tokens <= maxTokens) {
    return;
  }
  const maxChars = maxTokens * 4;
  const headChars = Math.floor(maxChars * 0.8);
  const tailChars = Math.floor(maxChars * 0.15);
  const head = result.data.slice(0, headChars);
  const tail = result.data.slice(-tailChars);
  const omitted = result.data.length - headChars - tailChars;
  result.data = `${head}\n\n... [${omitted} chars truncated, exceeded ${maxTokens} token limit] ...\n\n${tail}`;
  if (result._meta) {
    result._meta.tokensEstimate = estimateTokens(result.data as string);
  }
}
