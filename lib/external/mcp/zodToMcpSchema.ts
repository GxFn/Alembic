/**
 * zodToMcpSchema.ts — Zod v4 → MCP-compatible JSON Schema 转换器
 *
 * 将 Zod schema 转为 MCP SDK 所需的 inputSchema 格式：
 *   1. 移除 $schema（MCP 不需要 meta-schema 声明）
 *   2. 带 default 值的字段从 required 中移除（Agent 可省略，Zod parse 自动填充）
 *   3. 移除 additionalProperties: false（允许前向兼容的额外字段）
 *   4. 清理 integer 的冗余 min/max 边界（Zod v4 自动加的 ±MAX_SAFE_INTEGER）
 *
 * @module external/mcp/zodToMcpSchema
 */

import { z } from 'zod';

/** MCP 工具 inputSchema 的类型化结构 */
export interface McpInputSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  [key: string]: unknown;
}

type JsonSchemaObj = Record<string, unknown>;

/**
 * 递归清理 JSON Schema 对象
 */
function cleanJsonSchema(obj: JsonSchemaObj): JsonSchemaObj {
  const cleaned = { ...obj };

  // 移除顶层 $schema
  delete cleaned['$schema'];

  // 移除 additionalProperties: false
  if (cleaned['additionalProperties'] === false) {
    delete cleaned['additionalProperties'];
  }

  // 清理 integer 的冗余边界
  if (cleaned['type'] === 'integer') {
    if (cleaned['minimum'] === -9007199254740991) {
      delete cleaned['minimum'];
    }
    if (cleaned['maximum'] === 9007199254740991) {
      delete cleaned['maximum'];
    }
  }

  // 带 default 的字段从 required 中移除
  const properties = cleaned['properties'] as Record<string, JsonSchemaObj> | undefined;
  if (properties && Array.isArray(cleaned['required'])) {
    const required = (cleaned['required'] as string[]).filter((key) => {
      const prop = properties[key];
      return prop && !('default' in prop);
    });
    cleaned['required'] = required.length > 0 ? required : [];
  }

  // 递归处理 properties 内部的 object/array 类型
  if (properties) {
    const cleanedProps: Record<string, JsonSchemaObj> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      cleanedProps[key] = cleanJsonSchema(propSchema);
    }
    cleaned['properties'] = cleanedProps;
  }

  // 递归处理 items（数组元素）
  if (cleaned['items'] && typeof cleaned['items'] === 'object') {
    cleaned['items'] = cleanJsonSchema(cleaned['items'] as JsonSchemaObj);
  }

  // 递归处理 anyOf / oneOf / allOf（用于 union / discriminatedUnion / intersection）
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(cleaned[keyword])) {
      cleaned[keyword] = (cleaned[keyword] as JsonSchemaObj[]).map(cleanJsonSchema);
    }
  }

  return cleaned;
}

/**
 * 将 Zod schema 转换为 MCP 兼容的 JSON Schema
 *
 * @param schema Zod 类型定义
 * @returns MCP inputSchema 格式的 JSON Schema 对象
 *
 * @example
 *   import { SearchInput } from '#shared/schemas/mcp-tools.js';
 *   const inputSchema = zodToMcpSchema(SearchInput);
 *   // → { type: 'object', properties: { query: { type: 'string', minLength: 1 }, ... }, required: ['query'] }
 */
export function zodToMcpSchema(schema: z.ZodType): McpInputSchema {
  const raw = z.toJSONSchema(schema) as JsonSchemaObj;
  const cleaned = cleanJsonSchema(raw);
  // 保证 type/properties/required 字段存在
  return {
    type: 'object',
    properties: (cleaned['properties'] as Record<string, Record<string, unknown>>) || {},
    required: (cleaned['required'] as string[]) || [],
    ...cleaned,
  };
}
