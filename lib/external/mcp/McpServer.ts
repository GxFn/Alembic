/**
 * Alembic V3 MCP Server — 整合版
 *
 * Model Context Protocol (stdio transport)
 * 提供给 IDE AI Agent (Cursor/VSCode Copilot) 的工具集
 *
 * V3.3 整合：39 → 16 工具（14 agent + 2 admin）
 * 通过 ALEMBIC_MCP_TIER 环境变量控制可见工具集（agent/admin）
 *
 * 冷启动双路径:
 *   - 外部 Agent 路径: bootstrap (Mission Briefing) → dimension_complete × N → wiki(plan) → wiki(finalize)
 *   - 内部 Agent 路径: bootstrap.js bootstrapKnowledge() → orchestrator.js AI pipeline (Phase 5)
 *
 * Gateway 权限 gating: 写操作经过 Gateway 权限/宪法/审计检查（支持动态 resolver）
 *
 * 本文件仅包含服务编排层（初始化、路由、Gateway gating、生命周期）。
 * 工具定义 → tools.js
 * Handler 实现 → handlers/*.js
 * 整合路由 → handlers/consolidated.js
 */

import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CapabilityProbe } from '#core/capability/CapabilityProbe.js';
import Logger from '#infra/logging/Logger.js';
import { CapabilityCatalog } from '#tools/catalog/CapabilityCatalog.js';
import type { ToolRouterContract } from '#tools/core/ToolContracts.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
import { ToolRouter } from '#tools/core/ToolRouter.js';
import { applyPendingAutoApprove, markAutoApproveNeeded } from './autoApproveInjector.js';
import { envelope } from './envelope.js';
import { wrapHandler } from './errorHandler.js';
import type { IntentState, McpContext, McpServiceContainer } from './handlers/types.js';
import { createIdleIntent } from './handlers/types.js';
import { buildMcpToolCapabilities } from './McpCapabilityProjection.js';
import { McpToolAdapter } from './McpToolAdapter.js';
import { TIER_ORDER, TOOL_GATEWAY_MAP, TOOLS } from './tools.js';

// ─── TypeScript Interfaces ──────────────────────────────────

/** MCP session tracking (with intent lifecycle) */
interface McpSession {
  id: string;
  startedAt: number;
  toolCallCount: number;
  toolsUsed: Set<string>;
  lastActivityAt: number;
  intent: IntentState;
}

/** McpServer constructor options */
interface McpServerOptions {
  container?: McpServiceContainer | null;
  bootstrap?: BootstrapLike | null;
}

/** Bootstrap instance minimal shape */
interface BootstrapLike {
  initialize(): Promise<Record<string, unknown>>;
  shutdown(): Promise<void>;
}

/** Tool handler function (sync or async, compatible with wrapHandler) */
type ToolHandlerFn = (ctx: McpContext, args: Record<string, unknown>) => Promise<unknown> | unknown;

/** Gateway static mapping */
interface GatewayStaticMapping {
  action: string;
  resource: string;
}

/** Gateway mapping entry — static or with dynamic resolver */
interface GatewayMappingEntry {
  action?: string;
  resource?: string;
  resolver?: (args: Record<string, unknown>) => GatewayStaticMapping | null;
}

// ─── Handler 模块 ─────────────────────────────────────────────

import * as candidateHandlers from './handlers/candidate.js';
import * as consolidated from './handlers/consolidated.js';
import * as knowledgeHandlers from './handlers/knowledge.js';
import * as systemHandlers from './handlers/system.js';

// ─── External Agent Bootstrap 新 handler ──────────────────────

import { bootstrapExternal } from './handlers/bootstrap-external.js';
import { consolidateHandler } from './handlers/consolidate.js';
import { dimensionComplete } from './handlers/dimension-complete-external.js';
import { evolveExternal } from './handlers/evolve-external.js';
import { panoramaHandler } from './handlers/panorama.js';
import { rescanExternal } from './handlers/rescan-external.js';
import { taskHandler } from './handlers/task.js';
import { wikiRouter } from './handlers/wiki-external.js';

// ─── McpServer 类 ─────────────────────────────────────────────

