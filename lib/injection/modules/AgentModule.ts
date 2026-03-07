/**
 * AgentModule — Agent 架构服务注册
 *
 * 负责注册:
 *   - agentFactory, toolRegistry, skillHooks
 *
 * @param {import('../ServiceContainer.js').ServiceContainer} c
 */

import { AgentFactory } from '../../service/agent/AgentFactory.js';
import { ALL_TOOLS } from '../../service/agent/tools/index.js';
import { ToolRegistry } from '../../service/agent/tools/ToolRegistry.js';
import { SkillHooks } from '../../service/skills/SkillHooks.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(c: ServiceContainer) {
  c.singleton('toolRegistry', () => {
    const registry = new ToolRegistry();
    registry.registerAll(ALL_TOOLS);
    return registry;
  });

  c.singleton(
    'agentFactory',
    (ct: ServiceContainer) =>
      new AgentFactory({
        container: ct,
        toolRegistry: ct.get('toolRegistry'),
        aiProvider: ct.singletons.aiProvider || null,
        projectRoot: (ct.singletons._projectRoot as string | undefined) || process.cwd(),
      } as unknown as ConstructorParameters<typeof AgentFactory>[0]),
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
