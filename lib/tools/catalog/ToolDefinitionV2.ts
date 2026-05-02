/**
 * ToolDefinitionV2 — 统一工具定义 (单源真相)
 *
 * 合并原有 `ToolDefinition`（handler + basic metadata）和
 * `ToolCapabilityManifest`（risk + governance + execution）为单一接口。
 *
 * V1 工具通过 `toolDefV1ToV2()` 桥接函数迁移，
 * 新工具直接使用 V2 接口定义。
 *
 * @module tools/catalog/ToolDefinitionV2
 */

import type {
  CapabilityKind,
  ToolCapabilityManifest,
  ToolExecutionProfile,
  ToolGovernanceProfile,
  ToolRiskProfile,
  ToolSchemaProjection,
} from '#tools/catalog/CapabilityManifest.js';
import { createInternalToolManifest } from '#tools/catalog/CapabilityProjection.js';
import type { ToolDefinition } from '#tools/catalog/ToolDefinition.js';

// ── V2 Handler Type ──

export type ToolHandler = (
  args: Record<string, unknown>,
  context: Record<string, unknown>
) => unknown | Promise<unknown>;

// ── V2 Interface ──

export interface ToolDefinitionV2 {
  id: string;
  title: string;
  description: string;
  kind: CapabilityKind;

  /** JSON Schema for tool input */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for tool output (optional, for documentation) */
  outputSchema?: Record<string, unknown>;

  risk: ToolRiskProfile;
  governance: ToolGovernanceProfile;
  execution: ToolExecutionProfile;

  handler: ToolHandler;

  /**
   * Per-model description/schema overrides.
   * Keys are glob patterns matched against model id (e.g. 'deepseek-*', 'claude-*').
   */
  modelOverrides?: Record<
    string,
    {
      description?: string;
      inputSchema?: Record<string, unknown>;
    }
  >;
}

// ── V1 → V2 Bridge ──

/**
 * Convert a V1 `ToolDefinition` to `ToolDefinitionV2`.
 * Uses `createInternalToolManifest` to compute manifest fields
 * (risk, governance, execution) from the V1 metadata.
 */
export function toolDefV1ToV2(def: ToolDefinition): ToolDefinitionV2 {
  const manifest = createInternalToolManifest(def);
  return {
    id: def.name,
    title: manifest.title,
    description: def.description,
    kind: manifest.kind,
    inputSchema: def.parameters || {},
    risk: manifest.risk,
    governance: manifest.governance,
    execution: manifest.execution,
    handler: def.handler as unknown as ToolHandler,
    modelOverrides: MODEL_OVERRIDES[def.name],
  };
}

/**
 * Per-model description overrides for high-frequency tools.
 *
 * DeepSeek: direct imperative style, simplified parameter hints.
 * Applied via v2ToSchemaProjection when model matches the glob pattern.
 */
const MODEL_OVERRIDES: Record<
  string,
  Record<string, { description?: string; inputSchema?: Record<string, unknown> }> | undefined
> = {
  search_project_code: {
    'deepseek-*': {
      description:
        '搜索项目代码。参数: pattern(正则表达式,必填), fileFilter(可选,glob如*.ts), maxResults(可选,默认20)。返回匹配行及文件路径。',
    },
  },
  read_project_file: {
    'deepseek-*': {
      description:
        '读取项目文件内容。参数: filePath(必填,相对路径), startLine/endLine(可选,行范围)。返回文件文本。',
    },
  },
  submit_with_check: {
    'deepseek-*': {
      description:
        '提交知识条目并自动质量检查。参数: title(必填), content(必填,对象{markdown,rationale,pattern}), trigger(必填,@kebab-case), kind(必填,rule/pattern/fact)。',
    },
  },
  list_project_structure: {
    'deepseek-*': {
      description:
        '列出项目目录结构。参数: path(可选,子目录), depth(可选,递归深度,默认3)。返回树形结构文本。',
    },
  },
  semantic_search_code: {
    'deepseek-*': {
      description:
        '语义搜索代码。参数: query(必填,自然语言描述), topK(可选,结果数,默认5)。返回语义相关代码片段。',
    },
  },
};

// ── V2 → Manifest Projection (for CapabilityCatalog compatibility) ──

export function v2ToManifest(def: ToolDefinitionV2): ToolCapabilityManifest {
  return {
    id: def.id,
    title: def.title,
    kind: def.kind,
    description: def.description,
    owner: 'core',
    lifecycle: 'active',
    surfaces: inferSurfacesFromGovernance(def),
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    risk: def.risk,
    execution: def.execution,
    governance: def.governance,
    evals: {
      required: def.risk.sideEffect || def.governance.policyProfile !== 'read',
      cases: [],
    },
  };
}

// ── V2 → Schema Projection (for LLM tool descriptions) ──

export function v2ToSchemaProjection(def: ToolDefinitionV2, model?: string): ToolSchemaProjection {
  const override = model ? matchModelOverride(def, model) : undefined;
  return {
    name: def.id,
    description: override?.description ?? def.description,
    parameters: override?.inputSchema ?? def.inputSchema,
  };
}

function matchModelOverride(
  def: ToolDefinitionV2,
  model: string
): { description?: string; inputSchema?: Record<string, unknown> } | undefined {
  if (!def.modelOverrides) {
    return undefined;
  }
  for (const [pattern, override] of Object.entries(def.modelOverrides)) {
    if (matchGlob(model, pattern)) {
      return override;
    }
  }
  return undefined;
}

function matchGlob(value: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }
  const starIdx = pattern.indexOf('*');
  if (starIdx < 0) {
    return value === pattern;
  }
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  return (
    value.startsWith(prefix) &&
    value.endsWith(suffix) &&
    value.length >= prefix.length + suffix.length
  );
}

function inferSurfacesFromGovernance(def: ToolDefinitionV2) {
  const surfaces: Array<'runtime' | 'http' | 'mcp' | 'dashboard' | 'skill' | 'internal'> = [
    'runtime',
  ];
  if (def.governance.allowInRemoteMcp) {
    surfaces.push('mcp');
  }
  if (!def.risk.sideEffect) {
    surfaces.push('http');
  }
  return surfaces;
}
