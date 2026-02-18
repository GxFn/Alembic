/**
 * AutoSnippet V2 MCP Server
 *
 * Model Context Protocol (stdio transport)
 * 提供给 IDE AI Agent (Cursor/VSCode Copilot) 的工具集
 * 38 工具，全部基于 V2 服务层，不依赖 V1
 * Gateway 权限 gating: 写操作经过 Gateway 权限/宪法/审计检查
 *
 * 本文件仅包含服务编排层（初始化、路由、Gateway gating、生命周期）。
 * 工具定义 → tools.js
 * Handler 实现 → handlers/*.js
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { envelope } from './envelope.js';
import { TOOLS, TOOL_GATEWAY_MAP } from './tools.js';
import { wrapHandler } from './errorHandler.js';

// ─── Handler 模块 ─────────────────────────────────────────────

import * as systemHandlers from './handlers/system.js';
import * as searchHandlers from './handlers/search.js';
import * as browseHandlers from './handlers/browse.js';
import * as structureHandlers from './handlers/structure.js';
import * as candidateHandlers from './handlers/candidate.js';
import * as guardHandlers from './handlers/guard.js';
import * as bootstrapHandlers from './handlers/bootstrap.js';
import * as skillHandlers from './handlers/skill.js';
import * as knowledgeHandlers from './handlers/knowledge.js';

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
        projectRoot,
      });

      // 注册 Gateway action handlers
      const { registerGatewayActions } = await import('../../core/gateway/GatewayActionRegistry.js');
      const gateway = this.container.get('gateway');
      if (gateway) {
        registerGatewayActions(gateway, this.container);
      }
    }

    this.server = new Server(
      { name: 'autosnippet-v2', version: '2.0.0' },
      { capabilities: { tools: {} } },
    );

    this._registerHandlers();
    return this;
  }

  _registerHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const t0 = Date.now();
      try {
        const result = await this._handleToolCall(name, args || {});
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
      } catch (err) {
        this.logger.error(`MCP tool error: ${name}`, { error: err.message });
        const env = envelope({ success: false, message: err.message, errorCode: 'TOOL_ERROR', meta: { tool: name, responseTimeMs: Date.now() - t0 } });
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
    if (!handler) throw new Error(`Unknown tool: ${name}`);

    const wrapped = wrapHandler(name, handler);
    return wrapped(ctx, args);
  }

  /**
   * 解析工具名到 handler 函数
   * @private
   */
  _resolveHandler(name) {
    const HANDLER_MAP = {
      // 系统
      autosnippet_health:              (ctx) => systemHandlers.health(ctx),
      autosnippet_capabilities:        () => systemHandlers.capabilities(),
      // 搜索
      autosnippet_search:              (ctx, args) => searchHandlers.search(ctx, args),
      autosnippet_context_search:      (ctx, args) => searchHandlers.contextSearch(ctx, args),
      autosnippet_keyword_search:      (ctx, args) => searchHandlers.keywordSearch(ctx, args),
      autosnippet_semantic_search:     (ctx, args) => searchHandlers.semanticSearch(ctx, args),
      // 知识浏览
      autosnippet_list_rules:          (ctx, args) => browseHandlers.listByKind(ctx, 'rule', args),
      autosnippet_list_patterns:       (ctx, args) => browseHandlers.listByKind(ctx, 'pattern', args),
      autosnippet_list_facts:          (ctx, args) => browseHandlers.listByKind(ctx, 'fact', args),
      autosnippet_list_recipes:        (ctx, args) => browseHandlers.listRecipes(ctx, args),
      autosnippet_get_recipe:          (ctx, args) => browseHandlers.getRecipe(ctx, args),
      autosnippet_recipe_insights:     (ctx, args) => browseHandlers.recipeInsights(ctx, args),
      autosnippet_confirm_usage:       (ctx, args) => browseHandlers.confirmUsage(ctx, args),
      // 项目结构 & 图谱
      autosnippet_get_targets:         (ctx) => structureHandlers.getTargets(ctx),
      autosnippet_get_target_files:    (ctx, args) => structureHandlers.getTargetFiles(ctx, args),
      autosnippet_get_target_metadata: (ctx, args) => structureHandlers.getTargetMetadata(ctx, args),
      autosnippet_graph_query:         (ctx, args) => structureHandlers.graphQuery(ctx, args),
      autosnippet_graph_impact:        (ctx, args) => structureHandlers.graphImpact(ctx, args),
      autosnippet_graph_path:          (ctx, args) => structureHandlers.graphPath(ctx, args),
      autosnippet_graph_stats:         (ctx) => structureHandlers.graphStats(ctx),
      // 候选校验 & AI 补全
      autosnippet_validate_candidate:  (ctx, args) => candidateHandlers.validateCandidate(ctx, args),
      autosnippet_check_duplicate:     (ctx, args) => candidateHandlers.checkDuplicate(ctx, args),
      autosnippet_enrich_candidates:   (ctx, args) => candidateHandlers.enrichCandidates(ctx, args),
      // Guard & 扫描
      autosnippet_guard_check:         (ctx, args) => guardHandlers.guardCheck(ctx, args),
      autosnippet_guard_audit_files:   (ctx, args) => guardHandlers.guardAuditFiles(ctx, args),
      autosnippet_scan_project:        (ctx, args) => guardHandlers.scanProject(ctx, args),
      // Bootstrap 冷启动
      autosnippet_bootstrap_knowledge: (ctx, args) => bootstrapHandlers.bootstrapKnowledge(ctx, args),
      autosnippet_bootstrap_refine:    (ctx, args) => bootstrapHandlers.bootstrapRefine(ctx, args),
      // Skills
      autosnippet_list_skills:         () => skillHandlers.listSkills(),
      autosnippet_load_skill:          (ctx, args) => skillHandlers.loadSkill(ctx, args),
      autosnippet_create_skill:        (ctx, args) => skillHandlers.createSkill(ctx, args),
      autosnippet_delete_skill:        (ctx, args) => skillHandlers.deleteSkill(ctx, args),
      autosnippet_update_skill:        (ctx, args) => skillHandlers.updateSkill(ctx, args),
      autosnippet_suggest_skills:      (ctx) => skillHandlers.suggestSkills(ctx),
      // V3 知识条目
      autosnippet_submit_knowledge:       (ctx, args) => knowledgeHandlers.submitKnowledge(ctx, args),
      autosnippet_submit_knowledge_batch: (ctx, args) => knowledgeHandlers.submitKnowledgeBatch(ctx, args),
      autosnippet_knowledge_lifecycle:    (ctx, args) => knowledgeHandlers.knowledgeLifecycle(ctx, args),
      autosnippet_save_document:          (ctx, args) => knowledgeHandlers.saveDocument(ctx, args),
    };
    return HANDLER_MAP[name] || null;
  }

  /**
   * Gateway 权限 gating — 写操作验证权限/宪法/审计
   * 只读工具直接跳过（不在 TOOL_GATEWAY_MAP 中）
   */
  async _gatewayGate(toolName, args) {
    const mapping = TOOL_GATEWAY_MAP[toolName];
    if (!mapping) return; // 只读工具，跳过

    try {
      const gateway = this.container.get('gateway');
      if (!gateway) return; // Gateway 未初始化，降级放行

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
      if (err.message?.startsWith('[PERMISSION_DENIED]') || err.message?.startsWith('[CONSTITUTION_VIOLATION]')) {
        throw err;
      }
      // Gateway 内部故障不应阻断业务（降级放行 + 记录）
      this.logger.error(`MCP Gateway gating error (degraded): ${toolName}`, { error: err.message });
    }
  }

  // ─── Lifecycle ────────────────────────────────────────

  async start() {
    await this.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('MCP Server started (stdio) — 38 tools');
    // 在 stderr 写一行简洁的就绪通知（不使用 winston，仅用于 Cursor 日志面板 & 调试）
    process.stderr.write('AutoSnippet MCP ready — 38 tools\n');
  }

  async shutdown() {
    if (this.server) await this.server.close();
    if (this.bootstrap) await this.bootstrap.shutdown();
  }
}

export async function startMcpServer() {
  const server = new McpServer();
  await server.start();
  return server;
}

export default McpServer;
