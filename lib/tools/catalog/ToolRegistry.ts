/**
 * ToolRegistry — 统一工具注册表
 *
 * 管理 Agent 可调用的所有工具定义。
 * 每个工具包含: name, description, parameters(JSON Schema), handler
 *
 * 设计原则:
 * - 所有 AI 能力均封装为 Tool，不再散落在各处
 * - Tool handler 仅做参数整理 + 调用已有 Service，不含业务逻辑
 * - 支持 Agent ReAct 循环调用（通过 LLM 推理决定工具调用）
 */

import Logger from '#infra/logging/Logger.js';
import type { ToolDefinition, ToolMetadata } from '#tools/catalog/ToolDefinition.js';
import type {
  ForgedInternalToolDefinition,
  ForgedInternalToolStore,
  InternalToolHandler,
  InternalToolHandlerEntry,
  InternalToolHandlerStore,
} from '#tools/core/InternalToolHandler.js';
import type { ToolRouterContract } from '#tools/core/ToolContracts.js';

/** 内部存储的工具条目（parameters 已默认化） */
interface StoredToolEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  metadata: ToolMetadata;
  handler: InternalToolHandler;
}

export class ToolRegistry implements InternalToolHandlerStore, ForgedInternalToolStore {
  #tools = new Map<string, StoredToolEntry>();
  #logger;
  #router: ToolRouterContract | null = null;

  constructor() {
    this.#logger = Logger.getInstance();
  }

  /**
   * 注册一个工具
   * @param toolDef.name 工具唯一名称 (snake_case)
   * @param toolDef.description 给 LLM 看的工具描述
   * @param toolDef.parameters JSON Schema 格式的参数定义
   * @param toolDef.handler async (params, context) => result
   */
  register(toolDef: ToolDefinition) {
    const { name, description, handler, parameters = {}, metadata = {} } = toolDef;
    if (!name || !handler) {
      throw new Error('Tool must have name and handler');
    }
    this.#tools.set(name, {
      name,
      description,
      parameters,
      metadata,
      handler: handler as InternalToolHandler,
    });
  }

  /** 批量注册 */
  registerAll(defs: ToolDefinition[]) {
    for (const def of defs) {
      this.register(def);
    }
    this.#logger.info(`[ToolRegistry] ${defs.length} tools registered`);
  }

  setRouter(router: ToolRouterContract | null) {
    this.#router = router;
  }

  getRouter() {
    return this.#router;
  }

  getInternalTool(name: string): InternalToolHandlerEntry | null {
    const tool = this.#tools.get(name);
    if (!tool) {
      return null;
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      metadata: { ...tool.metadata },
      handler: tool.handler,
    };
  }

  hasInternalTool(name: string) {
    return this.#tools.has(name);
  }

  projectForgedTool(tool: ForgedInternalToolDefinition) {
    if (this.#tools.has(tool.name)) {
      throw new Error(
        `Forged tool "${tool.name}" conflicts with an existing internal tool. Use a unique forge namespace.`
      );
    }
    this.register({
      name: tool.name,
      description: `[Forged:${tool.forgeMode}] ${tool.description}`,
      parameters: tool.parameters,
      metadata: {
        owner: 'agent-forge',
        lifecycle: 'experimental',
        sideEffect: true,
        policyProfile: 'write',
        auditLevel: 'full',
      },
      handler: tool.handler as (...args: never[]) => unknown,
    });
  }

  revokeForgedTool(name: string): boolean {
    return this.#tools.delete(name);
  }

  /** 检查工具是否存在 */
  has(name: string) {
    return this.#tools.has(name);
  }

  /** 移除一个已注册的工具（Forge TTL 回收用） */
  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  /** 工具数量 */
  get size() {
    return this.#tools.size;
  }
}

export default ToolRegistry;
