/**
 * UnifiedToolCatalog — 统一工具目录 (单源真相)
 *
 * 合并 `CapabilityCatalog`（manifest 查询）和 `ToolRegistry`（handler 查询）。
 * 继承 `CapabilityCatalog` 以保持对 `ToolRouter` 的兼容。
 *
 * 内部存储 `ToolDefinitionV2`，对外暴露：
 *   - getManifest(id) — 返回 ToolCapabilityManifest（兼容 GovernanceEngine）
 *   - getHandler(id) — 返回 handler function
 *   - getInternalTool(id) — 兼容 InternalToolHandlerStore
 *   - toToolSchemas(ids?, model?) — 支持 per-model 描述覆盖
 *
 * @module tools/catalog/UnifiedToolCatalog
 */

import { CapabilityCatalog } from '#tools/catalog/CapabilityCatalog.js';
import type { ToolSchemaProjection } from '#tools/catalog/CapabilityManifest.js';
import {
  type ToolDefinitionV2,
  type ToolHandler,
  v2ToManifest,
  v2ToSchemaProjection,
} from '#tools/catalog/ToolDefinitionV2.js';
import type {
  ForgedInternalToolDefinition,
  ForgedInternalToolStore,
  InternalToolHandler,
  InternalToolHandlerEntry,
  InternalToolHandlerStore,
} from '#tools/core/InternalToolHandler.js';
import type { ToolRouterContract } from '#tools/core/ToolContracts.js';

