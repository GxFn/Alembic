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
import { TERMINAL_CAPABILITY_MANIFESTS } from '#tools/adapters/TerminalCapabilities.js';
import { InMemoryTerminalSessionManager } from '#tools/adapters/TerminalSessionManager.js';
import { WorkflowAdapter } from '#tools/adapters/WorkflowAdapter.js';
import { CapabilityCatalog } from '#tools/catalog/CapabilityCatalog.js';
import { ToolRegistry } from '#tools/catalog/ToolRegistry.js';
import { ToolRouter } from '#tools/core/ToolRouter.js';
import { ALL_TOOLS, TOOL_CAPABILITY_MANIFESTS } from '#tools/handlers/index.js';
import { WorkflowRegistry } from '#tools/workflow/WorkflowRegistry.js';
import { ToolForge } from '../../agent/forge/ToolForge.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import { AIRecallStrategy } from '../../service/skills/AIRecallStrategy.js';
import { FeedbackStore } from '../../service/skills/FeedbackStore.js';
import { RecommendationMetrics } from '../../service/skills/RecommendationMetrics.js';
import { RecommendationPipeline } from '../../service/skills/RecommendationPipeline.js';
import { RuleRecallStrategy } from '../../service/skills/RuleRecallStrategy.js';
import { SkillHooks } from '../../service/skills/SkillHooks.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  c.singleton(
    'capabilityCatalog',
    () =>
      new CapabilityCatalog([
        ...TOOL_CAPABILITY_MANIFESTS,
        ...DASHBOARD_OPERATION_MANIFESTS,
        ...TERMINAL_CAPABILITY_MANIFESTS,
        ...SKILL_CAPABILITY_MANIFESTS,
        ...MAC_SYSTEM_CAPABILITY_MANIFESTS,
      ])
  );

  c.singleton('workflowRegistry', () => new WorkflowRegistry());
  c.singleton('terminalSessionManager', () => new InMemoryTerminalSessionManager());

  c.singleton('toolRegistry', (ct: ServiceContainer) => {
    const registry = new ToolRegistry();
    registry.registerAll(ALL_TOOLS);
    registry.setRouter(
      new ToolRouter({
        catalog: ct.get('capabilityCatalog') as CapabilityCatalog,
        adapters: [
          new InternalToolAdapter(registry),
          new DashboardOperationAdapter(DASHBOARD_OPERATION_HANDLERS),
          new TerminalAdapter({
            sessionManager: ct.get('terminalSessionManager') as InMemoryTerminalSessionManager,
          }),
          new SkillAdapter(),
          new MacSystemAdapter(),
          new WorkflowAdapter(ct.get('workflowRegistry') as WorkflowRegistry),
        ],
        projectRoot: resolveProjectRoot(ct),
        services: ct,
      })
    );
    return registry;
  });

  c.singleton('toolRouter', (ct: ServiceContainer) => {
    const registry = ct.get('toolRegistry') as ToolRegistry;
    return registry.getRouter();
  });

  c.singleton('toolForge', (ct: ServiceContainer) => {
    const registry = ct.get('toolRegistry');
    const signalBus = ct.singletons.signalBus as SignalBus | undefined;
    return new ToolForge(registry, {
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
