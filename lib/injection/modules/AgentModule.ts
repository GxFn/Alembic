/**
 * AgentModule — Agent 架构服务注册
 *
 * 负责注册:
 *   - agentService, toolRegistry, toolForge, skillHooks
 *   - feedbackStore, recommendationPipeline, recommendationMetrics
 */

import { ToolForge } from '@alembic/agent/forge';
import {
  AgentProfileCompiler,
  AgentProfileRegistry,
  AgentRunCoordinator,
  AgentRuntimeBuilder,
  AgentService,
  AgentStageFactoryRegistry,
  SystemRunContextFactory,
} from '@alembic/agent/service';
import {
  type CapabilityCatalog,
  LightweightRouter,
  UnifiedToolCatalog,
  WorkflowRegistry,
} from '@alembic/agent/tools';
import { TERMINAL_CAPABILITY_MANIFESTS } from '@alembic/agent/tools/terminal';
import { V2CapabilityCatalog, V2ToolRouterAdapter } from '@alembic/agent/tools/v2';
import type { SignalBus } from '@alembic/core/events';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { DashboardOperationAdapter } from '#tools/adapters/DashboardOperationAdapter.js';
import {
  DASHBOARD_OPERATION_HANDLERS,
  DASHBOARD_OPERATION_MANIFESTS,
} from '#tools/adapters/DashboardOperations.js';
import { MacSystemAdapter } from '#tools/adapters/MacSystemAdapter.js';
import { MAC_SYSTEM_CAPABILITY_MANIFESTS } from '#tools/adapters/MacSystemCapabilities.js';
import { SkillAdapter } from '#tools/adapters/SkillAdapter.js';
import { SKILL_CAPABILITY_MANIFESTS } from '#tools/adapters/SkillCapabilities.js';
import { TerminalAdapter } from '#tools/adapters/TerminalAdapter.js';
import { InMemoryTerminalSessionManager } from '#tools/adapters/TerminalSessionManager.js';
import { WorkflowAdapter } from '#tools/adapters/WorkflowAdapter.js';
import { ToolContextFactory } from '#tools/v2/adapter/ToolContextFactory.js';
import {
  buildMcpToolCapabilities,
  type McpToolDeclaration,
} from '../../external/mcp/McpCapabilityProjection.js';
import { McpToolAdapter, type McpToolExecutor } from '../../external/mcp/McpToolAdapter.js';
import { McpToolDiscovery } from '../../external/mcp/McpToolDiscovery.js';
import { AIRecallStrategy } from '../../service/skills/AIRecallStrategy.js';
import { FeedbackStore } from '../../service/skills/FeedbackStore.js';
import { RecommendationMetrics } from '../../service/skills/RecommendationMetrics.js';
import { RecommendationPipeline } from '../../service/skills/RecommendationPipeline.js';
import { RuleRecallStrategy } from '../../service/skills/RuleRecallStrategy.js';
import { SkillHooks } from '../../service/skills/SkillHooks.js';
import type { ServiceContainer } from '../ServiceContainer.js';

type HostToolForgeConstructor = new (
  registry: unknown,
  options?: {
    signalBus?: SignalBus;
    capabilityCatalog?: unknown;
    workflowRegistry?: unknown;
  }
) => InstanceType<typeof ToolForge>;

export function register(c: ServiceContainer) {
  // ── V2 Tool System ─────────────────────────────────────────────────
  // capabilityCatalog: V2CapabilityCatalog 直接从 TOOL_REGISTRY 生成 schema
  c.singleton('capabilityCatalog', () => new V2CapabilityCatalog());

  // V2 ToolContextFactory: 长生命周期，持有 DeltaCache/SearchCache/Compressor
  c.singleton(
    'v2ToolContextFactory',
    (ct: ServiceContainer) =>
      new ToolContextFactory({
        container: ct,
        projectRoot: resolveProjectRoot(ct),
      })
  );

  // toolRouter: V2ToolRouterAdapter 实现 ToolRouterContract
  c.singleton(
    'toolRouter',
    (ct: ServiceContainer) =>
      new V2ToolRouterAdapter({
        contextFactory: ct.get('v2ToolContextFactory') as ToolContextFactory,
      })
  );

  // toolRegistry: 非 Agent 表面 (Dashboard/Terminal/Skill/Mac/MCP) 的工具注册
  c.singleton('toolRegistry', (ct: ServiceContainer) => {
    const catalog = new UnifiedToolCatalog();

    for (const m of [
      ...DASHBOARD_OPERATION_MANIFESTS,
      ...TERMINAL_CAPABILITY_MANIFESTS,
      ...SKILL_CAPABILITY_MANIFESTS,
      ...MAC_SYSTEM_CAPABILITY_MANIFESTS,
    ]) {
      catalog.register(m);
    }

    // MCP tools
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
      new LightweightRouter({
        catalog: catalog as unknown as CapabilityCatalog,
        adapters: [
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

  c.singleton('toolForge', (ct: ServiceContainer) => {
    const catalog = ct.get('toolRegistry') as UnifiedToolCatalog;
    const signalBus = ct.singletons.signalBus as SignalBus | undefined;
    const AgentToolForge = ToolForge as unknown as HostToolForgeConstructor;
    return new AgentToolForge(catalog, {
      signalBus,
      capabilityCatalog: catalog as unknown as CapabilityCatalog,
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
        toolRouter: ct.get('toolRouter'),
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
    const wz = ct.singletons.writeZone as import('@alembic/core/io').WriteZone | undefined;
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
