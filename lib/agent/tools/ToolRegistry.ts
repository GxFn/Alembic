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

// ─── 本地类型 ──────────────────────────────────────────

export type ToolSurface = 'runtime' | 'http' | 'mcp' | 'dashboard';
export type ToolPolicyProfile = 'read' | 'analysis' | 'write' | 'system' | 'admin';
export type ToolAuditLevel = 'none' | 'checkOnly' | 'full';
export type ToolAbortMode = 'none' | 'preStart' | 'cooperative' | 'hardTimeout';

export interface ToolMetadata {
  /** 工具暴露面；由 ALL_TOOLS 投影到 Runtime/HTTP/MCP/Dashboard 等入口 */
  surface?: ToolSurface[];
  /** 是否允许通过 HTTP /agent/tool 或未知 /agent/task 直通调用 */
  directCallable?: boolean;
  /** 工具是否会写入状态、执行命令或触发外部副作用 */
  sideEffect?: boolean;
  /** 是否允许作为 DynamicComposer 等组合工具的内部步骤 */
  composable?: boolean;
  /** 未来接入 Gateway 时可映射到的动作名 */
  gatewayAction?: string;
  /** Gateway 权限检查使用的资源名或路径 */
  gatewayResource?: string;
  /** 权限与安全策略画像，用于跨入口投影 */
  policyProfile?: ToolPolicyProfile;
  /** HTTP/MCP 入口的审计强度 */
  auditLevel?: ToolAuditLevel;
  /** 中止信号支持方式 */
  abortMode?: ToolAbortMode;
}

/** 工具定义输入 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  metadata?: ToolMetadata;
  handler: (...args: never[]) => unknown;
}

/** 内部存储的工具条目（parameters 已默认化） */
interface StoredToolEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  metadata: ToolMetadata;
  handler: (params: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;
}

/** JSON Schema 参数定义 */
interface ToolParameterSchema {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: string[];
  enum?: unknown[];
  items?: unknown;
}

/**
 * AI 模型常见的参数命名变体 → schema 标准名映射
 * 覆盖 Gemini / GPT / DeepSeek / Claude 常见偏好
 */
const PARAM_ALIASES = {
  // read_project_file 变体
  file: 'filePath',
  filename: 'filePath',
  file_name: 'filePath',
  filepath: 'filePath',
  file_path: 'filePath',
  path: 'filePath',
  // search_project_code 变体
  query: 'pattern',
  search: 'pattern',
  keyword: 'pattern',
  search_query: 'pattern',
  search_text: 'pattern',
  regex: 'pattern',
  // 通用变体
  is_regex: 'isRegex',
  file_filter: 'fileFilter',
  context_lines: 'contextLines',
  max_results: 'maxResults',
  start_line: 'startLine',
  end_line: 'endLine',
  max_lines: 'maxLines',
  candidate_id: 'candidateId',
  recipe_id: 'recipeId',
  skill_name: 'skillName',
};

