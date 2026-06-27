/**
 * AgentModule — Agent 架构服务注册
 *
 * 负责注册:
 *   - agentService, toolRegistry, skillHooks
 */

import { UnifiedToolCatalog, WorkflowRegistry } from '@alembic/agent';
import {
  AgentProfileCompiler,
  AgentProfileRegistry,
  AgentRunCoordinator,
  AgentRuntimeBuilder,
  AgentService,
  AgentStageFactoryRegistry,
  SystemRunContextFactory,
} from '@alembic/agent/service';
import { RuntimeCapabilityCatalog, ToolRouterAdapter } from '@alembic/agent/tools/runtime';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { DASHBOARD_OPERATION_MANIFESTS } from '#tools/adapters/DashboardOperations.js';
import { SKILL_CAPABILITY_MANIFESTS } from '#tools/adapters/SkillCapabilities.js';
import { ToolContextFactory } from '#tools/v2/ToolContextFactory.js';
import { SkillHooks } from '../../service/skills/SkillHooks.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  // ── Tool System ─────────────────────────────────────────────────
  // capabilityCatalog: RuntimeCapabilityCatalog 直接从 TOOL_REGISTRY 生成 schema
  c.singleton('capabilityCatalog', () => new RuntimeCapabilityCatalog());

  // ToolContextFactory: 长生命周期，持有 DeltaCache/SearchCache/Compressor
  c.singleton(
    'toolContextFactory',
    (ct: ServiceContainer) =>
      new ToolContextFactory({
        container: ct,
        projectRoot: resolveProjectRoot(ct),
      })
  );

  // toolRouter: ToolRouterAdapter 实现 ToolRouterContract
  c.singleton(
    'toolRouter',
    (ct: ServiceContainer) =>
      new ToolRouterAdapter({
        contextFactory: ct.get('toolContextFactory') as ToolContextFactory,
      })
  );

  // toolRegistry 只保留 manifest / self-introspection store；runtime 执行统一走 v2 toolRouter。
  // E-3 分支 A 退掉旧轻量 router 与 terminal adapter 栈，避免继续消费退役的
  // terminal public subpath。
  c.singleton('toolRegistry', () => {
    const catalog = new UnifiedToolCatalog();

    for (const m of [...DASHBOARD_OPERATION_MANIFESTS, ...SKILL_CAPABILITY_MANIFESTS]) {
      catalog.register(m);
    }

    return catalog;
  });

  c.singleton('workflowRegistry', () => new WorkflowRegistry());

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