export class McpServer {
  container: McpServiceContainer | null;
  logger: ReturnType<typeof Logger.getInstance> | null;
  _autoApproveMarked: boolean;
  _capabilityProbe: CapabilityProbe | null;
  _lastTaskOperation: string;
  _toolRouter: ToolRouterContract | null;
  _session: McpSession;
  _startedAt: number;
  bootstrap: BootstrapLike | null;
  sdkServer: SdkMcpServer | null;
  constructor(options: McpServerOptions = {}) {
    // Logger 延迟到 initialize() 之后获取，避免在 Bootstrap 之前触发单例初始化
    this.logger = null;
    this.container = options.container || null;
    this.bootstrap = options.bootstrap || null;
    this.sdkServer = null;
    this._startedAt = Date.now();
    this._autoApproveMarked = false;
    this._capabilityProbe = null;
    this._lastTaskOperation = '';
    this._toolRouter = null;

    // ── Session 管理 (with intent lifecycle) ──
    this._session = {
      id: `ses-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      startedAt: Date.now(),
      toolCallCount: 0,
      toolsUsed: new Set(),
      lastActivityAt: Date.now(),
      intent: createIdleIntent(),
    };
  }

  /** 共享上下文对象，传给所有 handler（仅在 initialize() 之后使用） */
  get _ctx() {
    return {
      container: this.container,
      logger: this.logger || Logger.getInstance(),
      startedAt: this._startedAt,
      session: this._session,
    };
  }

  async initialize() {
    if (!this.container) {
      const { default: Bootstrap } = await import('../../bootstrap.js');

      // MCP 模式必须显式指定项目目录 — process.cwd() 在多根工作区中不可靠
      const projectRoot = process.env.ALEMBIC_PROJECT_DIR;
      if (!projectRoot) {
        const msg =
          `[MCP] 缺少 ALEMBIC_PROJECT_DIR 环境变量。MCP server 拒绝启动。\n` +
          `在多根工作区中 process.cwd() 可能指向任意子目录，不能作为项目根目录。\n` +
          `请在 .vscode/mcp.json 的 env 中设置 ALEMBIC_PROJECT_DIR 为目标项目的绝对路径。`;
        process.stderr.write(`${msg}\n`);
        throw new Error(msg);
      }

      // ── 排除项目检查 — 防止误配置 ALEMBIC_PROJECT_DIR 到不该创建运行时数据的目录 ──
      // Ghost 模式下跳过排除检查（数据不写入项目目录）
      const { isExcludedProject } = await import('../../shared/isOwnDevRepo.js');
      const { ProjectRegistry } = await import('../../shared/ProjectRegistry.js');
      const isGhost = ProjectRegistry.isGhost(projectRoot);
      const exclusion = isExcludedProject(projectRoot);
      if (exclusion.excluded && !isGhost) {
        const msg =
          `[MCP] projectRoot "${projectRoot}" 是排除项目（${exclusion.reason}），` +
          `MCP server 拒绝在此目录创建运行时数据。\n` +
          `提示: 在 .vscode/mcp.json 的 env 中设置正确的 ALEMBIC_PROJECT_DIR。`;
        process.stderr.write(`${msg}\n`);
        throw new Error(msg);
      }

      // 切换工作目录到项目根 — 确保 DB 等相对路径正确解析
      if (projectRoot !== process.cwd()) {
        process.chdir(projectRoot);
      }

      Bootstrap.configurePathGuard(projectRoot);

      this.bootstrap = new Bootstrap();
      const components = await this.bootstrap.initialize();

      // 将 Bootstrap 组件注入 ServiceContainer
      const { getServiceContainer } = await import('#inject/ServiceContainer.js');
      this.container = getServiceContainer();
      await (
        this.container as unknown as { initialize(opts: Record<string, unknown>): Promise<void> }
      ).initialize({
        db: components.db,
        auditLogger: components.auditLogger,
        gateway: components.gateway,
        constitution: components.constitution,
        config: components.config,
        skillHooks: components.skillHooks,
        projectRoot,
        workspaceResolver: components.workspaceResolver,
      });

      // 注册 Gateway action handlers
      const { registerGatewayActions } = await import('#core/gateway/GatewayActionRegistry.js');
      const gateway = this.container.get('gateway');
      if (gateway) {
        registerGatewayActions(gateway, this.container);
      }
    }

    // Bootstrap 完成后获取 Logger 单例（此时已带 ghost 路径配置）
    this.logger = Logger.getInstance();

    this.sdkServer = new SdkMcpServer(
      { name: 'alembic-v3', version: '3.0.0' },
      { capabilities: { tools: {} } }
    );

    this._registerHandlers();
    return this;
  }

  /**
   * 注册 ListTools / CallTool 请求处理器
   * ListTools 基于 ALEMBIC_MCP_TIER 过滤可见工具
   */
  _registerHandlers() {
    if (!this.sdkServer) {
      throw new Error('MCP SDK server is not initialized');
    }
    const server = this.sdkServer.server;

    // ── ListTools: 按 tier 过滤 ──
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tierName = process.env.ALEMBIC_MCP_TIER || 'agent';
      const maxTier = (TIER_ORDER as Record<string, number>)[tierName] ?? TIER_ORDER.agent;
      const visible = TOOLS.filter(
        (t) => ((TIER_ORDER as Record<string, number>)[t.tier || 'agent'] ?? 0) <= maxTier
      );
      return { tools: visible };
    });

    // ── CallTool: 路由到 handler ──
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const t0 = Date.now();
      try {
        const result = await this._handleToolCall(name, args || {});
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: result.ok ? undefined : true,
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger?.error(`MCP tool error: ${name}`, { error: errMsg });
        const env = envelope({
          success: false,
          message: errMsg,
          errorCode: 'TOOL_ERROR',
          meta: { tool: name, responseTimeMs: Date.now() - t0 },
        });
        return { content: [{ type: 'text', text: JSON.stringify(env, null, 2) }], isError: true };
      }
    });
  }

  async _handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResultEnvelope> {
    const router = this._getToolRouter();
    const gatewayMapping = this._resolveMcpGatewayMapping(name, args);
    const actorRole = this._resolveMcpActorRole();
    return router.execute({
      toolId: name,
      args,
      surface: 'mcp',
      actor: {
        role: actorRole,
        user: process.env.USER || undefined,
        sessionId: this._session.id,
      },
      source: { kind: 'mcp', name: 'tools/call' },
      governance: gatewayMapping
        ? {
            gatewayAction: gatewayMapping.action,
            gatewayResource: gatewayMapping.resource,
            gatewayData: args || {},
          }
        : undefined,
    });
  }

  _getToolRouter() {
    if (!this._toolRouter) {
      const { manifests } = buildMcpToolCapabilities(TOOLS);
      const catalog = new CapabilityCatalog(manifests);
      this._toolRouter = new ToolRouter({
        catalog,
        adapters: [new McpToolAdapter((toolName, args) => this._executeMcpHandler(toolName, args))],
        projectRoot: process.env.ALEMBIC_PROJECT_DIR || process.cwd(),
        services: {
          get: <T = unknown>(serviceName: string) => {
            if (!this.container) {
              throw new Error(`Service '${serviceName}' is not available before MCP initialize()`);
            }
            return this.container.get(serviceName) as T;
          },
        },
      });
    }
    return this._toolRouter;
  }

  async _executeMcpHandler(name: string, args: Record<string, unknown>) {
    const ctx = this._ctx;

    // 查找 handler 并通过 wrapHandler 统一错误处理
    const handler = this._resolveHandler(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const wrapped = wrapHandler(name, handler as Parameters<typeof wrapHandler>[1]);

    // Track task operation for _injectDecisions
    if (name === 'alembic_task') {
      this._lastTaskOperation = (args.operation as string) || '';
    }

    const result = await wrapped(ctx, args);

    // ── Session 追踪 + 行为采集 ──
    this._trackSession(name, result);

    // ── [DEFERRED] Decision 注入（待 JSONL 数据验证后启用） ──
    // await this._injectDecisions(name, result);

    // ── 首次成功 tool call → 标记 autoApprove（one-shot） ──
    // 用户已手动授权了至少一个工具，标记后下次 MCP 启动注入 autoApprove
    if (!this._autoApproveMarked) {
      this._autoApproveMarked = true;
      try {
        const projectRoot = process.env.ALEMBIC_PROJECT_DIR || process.cwd();
        markAutoApproveNeeded(projectRoot, this.logger || undefined);
      } catch {
        /* non-blocking */
      }
    }

    return result;
  }

  // ─── Session tracking + behavior collection ─────────────

  /**
   * Post-tool-call hook: update session stats + intent behavior tracking.
   * Always called (non-blocking, synchronous).
   *
   * - Session stats: toolCallCount, toolsUsed, lastActivityAt
   * - Intent tracking (when active): toolCalls, searchQueries, mentionedFiles, drift detection
   */
  _trackSession(toolName: string, result: unknown): void {
    // ── Session stats (always) ──
    this._session.toolCallCount++;
    this._session.toolsUsed.add(toolName);
    this._session.lastActivityAt = Date.now();

    // Task handler manages IntentState internally — skip behavior tracking
    if (toolName === 'alembic_task') {
      return;
    }

    // ── Intent behavior tracking (active intent only) ──
    const intent = this._session.intent;
    if (intent.phase !== 'active') {
      return;
    }

    // Track tool call
    intent.toolCalls.push({
      tool: toolName,
      timestamp: Date.now(),
      args_summary: toolName,
    });

    // Auto-collect search queries
    if (toolName === 'alembic_search') {
      const query = this._extractSearchQuery(result);
      if (query) {
        intent.searchQueries.push(query);
      }
    }

    // Auto-collect mentioned files
    const files = this._extractMentionedFiles(toolName, result);
    for (const f of files) {
      if (!intent.mentionedFiles.includes(f)) {
        intent.mentionedFiles.push(f);
        const mod = this._inferModule(f);
        if (mod) {
          intent.mentionedModules.add(mod);
        }
      }
    }

    // Drift detection
    this._detectDrift(toolName, intent);
  }

  // ─── [DEFERRED] Decision injection ───────────────────────

  /**
   * Inject active decisions + intent context into tool results.
   * Currently deferred — enable by uncommenting the call in _handleToolCall.
   */
  async _injectDecisions(toolName: string, result: unknown) {
    if (toolName === 'alembic_task') {
      return result;
    }

    const intent = this._session.intent;
    if (intent.phase !== 'active') {
      return result;
    }

    if (intent.decisions.length > 0 && typeof result === 'object' && result !== null) {
      const resultObj = result as Record<string, unknown>;
      resultObj._activeDecisions = intent.decisions.map((d) => ({
        id: d.id,
        title: d.title,
      }));
      resultObj._intentContext =
        `Active intent: "${intent.primeQuery || '(no query)'}"` +
        (intent.taskId ? ` | Task: ${intent.taskId}` : '') +
        ` | ${intent.toolCalls.length} tool calls | ${intent.decisions.length} decision(s)`;
    }

    return result;
  }

  // ─── Drift detection helpers ───────────────────

  private _detectDrift(toolName: string, intent: IntentState): void {
    for (const mod of intent.mentionedModules) {
      if (intent.primeModule && mod !== intent.primeModule) {
        const alreadyDrifted = intent.driftEvents.some(
          (d) => d.type === 'new_module' && d.detail.includes(mod)
        );
        if (!alreadyDrifted) {
          intent.driftEvents.push({
            timestamp: Date.now(),
            trigger: toolName,
            type: 'new_module',
            detail: `New module: ${mod} (prime: ${intent.primeModule})`,
            primeOverlap: this._computeOverlap(mod, intent.primeQuery),
          });
        }
      }
    }
    if (toolName === 'alembic_search' && intent.searchQueries.length > 0) {
      const latestQuery = intent.searchQueries.at(-1);
      if (!latestQuery) {
        return;
      }
      const overlap = this._computeKeywordOverlap(latestQuery, intent.primeQuery);
      if (overlap < 0.3) {
        intent.driftEvents.push({
          timestamp: Date.now(),
          trigger: toolName,
          type: 'search_shift',
          detail: `Search drift: "${latestQuery.slice(0, 40)}" (overlap: ${Math.round(overlap * 100)}%)`,
          primeOverlap: overlap,
        });
      }
    }
  }

  private _computeKeywordOverlap(a: string, b: string): number {
    if (!a || !b) {
      return 0;
    }
    const tokensA = new Set(
      a
        .toLowerCase()
        .split(/[\s,./\\|]+/)
        .filter((t) => t.length > 1)
    );
    const tokensB = new Set(
      b
        .toLowerCase()
        .split(/[\s,./\\|]+/)
        .filter((t) => t.length > 1)
    );
    if (tokensA.size === 0 || tokensB.size === 0) {
      return 0;
    }
    let shared = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) {
        shared++;
      }
    }
    return shared / Math.max(tokensA.size, tokensB.size);
  }

  private _computeOverlap(term: string, query: string): number {
    if (!term || !query) {
      return 0;
    }
    return query.toLowerCase().includes(term.toLowerCase()) ? 1 : 0;
  }

  private _extractSearchQuery(result: unknown): string | null {
    if (typeof result === 'object' && result !== null) {
      const obj = result as Record<string, unknown>;
      if (typeof obj.query === 'string') {
        return obj.query;
      }
    }
    return null;
  }

  private _extractMentionedFiles(_toolName: string, result: unknown): string[] {
    if (typeof result === 'object' && result !== null) {
      const obj = result as Record<string, unknown>;
      const files = obj.files || obj.mentionedFiles;
      if (Array.isArray(files)) {
        return files.filter((f) => typeof f === 'string');
      }
    }
    return [];
  }

  private _inferModule(filePath: string): string | null {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const meaningful = parts.slice(1, -1).filter((p) => !['src', 'lib', 'Sources'].includes(p));
    return meaningful.slice(0, 2).join('/') || null;
  }

  /**
   * 解析工具名到 handler 函数（V3 整合版）
   */
  _resolveHandler(name: string): ToolHandlerFn | null {
    const HANDLER_MAP: Record<string, ToolHandlerFn> = {
      // ── Agent 层 ──
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
      // ── External Agent Bootstrap (v3.1) ──
      alembic_bootstrap: (ctx, _args) =>
        bootstrapExternal(ctx as Parameters<typeof bootstrapExternal>[0]),
      alembic_rescan: (ctx, args) =>
        rescanExternal(ctx as Parameters<typeof rescanExternal>[0], args),
      alembic_evolve: (ctx, args) =>
        evolveExternal(
          ctx as Parameters<typeof evolveExternal>[0],
          args as Parameters<typeof evolveExternal>[1]
        ),
      alembic_dimension_complete: (ctx, args) => dimensionComplete(ctx, args),
      alembic_consolidate: (ctx, args) =>
        consolidateHandler(
          ctx as Parameters<typeof consolidateHandler>[0],
          args as Parameters<typeof consolidateHandler>[1]
        ),
      alembic_wiki: (ctx, args) => wikiRouter(ctx, args),
      // ── Admin 层 (+4) ──
      alembic_enrich_candidates: (ctx, args) => candidateHandlers.enrichCandidates(ctx, args),
      alembic_knowledge_lifecycle: (ctx, args) => knowledgeHandlers.knowledgeLifecycle(ctx, args),
    };
    return HANDLER_MAP[name] ?? null;
  }

  /**
   * 获取（或懒创建）CapabilityProbe 实例，用于探测子仓库写权限
   * 配置来自 constitution capabilities.git_write
   */
  _getCapabilityProbe(): CapabilityProbe {
    if (!this._capabilityProbe) {
      try {
        const constitution = this.container?.get('constitution');
        const caps = constitution?.config?.capabilities?.git_write || {};
        this._capabilityProbe = new CapabilityProbe({
          cacheTTL: caps.cache_ttl || 86400,
          noRemote: caps.no_remote || 'allow',
        });
      } catch {
        this._capabilityProbe = new CapabilityProbe();
      }
    }
    return this._capabilityProbe;
  }

  _resolveMcpGatewayMapping(toolName: string, args: Record<string, unknown>) {
    let mapping = (TOOL_GATEWAY_MAP as Record<string, GatewayMappingEntry | undefined>)[toolName] as
      | GatewayMappingEntry
      | null
      | undefined;
    if (!mapping) {
      return null;
    }

    if (typeof mapping.resolver === 'function') {
      mapping = mapping.resolver(args);
      if (!mapping) {
        return null;
      }
    }

    if (!mapping.action) {
      return null;
    }
    return {
      action: mapping.action,
      resource: mapping.resource,
    };
  }

  _resolveMcpActorRole() {
    try {
      return this._getCapabilityProbe().probeRole();
    } catch {
      return 'external_agent';
    }
  }

  // ─── Lifecycle ────────────────────────────────────────

  async start() {
    await this.initialize();

    // 首次 bootstrap 成功后的标记 → 注入 autoApprove（在连接建立前，安全写入 mcp.json）
    const projectRoot = process.env.ALEMBIC_PROJECT_DIR || process.cwd();
    try {
      applyPendingAutoApprove(projectRoot, this.logger || undefined);
    } catch {
      /* non-blocking */
    }

    const transport = new StdioServerTransport();
    if (!this.sdkServer) {
      throw new Error('MCP SDK server is not initialized');
    }
    await this.sdkServer.connect(transport);

    const tierName = process.env.ALEMBIC_MCP_TIER || 'agent';
    const maxTier = (TIER_ORDER as Record<string, number>)[tierName] ?? TIER_ORDER.agent;
    const visibleCount = TOOLS.filter(
      (t) => ((TIER_ORDER as Record<string, number>)[t.tier || 'agent'] ?? 0) <= maxTier
    ).length;

    this.logger?.info(`MCP Server started (stdio) — ${visibleCount} tools [tier=${tierName}]`);
    process.stderr.write(`Alembic MCP ready — ${visibleCount} tools [tier=${tierName}]\n`);
  }

  async shutdown() {
    if (this.sdkServer) {
      await this.sdkServer.close();
    }
    if (this.bootstrap) {
      await this.bootstrap.shutdown();
    }
  }
}

export async function startMcpServer() {
  const server = new McpServer();
  await server.start();
  return server;
}

export default McpServer;
