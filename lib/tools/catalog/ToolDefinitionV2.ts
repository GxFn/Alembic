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
  };
}

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
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  if (pattern.startsWith('*')) {
    return value.endsWith(pattern.slice(1));
  }
  return value === pattern;
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
