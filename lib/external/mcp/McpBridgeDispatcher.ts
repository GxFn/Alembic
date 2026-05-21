/**
 * MCP Bridge Dispatcher
 *
 * Alembic daemon 的 HTTP bridge 只负责把 Plugin 传入的 MCP tool call
 * 转进本仓库真实 handler。这里复用 MCP schema 校验、handler 错误封装和
 * task session 状态，不做静态 mock，也不复制 Plugin runtime 的 stdio server。
 */

import { CapabilityProbe } from '@alembic/core/core/capability/CapabilityProbe';
import Logger from '@alembic/core/logging';
import { envelope } from './envelope.js';
import { wrapHandler } from './errorHandler.js';
import * as candidateHandlers from './handlers/candidate.js';
import { consolidateHandler } from './handlers/consolidate.js';
import * as consolidated from './handlers/consolidated.js';
import * as knowledgeHandlers from './handlers/knowledge.js';
import { panoramaHandler } from './handlers/panorama.js';
import * as systemHandlers from './handlers/system.js';
import { taskHandler } from './handlers/task.js';
import type { McpContext, McpServiceContainer } from './handlers/types.js';
import { createIdleIntent } from './handlers/types.js';
import { TOOL_GATEWAY_MAP } from './tools.js';

export interface McpBridgeCallOptions {
  actor?: {
    role?: string;
    user?: string;
    sessionId?: string;
  };
  source?: {
    kind: string;
    name: string;
  };
  surface?: string;
}

export interface McpBridgeToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type ToolHandlerFn = (ctx: McpContext, args: Record<string, unknown>) => Promise<unknown> | unknown;

interface GatewayStaticMapping {
  action: string;
  resource?: string;
}

interface GatewayMappingEntry {
  action?: string;
  resource?: string;
  resolver?: (args: Record<string, unknown>) => GatewayStaticMapping | null;
}

/**
 * HTTP bridge 需要保留同一 daemon 进程内的 intent session，否则 prime/create/close
 * 之间会失去上下文。它不持有 HTTP 请求对象，只持有 MCP 语义会话。
 */
export class McpBridgeDispatcher {
  readonly #container: McpServiceContainer;
  readonly #logger: ReturnType<typeof Logger.getInstance>;
  readonly #startedAt = Date.now();
  #capabilityProbe: CapabilityProbe | null = null;
  readonly #session = {
    id: `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: Date.now(),
    toolCallCount: 0,
    toolsUsed: new Set<string>(),
    lastActivityAt: Date.now(),
    intent: createIdleIntent(),
  };

  constructor(container: McpServiceContainer) {
    this.#container = container;
    this.#logger = Logger.getInstance();
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpBridgeCallOptions = {}
  ): Promise<McpBridgeToolResult> {
    const t0 = Date.now();
    try {
      const result = await this.#executeHandler(name, args, options);
      return this.#toToolResult(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.#logger.error(`[MCP bridge] tool error: ${name}`, { error: message });
      const env = envelope({
        success: false,
        message,
        errorCode: 'TOOL_ERROR',
        meta: { tool: name, responseTimeMs: Date.now() - t0 },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(env, null, 2) }],
        isError: true,
      };
    }
  }

  async #executeHandler(
    name: string,
    args: Record<string, unknown>,
    options: McpBridgeCallOptions
  ): Promise<unknown> {
    const handler = this.#resolveHandler(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const ctx: McpContext = {
      container: this.#container,
      logger: this.#logger,
      startedAt: this.#startedAt,
      session: this.#session,
      actor: {
        role: options.actor?.role || this.#resolveActorRole(),
        user: options.actor?.user || process.env.USER || undefined,
        sessionId: options.actor?.sessionId || this.#session.id,
      },
      source: options.source || { kind: 'http', name: '/api/v1/mcp/call' },
      surface: options.surface || 'codex',
      gateway: this.#resolveGatewayMapping(name, args),
    };

    const wrapped = wrapHandler(name, handler as Parameters<typeof wrapHandler>[1]);
    const result = await wrapped(ctx, args);
    this.#trackSession(name);
    return result;
  }

  #trackSession(toolName: string): void {
    this.#session.toolCallCount++;
    this.#session.toolsUsed.add(toolName);
    this.#session.lastActivityAt = Date.now();
  }

  #toToolResult(result: unknown): McpBridgeToolResult {
    if (
      result &&
      typeof result === 'object' &&
      Array.isArray((result as { content?: unknown }).content)
    ) {
      return result as McpBridgeToolResult;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: isErrorEnvelope(result) ? true : undefined,
    };
  }

  #resolveHandler(name: string): ToolHandlerFn | null {
    const handlers: Record<string, ToolHandlerFn> = {
      alembic_health: (ctx) => systemHandlers.health(ctx),
      alembic_search: (ctx, args) =>
        consolidated.consolidatedSearch(
          ctx,
          args as Parameters<typeof consolidated.consolidatedSearch>[1]
        ),
      alembic_knowledge: (ctx, args) => consolidated.consolidatedKnowledge(ctx, args),
      alembic_structure: (ctx, args) => consolidated.consolidatedStructure(ctx, args),
      alembic_call_context: (ctx, args) => consolidated.consolidatedCallContext(ctx, args),
      alembic_graph: (ctx, args) => consolidated.consolidatedGraph(ctx, args),
      alembic_guard: (ctx, args) => consolidated.consolidatedGuard(ctx, args),
      alembic_submit_knowledge: (ctx, args) => consolidated.enhancedSubmitKnowledge(ctx, args),
      alembic_skill: (ctx, args) => consolidated.consolidatedSkill(ctx, args),
      alembic_task: (ctx, args) => taskHandler(ctx, args),
      alembic_panorama: (ctx, args) => panoramaHandler(ctx, args),
      alembic_consolidate: (ctx, args) =>
        consolidateHandler(
          ctx as Parameters<typeof consolidateHandler>[0],
          args as Parameters<typeof consolidateHandler>[1]
        ),
      alembic_enrich_candidates: (ctx, args) => candidateHandlers.enrichCandidates(ctx, args),
      alembic_knowledge_lifecycle: (ctx, args) => knowledgeHandlers.knowledgeLifecycle(ctx, args),
    };
    return handlers[name] ?? null;
  }

  #resolveGatewayMapping(toolName: string, args: Record<string, unknown>) {
    let mapping = (TOOL_GATEWAY_MAP as Record<string, GatewayMappingEntry | undefined>)[toolName];
    if (!mapping) {
      return null;
    }
    if (typeof mapping.resolver === 'function') {
      mapping = mapping.resolver(args) ?? undefined;
    }
    return mapping?.action ? { action: mapping.action, resource: mapping.resource } : null;
  }

  #resolveActorRole(): string {
    try {
      return this.#getCapabilityProbe().probeRole();
    } catch {
      return 'external_agent';
    }
  }

  #getCapabilityProbe(): CapabilityProbe {
    if (!this.#capabilityProbe) {
      try {
        const constitution = this.#container.get('constitution');
        const caps = constitution?.config?.capabilities?.git_write || {};
        this.#capabilityProbe = new CapabilityProbe({
          cacheTTL: caps.cache_ttl || 86400,
          noRemote: caps.no_remote || 'allow',
        });
      } catch {
        this.#capabilityProbe = new CapabilityProbe();
      }
    }
    return this.#capabilityProbe;
  }
}

function isErrorEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as { errorCode?: unknown; ok?: unknown; success?: unknown };
  return record.ok === false || record.success === false || Boolean(record.errorCode);
}
