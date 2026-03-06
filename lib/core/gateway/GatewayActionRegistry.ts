/**
 * GatewayActionRegistry - 将所有服务操作注册为 Gateway 路由
 *
 * 这是连接 Gateway ↔ Service 的桥梁：
 * - 路由层格式化 Gateway 请求 {actor, action, resource, data}
 * - Gateway 执行权限/宪法/审计
 * - GatewayActionRegistry 将 action 路由到正确的 Service 方法
 */

import Logger from '../../infrastructure/logging/Logger.js';

const logger = Logger.getInstance();

/**
 * 注册所有 Gateway actions
 * @param {import('./Gateway.js').Gateway} gateway
 * @param {import('../../injection/ServiceContainer.js').ServiceContainer} container
 */
export function registerGatewayActions(gateway: any, container: any) {
  // ========== Knowledge Actions (V3: replaces Candidate + Recipe) ==========

  gateway.register('candidate:create', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.create(ctx.data, {
      userId: ctx.actor,
    });
  });

  gateway.register('candidate:approve', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.approve(ctx.data.candidateId, {
      userId: ctx.actor,
    });
  });

  gateway.register('candidate:reject', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.reject(ctx.data.candidateId, ctx.data.reason, {
      userId: ctx.actor,
    });
  });

  gateway.register('candidate:apply_to_recipe', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.publish(ctx.data.candidateId, { userId: ctx.actor });
  });

  gateway.register('candidate:list', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.list(ctx.data.filters, ctx.data.pagination);
  });

  gateway.register('candidate:search', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.search(ctx.data.keyword, ctx.data.pagination);
  });

  gateway.register('candidate:get_stats', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.getStats();
  });

  gateway.register('candidate:get', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.get(ctx.data.id);
  });

  gateway.register('candidate:delete', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.delete(ctx.data.candidateId, { userId: ctx.actor });
  });

  // ========== Recipe Actions (V3: routed to knowledgeService) ==========

  gateway.register('recipe:create', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.create(ctx.data, {
      userId: ctx.actor,
    });
  });

  gateway.register('recipe:publish', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.publish(ctx.data.recipeId, {
      userId: ctx.actor,
    });
  });

  gateway.register('recipe:deprecate', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.deprecate(ctx.data.recipeId, ctx.data.reason, {
      userId: ctx.actor,
    });
  });

  gateway.register('recipe:update_quality', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.updateQuality(ctx.data.recipeId, ctx.data.metrics);
  });

  gateway.register('recipe:adopt', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.incrementUsage(ctx.data.recipeId, 'adoption');
  });

  gateway.register('recipe:apply', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.incrementUsage(ctx.data.recipeId, 'application');
  });

  gateway.register('recipe:list', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.list(ctx.data.filters, ctx.data.pagination);
  });

  gateway.register('recipe:search', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.search(ctx.data.keyword, ctx.data.pagination);
  });

  gateway.register('recipe:get_stats', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.getStats();
  });

  gateway.register('recipe:get', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.get(ctx.data.id);
  });

  gateway.register('recipe:get_recommendations', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.list({ lifecycle: 'active' }, { page: 1, pageSize: ctx.data.limit || 10 });
  });

  gateway.register('recipe:delete', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.delete(ctx.data.recipeId, {
      userId: ctx.actor,
    });
  });

  // ========== Guard Rule Actions ==========

  gateway.register('guard_rule:create', async (ctx: any) => {
    const service = container.get('guardService');
    return service.createRule(ctx.data, {
      userId: ctx.actor,
      ip: ctx.data._ip,
      userAgent: ctx.data._userAgent,
    });
  });

  gateway.register('guard_rule:enable', async (ctx: any) => {
    const service = container.get('guardService');
    return service.enableRule(ctx.data.ruleId, {
      userId: ctx.actor,
    });
  });

  gateway.register('guard_rule:disable', async (ctx: any) => {
    const service = container.get('guardService');
    return service.disableRule(ctx.data.ruleId, ctx.data.reason, {
      userId: ctx.actor,
    });
  });

  gateway.register('guard_rule:check_code', async (ctx: any) => {
    const service = container.get('guardService');
    return service.checkCode(ctx.data.code, ctx.data.options);
  });

  gateway.register('guard_rule:import_from_recipe', async (ctx: any) => {
    // importRulesFromRecipe 已废弃，使用 createRule 代替
    const service = container.get('guardService');
    return service.createRule(ctx.data, { userId: ctx.actor });
  });

  gateway.register('guard_rule:list', async (ctx: any) => {
    const service = container.get('guardService');
    return service.listRules(ctx.data.filters, ctx.data.pagination);
  });

  gateway.register('guard_rule:search', async (ctx: any) => {
    const service = container.get('guardService');
    return service.searchRules(ctx.data.keyword, ctx.data.pagination);
  });

  gateway.register('guard_rule:get_stats', async (ctx: any) => {
    const service = container.get('guardService');
    return service.getRuleStats();
  });

  gateway.register('guard_rule:get', async (ctx: any) => {
    const repo = container.get('knowledgeRepository');
    return repo.findById(ctx.data.id);
  });

  // ========== Search Actions ==========

  // ========== Knowledge Update (enrich/refine) ==========

  gateway.register('candidate:update', async (ctx: any) => {
    const service = container.get('knowledgeService');
    return service.update(ctx.data.id, ctx.data, { userId: ctx.actor });
  });

  // ========== Search ==========

  gateway.register('search:query', async (ctx: any) => {
    const service = container.get('searchEngine');
    return service.search(ctx.data.keyword, ctx.data.options);
  });

  logger?.info('Gateway: All actions registered', {
    actionCount: gateway.getRegisteredActions().length,
  });
}

/**
 * 辅助函数: 创建 Gateway 请求对象
 * 用于路由层格式化请求
 */
export function buildGatewayRequest(req: any, action: any, resource: any, data: any = {}) {
  return {
    actor: req.headers['x-user-id'] || 'anonymous',
    action,
    resource,
    data: {
      ...data,
      _ip: req.ip,
      _userAgent: req.headers['user-agent'] || '',
    },
    session: req.headers['x-session-id'],
  };
}
