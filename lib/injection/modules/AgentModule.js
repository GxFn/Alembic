/**
 * AgentModule — Agent 架构服务注册
 *
 * 负责注册:
 *   - agentFactory, toolRegistry, skillHooks
 *
 * @param {import('../ServiceContainer.js').ServiceContainer} c
 */

import { AgentFactory } from '../../service/agent/AgentFactory.js';
import { ToolRegistry } from '../../service/agent/tools/ToolRegistry.js';
import { ALL_TOOLS } from '../../service/agent/tools/index.js';
import { SkillHooks } from '../../service/skills/SkillHooks.js';

export function register(c) {
  c.singleton('toolRegistry', () => {
    const registry = new ToolRegistry();
    registry.registerAll(ALL_TOOLS);
    return registry;
  });

  c.singleton(
    'agentFactory',
    (ct) =>
      new AgentFactory({
        container: ct,
        toolRegistry: ct.get('toolRegistry'),
        aiProvider: ct.singletons.aiProvider || null,
        projectRoot: ct.singletons._projectRoot || process.cwd(),
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
