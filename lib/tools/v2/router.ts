/**
 * @module tools/v2/router
 *
 * V2 ToolRouter — 工具调用的统一入口。
 *
 * 流程: 参数解析 → Schema 校验 → Capability 权限检查 → Handler 分发 → 结果返回
 */

import { generateLightweightSchemas, TOOL_REGISTRY } from './registry.js';
import type { CapabilityV2Def, ToolCallV2, ToolContext, ToolResult, ToolSpec } from './types.js';
import { fail } from './types.js';

export interface RouterConfig {
  capability?: CapabilityV2Def;
}

export class ToolRouterV2 {
  readonly #config: RouterConfig;

  constructor(config: RouterConfig = {}) {
    this.#config = config;
  }

  /**
   * 执行工具调用。
   *
   * @param call - 解析后的工具调用
   * @param ctx - handler 上下文
   * @returns 工具结果
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

      const capCheck = this.#checkCapability(call.tool, call.action);
      if (!capCheck.allowed) {
        return fail(`Permission denied: ${call.tool}.${call.action} — ${capCheck.reason}`);
      }

      ctx.toolRegistry = TOOL_REGISTRY;

      const result = await action.handler(call.params, ctx);

      if (result._meta) {
        result._meta.durationMs = Date.now() - startMs;
      }

      return result;
    } catch (err: unknown) {
      return fail(
        `Tool execution error (${call.tool}.${call.action}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * 并行执行多个工具调用。
   */
  async executeParallel(calls: ToolCallV2[], ctx: ToolContext): Promise<ToolResult[]> {
    return Promise.all(calls.map((call) => this.execute(call, ctx)));
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
}