export class ToolRegistry {
  #tools = new Map<string, StoredToolEntry>();
  #logger;

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
      handler: handler as StoredToolEntry['handler'],
    });
  }

  /** 批量注册 */
  registerAll(defs: ToolDefinition[]) {
    for (const def of defs) {
      this.register(def);
    }
    this.#logger.info(`[ToolRegistry] ${defs.length} tools registered`);
  }

  /**
   * 获取工具定义（不含 handler，给 LLM prompt 使用）
   * @param [allowedTools] 限制返回的工具列表（不传则返回全部）
   * @returns >}
   */
  getToolSchemas(allowedTools?: readonly unknown[] | null) {
    const schemas: { name: string; description: string; parameters: Record<string, unknown> }[] =
      [];
    for (const [name, tool] of this.#tools) {
      if (allowedTools && !allowedTools.includes(name)) {
        continue;
      }
      schemas.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    }
    return schemas;
  }

  getToolMetadata(name: string) {
    return this.#tools.get(name)?.metadata || null;
  }

  isDirectCallable(name: string) {
    return this.#tools.get(name)?.metadata.directCallable === true;
  }

  /**
   * 直接执行某个工具
   * @param context { container, aiProvider, projectRoot, ... }
   */
  async execute(
    name: string,
    params: Record<string, unknown>,
    context: Record<string, unknown> = {}
  ) {
    const tool = this.#tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found`);
    }

    // 参数归一化: AI 可能用 snake_case / 不同命名传参，
    // 将其映射到 tool schema 中定义的 camelCase 参数名
    const normalized = this.#normalizeParams(params, tool.parameters);
    const validationErrors = this.#validateParams(normalized, tool.parameters);
    if (validationErrors.length > 0) {
      const message = `Tool '${name}' 参数校验失败: ${validationErrors.join('; ')}`;
      this.#logger.warn(message);
      return { error: message };
    }

    this.#logger.debug(`Tool execute: ${name}`, { params: Object.keys(normalized) });
    try {
      const result = await tool.handler(normalized, context);
      return result;
    } catch (err: unknown) {
      const e = err as Error & { code?: string };
      // API Key 缺失为配置问题，降为 info 级别
      if (e.code === 'API_KEY_MISSING') {
        this.#logger.info(`Tool '${name}' 跳过: ${e.message}`);
      } else {
        this.#logger.error(`Tool '${name}' failed`, { error: e.message });
      }
      return { error: e.message };
    }
  }

  #validateParams(params: Record<string, unknown>, schema: ToolParameterSchema) {
    const errors: string[] = [];
    const properties = schema?.properties || {};

    for (const key of schema?.required || []) {
      if (!(key in params) || params[key] === undefined || params[key] === null) {
        errors.push(`缺少必填参数 "${key}"`);
      }
    }

    for (const [key, value] of Object.entries(params)) {
      const propSchema = properties[key] as ToolParameterSchema | undefined;
      if (!propSchema) {
        continue;
      }
      errors.push(...this.#validateValue(value, propSchema, key));
    }

    return errors;
  }

  #validateValue(value: unknown, schema: ToolParameterSchema, fieldPath: string): string[] {
    const errors: string[] = [];
    const allowedTypes = Array.isArray(schema.type)
      ? schema.type
      : schema.type
        ? [schema.type]
        : [];

    if (allowedTypes.length > 0 && !allowedTypes.some((type) => this.#matchesType(value, type))) {
      errors.push(`参数 "${fieldPath}" 类型应为 ${allowedTypes.join('|')}`);
      return errors;
    }

    if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
      errors.push(`参数 "${fieldPath}" 必须是: ${schema.enum.map(String).join(', ')}`);
    }

    if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
      const objectValue = value as Record<string, unknown>;
      for (const key of schema.required || []) {
        if (!(key in objectValue) || objectValue[key] === undefined || objectValue[key] === null) {
          errors.push(`缺少必填参数 "${fieldPath}.${key}"`);
        }
      }
      for (const [key, childValue] of Object.entries(objectValue)) {
        const childSchema = schema.properties[key] as ToolParameterSchema | undefined;
        if (childSchema) {
          errors.push(...this.#validateValue(childValue, childSchema, `${fieldPath}.${key}`));
        }
      }
    }

    if (schema.items && Array.isArray(value)) {
      const itemSchema = schema.items as ToolParameterSchema;
      value.forEach((item, index) => {
        errors.push(...this.#validateValue(item, itemSchema, `${fieldPath}[${index}]`));
      });
    }

    return errors;
  }

  #matchesType(value: unknown, type: string) {
    if (type === 'array') {
      return Array.isArray(value);
    }
    if (type === 'object') {
      return !!value && typeof value === 'object' && !Array.isArray(value);
    }
    if (type === 'integer') {
      return Number.isInteger(value);
    }
    if (type === 'number') {
      return typeof value === 'number' && Number.isFinite(value);
    }
    if (type === 'null') {
      return value === null;
    }
    return typeof value === type;
  }

  /**
   * 参数归一化 — 将 AI 传来的 snake_case / 变体参数名映射到 schema 定义名
   *
   * 例: AI 传 { file_path: "x.m" } → schema 定义 filePath → 归一化为 { filePath: "x.m" }
   *     AI 传 { file: "x.m" }      → schema 定义 filePath → 通过别名表匹配
   *
   * 策略:
   *   1. schema 中已有的 key → 保留不动
   *   2. snake_case → camelCase 自动转换
   *   3. 常用别名表兜底
   */
  #normalizeParams(params: Record<string, unknown>, schema: ToolParameterSchema) {
    if (!params || typeof params !== 'object') {
      return params || {};
    }
    const properties = schema?.properties || {};
    const schemaKeys = new Set(Object.keys(properties));
    if (schemaKeys.size === 0) {
      return params;
    }

    const result: Record<string, unknown> = {};
    const unmatched: string[] = [];

    for (const [key, value] of Object.entries(params)) {
      // 1. 精确匹配 — 已在 schema 中
      if (schemaKeys.has(key)) {
        result[key] = value;
        continue;
      }

      // 2. snake_case → camelCase 转换
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (schemaKeys.has(camelKey)) {
        result[camelKey] = value;
        continue;
      }

      // 3. 常用别名映射
      const aliased = (PARAM_ALIASES as Record<string, string>)[key];
      if (aliased && schemaKeys.has(aliased)) {
        result[aliased] = value;
        continue;
      }

      // 4. 无匹配 — 保留原样（handler 可能有自定义处理）
      result[key] = value;
      unmatched.push(key);
    }

    if (unmatched.length > 0) {
      this.#logger.debug(
        `[ToolRegistry] param normalization: unmatched keys [${unmatched.join(', ')}]`
      );
    }

    return result;
  }

  /** 检查工具是否存在 */
  has(name: string) {
    return this.#tools.has(name);
  }

  /** 移除一个已注册的工具（Forge TTL 回收用） */
  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  /** 获取所有工具名 */
  getToolNames() {
    return [...this.#tools.keys()];
  }

  /** 工具数量 */
  get size() {
    return this.#tools.size;
  }
}

export default ToolRegistry;
