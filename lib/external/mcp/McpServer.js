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
    switch (name) {
      // 系统
      case 'autosnippet_health':            return systemHandlers.health(ctx);
      case 'autosnippet_capabilities':      return systemHandlers.capabilities();
      // 搜索
      case 'autosnippet_search':            return searchHandlers.search(ctx, args);
      case 'autosnippet_context_search':    return searchHandlers.contextSearch(ctx, args);
      case 'autosnippet_keyword_search':    return searchHandlers.keywordSearch(ctx, args);
      case 'autosnippet_semantic_search':   return searchHandlers.semanticSearch(ctx, args);
      // 知识浏览
      case 'autosnippet_list_rules':        return browseHandlers.listByKind(ctx, 'rule', args);
      case 'autosnippet_list_patterns':     return browseHandlers.listByKind(ctx, 'pattern', args);
      case 'autosnippet_list_facts':        return browseHandlers.listByKind(ctx, 'fact', args);
      case 'autosnippet_list_recipes':      return browseHandlers.listRecipes(ctx, args);
      case 'autosnippet_get_recipe':        return browseHandlers.getRecipe(ctx, args);
      case 'autosnippet_recipe_insights':   return browseHandlers.recipeInsights(ctx, args);
      case 'autosnippet_confirm_usage':     return browseHandlers.confirmUsage(ctx, args);
      // 项目结构 & 图谱
      case 'autosnippet_get_targets':       return structureHandlers.getTargets(ctx);
      case 'autosnippet_get_target_files':  return structureHandlers.getTargetFiles(ctx, args);
      case 'autosnippet_get_target_metadata': return structureHandlers.getTargetMetadata(ctx, args);
      case 'autosnippet_graph_query':       return structureHandlers.graphQuery(ctx, args);
      case 'autosnippet_graph_impact':      return structureHandlers.graphImpact(ctx, args);
      case 'autosnippet_graph_path':        return structureHandlers.graphPath(ctx, args);
      case 'autosnippet_graph_stats':       return structureHandlers.graphStats(ctx);
      // 候选校验 & AI 补全（提交已移至 V3 knowledge handlers）
      case 'autosnippet_validate_candidate':  return candidateHandlers.validateCandidate(ctx, args);
      case 'autosnippet_check_duplicate':   return candidateHandlers.checkDuplicate(ctx, args);
      case 'autosnippet_enrich_candidates': return candidateHandlers.enrichCandidates(ctx, args);
      // Guard & 扫描
      case 'autosnippet_guard_check':       return guardHandlers.guardCheck(ctx, args);
      case 'autosnippet_guard_audit_files': return guardHandlers.guardAuditFiles(ctx, args);
      case 'autosnippet_scan_project':      return guardHandlers.scanProject(ctx, args);
      // Bootstrap 冷启动
      case 'autosnippet_bootstrap_knowledge': return bootstrapHandlers.bootstrapKnowledge(ctx, args);
      case 'autosnippet_bootstrap_refine':    return bootstrapHandlers.bootstrapRefine(ctx, args);
      // Skills 加载 & 创建 & 管理 & 推荐
      case 'autosnippet_list_skills':         return skillHandlers.listSkills();
      case 'autosnippet_load_skill':          return skillHandlers.loadSkill(ctx, args);
      case 'autosnippet_create_skill':        return skillHandlers.createSkill(ctx, args);
      case 'autosnippet_delete_skill':        return skillHandlers.deleteSkill(ctx, args);
      case 'autosnippet_update_skill':        return skillHandlers.updateSkill(ctx, args);
      case 'autosnippet_suggest_skills':      return skillHandlers.suggestSkills(ctx);
      // V3 知识条目
      case 'autosnippet_submit_knowledge':        return knowledgeHandlers.submitKnowledge(ctx, args);
      case 'autosnippet_submit_knowledge_batch':  return knowledgeHandlers.submitKnowledgeBatch(ctx, args);
      case 'autosnippet_knowledge_lifecycle':      return knowledgeHandlers.knowledgeLifecycle(ctx, args);
      case 'autosnippet_save_document':            return knowledgeHandlers.saveDocument(ctx, args);
      default: throw new Error(`Unknown tool: ${name}`);
    }
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
