/**
 * AgentModule — Agent 架构服务注册
 *
 * 负责注册:
 *   - agentService, toolRegistry, toolForge, skillHooks
 *   - feedbackStore, recommendationPipeline, recommendationMetrics
 */

import {
  AgentProfileCompiler,
  AgentProfileRegistry,
  AgentRunCoordinator,
  AgentRuntimeBuilder,
  AgentService,
  AgentStageFactoryRegistry,
  SystemRunContextFactory,
} from '#agent/service/index.js';
import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { DashboardOperationAdapter } from '#tools/adapters/DashboardOperationAdapter.js';
import {
  DASHBOARD_OPERATION_HANDLERS,
  DASHBOARD_OPERATION_MANIFESTS,
} from '#tools/adapters/DashboardOperations.js';
import { InternalToolAdapter } from '#tools/adapters/InternalToolAdapter.js';
import { MacSystemAdapter } from '#tools/adapters/MacSystemAdapter.js';
import { MAC_SYSTEM_CAPABILITY_MANIFESTS } from '#tools/adapters/MacSystemCapabilities.js';
import { SkillAdapter } from '#tools/adapters/SkillAdapter.js';
import { SKILL_CAPABILITY_MANIFESTS } from '#tools/adapters/SkillCapabilities.js';
import { TerminalAdapter } from '#tools/adapters/TerminalAdapter.js';
import { InMemoryTerminalSessionManager } from '#tools/adapters/TerminalSessionManager.js';
import { TERMINAL_CAPABILITY_MANIFESTS } from '#tools/adapters/terminal-capabilities/index.js';
import { WorkflowAdapter } from '#tools/adapters/WorkflowAdapter.js';
import type { CapabilityCatalog } from '#tools/catalog/CapabilityCatalog.js';
import { toolDefV1ToV2 } from '#tools/catalog/ToolDefinitionV2.js';
import { UnifiedToolCatalog } from '#tools/catalog/UnifiedToolCatalog.js';
import { ToolRouter } from '#tools/core/ToolRouter.js';
import { ALL_TOOLS } from '#tools/handlers/index.js';
import { WorkflowRegistry } from '#tools/workflow/WorkflowRegistry.js';
import { ToolForge } from '../../agent/forge/ToolForge.js';
import {
  buildMcpToolCapabilities,
  type McpToolDeclaration,
} from '../../external/mcp/McpCapabilityProjection.js';
import { McpToolAdapter, type McpToolExecutor } from '../../external/mcp/McpToolAdapter.js';
import { McpToolDiscovery } from '../../external/mcp/McpToolDiscovery.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import { AIRecallStrategy } from '../../service/skills/AIRecallStrategy.js';
import { FeedbackStore } from '../../service/skills/FeedbackStore.js';
import { RecommendationMetrics } from '../../service/skills/RecommendationMetrics.js';
import { RecommendationPipeline } from '../../service/skills/RecommendationPipeline.js';
import { RuleRecallStrategy } from '../../service/skills/RuleRecallStrategy.js';
import { SkillHooks } from '../../service/skills/SkillHooks.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  // UnifiedToolCatalog: 单源真相 — 合并 CapabilityCatalog + ToolRegistry
  c.singleton('capabilityCatalog', () => {
    const catalog = new UnifiedToolCatalog();

    // V1 内部工具 → V2 桥接注册
    catalog.registerV2All(ALL_TOOLS.map(toolDefV1ToV2));

    // 非内部工具 manifest 直接注册（Dashboard/Terminal/Skill/Mac）
    for (const m of [
      ...DASHBOARD_OPERATION_MANIFESTS,
      ...TERMINAL_CAPABILITY_MANIFESTS,
      ...SKILL_CAPABILITY_MANIFESTS,
      ...MAC_SYSTEM_CAPABILITY_MANIFESTS,
    ]) {
      catalog.register(m);
    }

    return catalog;
  });

  c.singleton('workflowRegistry', () => new WorkflowRegistry());
  c.singleton('terminalSessionManager', () => new InMemoryTerminalSessionManager());

  c.singleton('mcpToolDeclarations', (ct: ServiceContainer): McpToolDeclaration[] => {
    try {
      const discovery = new McpToolDiscovery();
      return discovery.discover(resolveProjectRoot(ct));
    } catch {
      return [];
    }
  });

  // toolRegistry: 返回 UnifiedToolCatalog（兼容 InternalToolHandlerStore + ForgedInternalToolStore）
  c.singleton('toolRegistry', (ct: ServiceContainer) => {
    const catalog = ct.get('capabilityCatalog') as UnifiedToolCatalog;

    // MCP tools: register manifests into main catalog + build adapter
    const mcpDeclarations = ct.get('mcpToolDeclarations') as McpToolDeclaration[];
    if (mcpDeclarations.length > 0) {
      const { manifests: mcpManifests } = buildMcpToolCapabilities(mcpDeclarations);
      for (const m of mcpManifests) {
        if (!catalog.has(m.id)) {
          catalog.register(m);
        }
      }
    }
    const mcpExecutor: McpToolExecutor =
      (ct.singletons.mcpToolExecutor as McpToolExecutor) ??
      (async (_name: string, _args: Record<string, unknown>) => {
        throw new Error('MCP tool executor not configured');
      });

    catalog.setRouter(
      new ToolRouter({
        catalog,
        adapters: [
          new InternalToolAdapter(catalog),
          new DashboardOperationAdapter(DASHBOARD_OPERATION_HANDLERS),
          new TerminalAdapter({
            sessionManager: ct.get('terminalSessionManager') as InMemoryTerminalSessionManager,
          }),
          new SkillAdapter(),
          new MacSystemAdapter(),
          new WorkflowAdapter(ct.get('workflowRegistry') as WorkflowRegistry),
          new McpToolAdapter(mcpExecutor),
        ],
        projectRoot: resolveProjectRoot(ct),
        dataRoot: resolveDataRoot(ct),
        services: ct,
      })
    );
    return catalog;
  });

  c.singleton('toolRouter', (ct: ServiceContainer) => {
    const catalog = ct.get('toolRegistry') as UnifiedToolCatalog;
    return catalog.getRouter();
  });

  c.singleton('toolForge', (ct: ServiceContainer) => {
    const catalog = ct.get('toolRegistry') as UnifiedToolCatalog;
    const signalBus = ct.singletons.signalBus as SignalBus | undefined;
    return new ToolForge(catalog, {
      signalBus,
      capabilityCatalog: ct.get('capabilityCatalog') as CapabilityCatalog,
      workflowRegistry: ct.get('workflowRegistry') as WorkflowRegistry,
    });
  });

  c.singleton('agentProfileRegistry', () => new AgentProfileRegistry(), { aiDependent: false });

  c.singleton('agentStageFactoryRegistry', () => new AgentStageFactoryRegistry(), {
    aiDependent: false,
  });

  c.singleton(
    'agentProfileCompiler',
    (ct: ServiceContainer) =>
      new AgentProfileCompiler({
        profileRegistry: ct.get('agentProfileRegistry') as AgentProfileRegistry,
        stageFactoryRegistry: ct.get('agentStageFactoryRegistry') as AgentStageFactoryRegistry,
      }),
    { aiDependent: false }
  );

  c.singleton('agentRunCoordinator', () => new AgentRunCoordinator(), { aiDependent: false });

  c.singleton(
    'systemRunContextFactory',
    (ct: ServiceContainer) =>
      new SystemRunContextFactory({
        aiProvider: (ct.singletons.aiProvider || null) as { model: string } | null,
      }),
    { aiDependent: true }
  );

  c.singleton(
    'agentRuntimeBuilder',
    (ct: ServiceContainer) =>
      new AgentRuntimeBuilder({
        container: ct as unknown as Record<string, unknown>,
        toolRegistry: ct.get('toolRegistry'),
        aiProvider: ct.singletons.aiProvider || null,
        projectRoot: resolveProjectRoot(ct),
        dataRoot: resolveDataRoot(ct),
      }),
    { aiDependent: true }
  );

  c.singleton(
    'agentService',
    (ct: ServiceContainer) =>
      new AgentService({
        runtimeBuilder: ct.get('agentRuntimeBuilder') as AgentRuntimeBuilder,
        profileCompiler: ct.get('agentProfileCompiler') as AgentProfileCompiler,
        runCoordinator: ct.get('agentRunCoordinator') as AgentRunCoordinator,
      }),
    { aiDependent: true }
  );

  c.singleton('skillHooks', () => {
    const hooks = new SkillHooks();
    hooks.load().catch(() => {
      /* skill hooks load is best-effort */
    });
    return hooks;
  });

  // ── Recommendation 子系统 ──

  c.singleton('feedbackStore', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.singletons.writeZone as
      | import('../../infrastructure/io/WriteZone.js').WriteZone
      | undefined;
    return new FeedbackStore(dataRoot, wz);
  });

  c.singleton('recommendationPipeline', (ct: ServiceContainer) => {
    const feedbackStore = ct.get('feedbackStore') as FeedbackStore;
    const skillHooks = ct.get('skillHooks') as SkillHooks;

    const pipeline = new RecommendationPipeline({ feedbackStore, skillHooks });

    // 注册召回策略
    pipeline.addStrategy(new RuleRecallStrategy());

    // AI 策略 — SignalCollector 可能尚未初始化，使用延迟绑定
    const aiStrategy = new AIRecallStrategy(null);
    pipeline.addStrategy(aiStrategy);

    // 在 singletons 上保存 aiStrategy 引用，供后续绑定 SignalCollector
    ct.singletons._aiRecallStrategy = aiStrategy;

    return pipeline;
  });

  c.singleton('recommendationMetrics', (ct: ServiceContainer) => {
    const feedbackStore = ct.get('feedbackStore') as FeedbackStore;
    return new RecommendationMetrics(feedbackStore);
  });
}
