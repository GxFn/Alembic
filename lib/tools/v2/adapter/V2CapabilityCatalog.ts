/**
 * V2CapabilityCatalog — 从 V2 TOOL_REGISTRY 生成 ToolSchemaProjection。
 *
 * 实现 AgentRuntime.#getToolSchemas() 期望的 duck-type 接口:
 *   toToolSchemas(ids?) → ToolSchemaProjection[]
 *   toMixedSchemas?(ids?, model?, firstRound?) → ToolSchemaProjection[]
 *   getManifest(id) → manifest | null
 *   markExpanded?(id) → void
 *
 * V2 schema 格式:
 *   { name: "code", description: "...", parameters: { action: enum, params: ... } }
 */

import type { ToolSchemaProjection } from '#tools/catalog/CapabilityManifest.js';
import { generateLightweightSchemas, TOOL_REGISTRY } from '../registry.js';

export class V2CapabilityCatalog {
  #expandedTools = new Set<string>();

  /** 生成指定工具的完整 schema */
  toToolSchemas(ids?: readonly string[] | null): ToolSchemaProjection[] {
    return generateSchemas(ids);
  }

  /** 同上 (model 参数对 V2 无意义) */
  toToolSchemasForModel(ids?: readonly string[] | null, _model?: string): ToolSchemaProjection[] {
    return generateSchemas(ids);
  }

  /**
   * 混合模式: 首轮用轻量 schema，后续用完整 schema（已展开的工具）。
   * V2 schema 已足够轻量，直接返回完整版。
   */
  toMixedSchemas(
    ids?: readonly string[] | null,
    _model?: string,
    _firstRound?: boolean
  ): ToolSchemaProjection[] {
    return generateSchemas(ids);
  }

  /** V2 无 manifest 概念，返回 null — ToolRouter V2 直接从 TOOL_REGISTRY 查 */
  getManifest(_id: string) {
    return null;
  }

  get expandedCount() {
    return this.#expandedTools.size;
  }

  markExpanded(id: string) {
    this.#expandedTools.add(id);
  }

  has(id: string): boolean {
    return Object.hasOwn(TOOL_REGISTRY, id);
  }
}

function generateSchemas(ids?: readonly string[] | null): ToolSchemaProjection[] {
  let allowed: Record<string, string[]> | undefined;
  if (ids && ids.length > 0) {
    allowed = {};
    for (const id of ids) {
      const spec = TOOL_REGISTRY[id];
      if (spec) {
        allowed[id] = Object.keys(spec.actions);
      }
    }
  }
  const schemas = generateLightweightSchemas(allowed);
  return schemas.map((s) => ({
    name: s.name,
    description: s.description,
    parameters: s.parameters,
  }));
}
