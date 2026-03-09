/**
 * AgentModule — Agent 架构服务注册
 *
 * 负责注册:
 *   - agentFactory, toolRegistry, skillHooks
 *   - feedbackStore, recommendationPipeline, recommendationMetrics
 */

import { resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { AgentFactory } from '../../agent/AgentFactory.js';
import { ALL_TOOLS } from '../../agent/tools/index.js';
import { ToolRegistry } from '../../agent/tools/ToolRegistry.js';
import { AIRecallStrategy } from '../../service/skills/AIRecallStrategy.js';
import { FeedbackStore } from '../../service/skills/FeedbackStore.js';
import { RecommendationMetrics } from '../../service/skills/RecommendationMetrics.js';
import { RecommendationPipeline } from '../../service/skills/RecommendationPipeline.js';
import { RuleRecallStrategy } from '../../service/skills/RuleRecallStrategy.js';
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
        projectRoot: resolveProjectRoot(ct),
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

  // ── Recommendation 子系统 ──

  c.singleton('feedbackStore', () => {
    const projectRoot = resolveProjectRoot(c);
    return new FeedbackStore(projectRoot);
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
