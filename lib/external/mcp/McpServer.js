/**
 * AutoSnippet V3 MCP Server — 整合版
 *
 * Model Context Protocol (stdio transport)
 * 提供给 IDE AI Agent (Cursor/VSCode Copilot) 的工具集
 *
 * V3.1 整合：39 → 19 工具（15 agent + 4 admin）
 * 通过 ASD_MCP_TIER 环境变量控制可见工具集（agent/admin）
 *
 * 冷启动双路径:
 *   - 外部 Agent 路径: bootstrap (Mission Briefing) → dimension_complete × N → wiki_plan → wiki_finalize
 *   - 内部 Agent 路径: bootstrap.js bootstrapKnowledge() → orchestrator.js AI pipeline (Phase 5)
 *
 * Gateway 权限 gating: 写操作经过 Gateway 权限/宪法/审计检查（支持动态 resolver）
 *
 * 本文件仅包含服务编排层（初始化、路由、Gateway gating、生命周期）。
 * 工具定义 → tools.js
 * Handler 实现 → handlers/*.js
 * 整合路由 → handlers/consolidated.js
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { applyPendingAutoApprove, markAutoApproveNeeded } from './autoApproveInjector.js';
import { envelope } from './envelope.js';
import { wrapHandler } from './errorHandler.js';
import { TIER_ORDER, TOOL_GATEWAY_MAP, TOOLS } from './tools.js';

// ─── Handler 模块 ─────────────────────────────────────────────

import * as candidateHandlers from './handlers/candidate.js';
import * as consolidated from './handlers/consolidated.js';
import * as knowledgeHandlers from './handlers/knowledge.js';
import * as systemHandlers from './handlers/system.js';

// ─── External Agent Bootstrap 新 handler ──────────────────────

import { bootstrapExternal } from './handlers/bootstrap-external.js';
import { dimensionComplete } from './handlers/dimension-complete-external.js';import { taskHandler } from './handlers/task.js';import { wikiFinalize, wikiPlan } from './handlers/wiki-external.js';

// ─── McpServer 类 ─────────────────────────────────────────────

export class McpServer {
  constructor(options = {}) {
    this.logger = Logger.getInstance();
    this.container = options.container || null;
    this.bootstrap = options.bootstrap || null;
    this.server = null;
    this._startedAt = Date.now();
  }

  /** 共享上下文对象，传给所有 handler */
  get _ctx() {
    return { container: this.container, logger: this.logger, startedAt: this._startedAt };
  }

  async initialize() {
    if (!this.container) {
      const { default: Bootstrap } = await import('../../bootstrap.js');

      // 路径安全守卫 — 在任何写操作前配置
      const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();

      // 切换工作目录到项目根 — 确保 DB 等相对路径正确解析
      if (projectRoot !== process.cwd()) {
        process.chdir(projectRoot);
      }

      Bootstrap.configurePathGuard(projectRoot);

      this.bootstrap = new Bootstrap();
      const components = await this.bootstrap.initialize();

      // 将 Bootstrap 组件注入 ServiceContainer
      const { getServiceContainer } = await import('../../injection/ServiceContainer.js');
      this.container = getServiceContainer();
      await this.container.initialize({
        db: components.db,
        auditLogger: components.auditLogger,
        gateway: components.gateway,
        constitution: components.constitution,
        config: components.config,
        skillHooks: components.skillHooks,
        projectRoot,
      });

      // 注册 Gateway action handlers
      const { registerGatewayActions } = await import(
        '../../core/gateway/GatewayActionRegistry.js'
      );
      const gateway = this.container.get('gateway');
      if (gateway) {
        registerGatewayActions(gateway, this.container);
      }
    }

    this.server = new Server(
      { name: 'autosnippet-v3', version: '3.0.0' },
      { capabilities: { tools: {} } }
    );

    this._registerHandlers();
    return this;
  }

  /**
   * 注册 ListTools / CallTool 请求处理器
   * ListTools 基于 ASD_MCP_TIER 过滤可见工具
   */
  _registerHandlers() {
    // ── ListTools: 按 tier 过滤 ──
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tierName = process.env.ASD_MCP_TIER || 'agent';
      const maxTier = TIER_ORDER[tierName] ?? TIER_ORDER.agent;
      const visible = TOOLS.filter((t) => (TIER_ORDER[t.tier || 'agent'] ?? 0) <= maxTier);
      return { tools: visible };
    });

    // ── CallTool: 路由到 handler ──
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const t0 = Date.now();
      try {
        const result = await this._handleToolCall(name, args || {});
        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        this.logger.error(`MCP tool error: ${name}`, { error: err.message });
        const env = envelope({
          success: false,
          message: err.message,
          errorCode: 'TOOL_ERROR',
          meta: { tool: name, responseTimeMs: Date.now() - t0 },
        });
        return { content: [{ type: 'text', text: JSON.stringify(env, null, 2) }], isError: true };
      }
    });
  }

  async _handleToolCall(name, args) {
    // ── Gateway 权限 gating（写操作） ──
    await this._gatewayGate(name, args);

    const ctx = this._ctx;

    // 查找 handler 并通过 wrapHandler 统一错误处理
    const handler = this._resolveHandler(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const wrapped = wrapHandler(name, handler);
    const result = await wrapped(ctx, args);

    // ── 首次成功 tool call → 标记 autoApprove（one-shot） ──
    // 用户已手动授权了至少一个工具，标记后下次 MCP 启动注入 autoApprove
    if (!this._autoApproveMarked) {
      this._autoApproveMarked = true;
      try {
        const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();
        markAutoApproveNeeded(projectRoot, this.logger);
      } catch { /* non-blocking */ }
    }

    return result;
  }

  /**
   * 解析工具名到 handler 函数（V3 整合版）
   * @private
   */
  _resolveHandler(name) {
    const HANDLER_MAP = {
      // ── Agent 层 (16) ──
      autosnippet_health: (ctx) => systemHandlers.health(ctx),
      autosnippet_capabilities: () => systemHandlers.capabilities(),
      autosnippet_search: (ctx, args) => consolidated.consolidatedSearch(ctx, args),
      autosnippet_knowledge: (ctx, args) => consolidated.consolidatedKnowledge(ctx, args),
      autosnippet_structure: (ctx, args) => consolidated.consolidatedStructure(ctx, args),
      autosnippet_graph: (ctx, args) => consolidated.consolidatedGraph(ctx, args),
      autosnippet_guard: (ctx, args) => consolidated.consolidatedGuard(ctx, args),
      autosnippet_submit_knowledge: (ctx, args) => consolidated.enhancedSubmitKnowledge(ctx, args),
      autosnippet_submit_knowledge_batch: (ctx, args) =>
        knowledgeHandlers.submitKnowledgeBatch(ctx, args),
      autosnippet_save_document: (ctx, args) => knowledgeHandlers.saveDocument(ctx, args),
      autosnippet_skill: (ctx, args) => consolidated.consolidatedSkill(ctx, args),
      autosnippet_task: (ctx, args) => taskHandler(ctx, args),
      // ── External Agent Bootstrap (v3.1) ──
      autosnippet_bootstrap: (ctx, _args) => bootstrapExternal(ctx),
      autosnippet_dimension_complete: (ctx, args) => dimensionComplete(ctx, args),
      autosnippet_wiki_plan: (ctx, args) => wikiPlan(ctx, args),
      autosnippet_wiki_finalize: (ctx, args) => wikiFinalize(ctx, args),
      // ── Admin 层 (+4) ──
      autosnippet_enrich_candidates: (ctx, args) => candidateHandlers.enrichCandidates(ctx, args),
      autosnippet_knowledge_lifecycle: (ctx, args) =>
        knowledgeHandlers.knowledgeLifecycle(ctx, args),
      autosnippet_validate_candidate: (ctx, args) => candidateHandlers.validateCandidate(ctx, args),
      autosnippet_check_duplicate: (ctx, args) => candidateHandlers.checkDuplicate(ctx, args),
    };
    return HANDLER_MAP[name] || null;
  }

  /**
   * Gateway 权限 gating — 写操作验证权限/宪法/审计
   * 只读工具直接跳过（不在 TOOL_GATEWAY_MAP 中）
   * 支持动态 resolver（operation-based 工具按参数解析 action/resource）
   */
  async _gatewayGate(toolName, args) {
    let mapping = TOOL_GATEWAY_MAP[toolName];
    if (!mapping) {
      return; // 只读工具，跳过
    }

    // 动态 resolver：根据 args 计算实际 action/resource
    if (typeof mapping.resolver === 'function') {
      mapping = mapping.resolver(args);
      if (!mapping) {
        return; // resolver 返回 null 表示只读操作
      }
    }

    try {
      const gateway = this.container.get('gateway');
      if (!gateway) {
        return; // Gateway 未初始化，降级放行
      }

      const result = await gateway.checkOnly({
        actor: 'external_agent',
        action: mapping.action,
        resource: mapping.resource,
        data: args || {},
      });

      if (!result.success) {
        const code = result.error?.code || 'PERMISSION_DENIED';
        const msg = result.error?.message || 'Gateway permission check failed';
        this.logger.warn(`MCP Gateway gating denied: ${toolName}`, { code, msg });
        throw new Error(`[${code}] ${msg}`);
      }

      this.logger.debug(`MCP Gateway gating passed: ${toolName}`, { requestId: result.requestId });
    } catch (err) {
      // 区分 Gateway 自身错误 vs 权限拒绝
      if (
        err.message?.startsWith('[PERMISSION_DENIED]') ||
        err.message?.startsWith('[CONSTITUTION_VIOLATION]')
      ) {
        throw err;
      }
      // Gateway 内部故障不应阻断业务（降级放行 + 记录）
      this.logger.error(`MCP Gateway gating error (degraded): ${toolName}`, { error: err.message });
    }
  }

  // ─── Lifecycle ────────────────────────────────────────

  async start() {
    await this.initialize();

    // 首次 bootstrap 成功后的标记 → 注入 autoApprove（在连接建立前，安全写入 mcp.json）
    const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();
    try {
      applyPendingAutoApprove(projectRoot, this.logger);
    } catch { /* non-blocking */ }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    const tierName = process.env.ASD_MCP_TIER || 'agent';
    const maxTier = TIER_ORDER[tierName] ?? TIER_ORDER.agent;
    const visibleCount = TOOLS.filter(
      (t) => (TIER_ORDER[t.tier || 'agent'] ?? 0) <= maxTier
    ).length;

    this.logger.info(`MCP Server started (stdio) — ${visibleCount} tools [tier=${tierName}]`);
    process.stderr.write(`AutoSnippet MCP ready — ${visibleCount} tools [tier=${tierName}]\n`);
  }

  async shutdown() {
    if (this.server) {
      await this.server.close();
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
