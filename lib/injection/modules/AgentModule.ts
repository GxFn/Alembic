/**
 * AgentModule — Agent 架构服务注册
 *
 * 负责注册:
 *   - agentService, toolRegistry, skillHooks
 */

import {
  type CapabilityCatalog,
  LightweightRouter,
  UnifiedToolCatalog,
  WorkflowRegistry,
} from '@alembic/agent';
import {
  AgentProfileCompiler,
  AgentProfileRegistry,
  AgentRunCoordinator,
  AgentRuntimeBuilder,
  AgentService,
  AgentStageFactoryRegistry,
  SystemRunContextFactory,
} from '@alembic/agent/service';
import { V2CapabilityCatalog, V2ToolRouterAdapter } from '@alembic/agent/tools/runtime';
import { TERMINAL_CAPABILITY_MANIFESTS } from '@alembic/agent/tools/terminal';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { DashboardOperationAdapter } from '#tools/adapters/DashboardOperationAdapter.js';
import {
  createDashboardOperationHandlers,
  DASHBOARD_OPERATION_MANIFESTS,
} from '#tools/adapters/DashboardOperations.js';
import { MacSystemAdapter } from '#tools/adapters/MacSystemAdapter.js';
import { MAC_SYSTEM_CAPABILITY_MANIFESTS } from '#tools/adapters/MacSystemCapabilities.js';
import { SkillAdapter } from '#tools/adapters/SkillAdapter.js';
import { SKILL_CAPABILITY_MANIFESTS } from '#tools/adapters/SkillCapabilities.js';
import { TerminalAdapter } from '#tools/adapters/TerminalAdapter.js';
import { InMemoryTerminalSessionManager } from '#tools/adapters/TerminalSessionManager.js';
import { WorkflowAdapter } from '#tools/adapters/WorkflowAdapter.js';
import { ToolContextFactory } from '#tools/v2/ToolContextFactory.js';
import { SkillHooks } from '../../service/skills/SkillHooks.js';
import { getAiRuntimeStatus, getAiUnavailableMessage } from '../AiRuntimeStatus.js';
import type { ServiceContainer } from '../ServiceContainer.js';

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

  // toolRegistry: 非 Agent 表面 (Dashboard/Terminal/Skill/Mac) 的工具注册
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

    catalog.setRouter(
      new LightweightRouter({
        catalog: catalog as unknown as CapabilityCatalog,
        adapters: [
          new DashboardOperationAdapter(
            createDashboardOperationHandlers({
              aiStatus: getAiRuntimeStatus,
              aiUnavailableMessage: getAiUnavailableMessage,
            })
          ),
          new TerminalAdapter({
            sessionManager: ct.get('terminalSessionManager') as InMemoryTerminalSessionManager,
          }),
          new SkillAdapter(),
          new MacSystemAdapter(),
          new WorkflowAdapter(ct.get('workflowRegistry') as WorkflowRegistry),
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
}