export class UnifiedToolCatalog
  extends CapabilityCatalog
  implements InternalToolHandlerStore, ForgedInternalToolStore
{
  readonly #defs = new Map<string, ToolDefinitionV2>();
  readonly #temporary = new Map<string, ToolDefinitionV2>();
  #router: ToolRouterContract | null = null;

  constructor(defs: ToolDefinitionV2[] = []) {
    super([]);
    this.registerV2All(defs);
  }

  // ── Router binding (replaces ToolRegistry.setRouter/getRouter) ──

  setRouter(router: ToolRouterContract | null): void {
    this.#router = router;
  }

  getRouter(): ToolRouterContract | null {
    return this.#router;
  }

  // ── V2 Registration ──

  registerV2(def: ToolDefinitionV2): void {
    if (this.#defs.has(def.id)) {
      throw new Error(`Tool '${def.id}' already registered in UnifiedToolCatalog`);
    }
    this.#defs.set(def.id, def);
    // Also register as CapabilityManifest for backward compatibility
    super.register(v2ToManifest(def));
  }

  registerV2All(defs: ToolDefinitionV2[]): void {
    for (const def of defs) {
      this.registerV2(def);
    }
  }

  // ── Temporary tools (Forge) ──

  registerTemporary(def: ToolDefinitionV2): void {
    this.#temporary.set(def.id, def);
    this.#defs.set(def.id, def);
    try {
      super.register(v2ToManifest(def));
    } catch {
      // Already registered — update via unregister + re-register
      super.unregister(def.id);
      super.register(v2ToManifest(def));
    }
  }

  unregisterTemporary(id: string): boolean {
    this.#temporary.delete(id);
    this.#defs.delete(id);
    return super.unregister(id);
  }

  // ── Handler Access ──

  getHandler(id: string): ToolHandler | null {
    return this.#defs.get(id)?.handler ?? null;
  }

  getDefinitionV2(id: string): ToolDefinitionV2 | null {
    return this.#defs.get(id) ?? null;
  }

  // ── InternalToolHandlerStore compatibility ──

  getInternalTool(name: string): InternalToolHandlerEntry | null {
    const def = this.#defs.get(name);
    if (!def) {
      return null;
    }

    return {
      name: def.id,
      description: def.description,
      parameters: def.inputSchema,
      metadata: {
        owner: 'core',
        lifecycle: 'active',
        sideEffect: def.risk.sideEffect,
        policyProfile: def.governance.policyProfile,
        auditLevel: def.governance.auditLevel,
      },
      handler: def.handler as unknown as InternalToolHandler,
    };
  }

  hasInternalTool(name: string): boolean {
    return this.#defs.has(name);
  }

  // ── ForgedInternalToolStore compatibility ──

  projectForgedTool(tool: ForgedInternalToolDefinition): void {
    if (this.#defs.has(tool.name) && !this.#temporary.has(tool.name)) {
      throw new Error(
        `Forged tool "${tool.name}" conflicts with an existing internal tool. Use a unique forge namespace.`
      );
    }
    const v2Def: ToolDefinitionV2 = {
      id: tool.name,
      title: tool.name,
      description: `[Forged:${tool.forgeMode}] ${tool.description}`,
      kind: 'internal-tool',
      inputSchema: tool.parameters ?? { type: 'object', properties: {} },
      handler: tool.handler as unknown as ToolHandler,
      risk: {
        sideEffect: true,
        dataAccess: 'project',
        writeScope: 'project',
        network: 'none',
        credentialAccess: 'none',
        requiresHumanConfirmation: 'never',
        owaspTags: [],
      },
      governance: {
        policyProfile: 'write',
        auditLevel: 'full',
        approvalPolicy: 'auto',
        allowedRoles: ['developer'],
        allowInComposer: false,
        allowInRemoteMcp: false,
        allowInNonInteractive: true,
      },
      execution: {
        adapter: 'internal',
        timeoutMs: 30_000,
        maxOutputBytes: 100_000,
        abortMode: 'cooperative',
        cachePolicy: 'none',
        concurrency: 'single',
        artifactMode: 'inline',
      },
    };
    this.registerTemporary(v2Def);
  }

  revokeForgedTool(name: string): boolean {
    return this.unregisterTemporary(name);
  }

  // ── Per-model Schema Projection ──

  /**
   * Override parent's toToolSchemas to support per-model description overrides.
   * When `model` is provided, tool descriptions are matched against modelOverrides.
   */
  toToolSchemasForModel(ids?: readonly string[] | null, model?: string): ToolSchemaProjection[] {
    const manifests = this.list({ ids });
    return manifests.map((manifest) => {
      const def = this.#defs.get(manifest.id);
      if (def && model) {
        return v2ToSchemaProjection(def, model);
      }
      return {
        name: manifest.id,
        description: manifest.description,
        parameters: manifest.inputSchema,
      };
    });
  }

  // ── Lazy Loading: lightweight / mixed schema projection ──

  /** Tools that have been "expanded" (used by the agent — full schema shown). */
  readonly #expandedToolIds = new Set<string>();

  /** Mark a tool as expanded (called after the tool is used in a round). */
  markExpanded(toolId: string): void {
    this.#expandedToolIds.add(toolId);
  }

  /** Mark multiple tools as expanded. */
  markExpandedAll(toolIds: string[]): void {
    for (const id of toolIds) {
      this.#expandedToolIds.add(id);
    }
  }

  /** Reset expanded state (e.g. between pipeline stages). */
  resetExpanded(): void {
    this.#expandedToolIds.clear();
  }

  /**
   * Lightweight schema: name + one-line description only (no parameters).
   * Used for tools the agent hasn't touched yet to reduce token overhead.
   */
  toLightweightSchemas(ids?: readonly string[] | null): ToolSchemaProjection[] {
    return this.list({ ids }).map((manifest) => ({
      name: manifest.id,
      description: manifest.description.split('\n')[0].slice(0, 120),
      parameters: { type: 'object', properties: {} },
    }));
  }

  /**
   * Mixed schema projection:
   *   - Expanded tools → full schema (with optional model override)
   *   - Not-yet-used tools → lightweight (name + description only)
   *
   * This reduces the total token cost of tool schemas from ~50-80% to ~20-30%
   * in large toolsets (30+ tools).
   *
   * @param ids - Allowed tool IDs
   * @param model - Current model name for per-model overrides
   * @param firstRound - If true, all tools get full schema (first iteration)
   */
  toMixedSchemas(
    ids?: readonly string[] | null,
    model?: string,
    firstRound = false
  ): ToolSchemaProjection[] {
    if (firstRound) {
      return this.toToolSchemasForModel(ids, model);
    }

    const manifests = this.list({ ids });
    return manifests.map((manifest) => {
      if (this.#expandedToolIds.has(manifest.id)) {
        const def = this.#defs.get(manifest.id);
        if (def && model) {
          return v2ToSchemaProjection(def, model);
        }
        return {
          name: manifest.id,
          description: manifest.description,
          parameters: manifest.inputSchema,
        };
      }
      return {
        name: manifest.id,
        description: manifest.description.split('\n')[0].slice(0, 120),
        parameters: { type: 'object', properties: {} },
      };
    });
  }

  // ── Inspection ──

  get v2Size(): number {
    return this.#defs.size;
  }

  get expandedCount(): number {
    return this.#expandedToolIds.size;
  }

  listV2Ids(): string[] {
    return [...this.#defs.keys()];
  }
}

export default UnifiedToolCatalog;
