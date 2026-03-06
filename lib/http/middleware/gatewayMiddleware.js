/**
 * Gateway 中间件
 * 为 Express 请求注入 Gateway 执行能力
 * 路由层通过 req.gw(action, resource, data) 发起 Gateway 请求
 *
 * actor 来源优先级：
 *   1. req.resolvedRole  — roleResolver 中间件已解析（双路径）
 *   2. req.headers['x-user-id'] — 内部 / MCP 调用
 *   3. 'anonymous' — 兜底
 */

import { getServiceContainer } from '../../injection/ServiceContainer.js';

/**
 * Express 中间件：将 Gateway 注入到 req 对象
 */
export function gatewayMiddleware() {
  return (req, res, next) => {
    /**
     * Gateway 快捷执行方法
     * @param {string} action 操作标识 (如 'candidate:create')
     * @param {string} resource 资源类型 (如 'candidates')
     * @param {object} data 请求数据
     * @returns {Promise<{success: boolean, data?: any, error?: object, requestId: string}>}
     */
    req.gw = async (action, resource, data = {}) => {
      const container = getServiceContainer();
      const gateway = container.get('gateway');

      // 优先使用 roleResolver 解析的角色，其次 header，最后兜底
      const actor = req.resolvedRole || req.headers['x-user-id'] || 'anonymous';

      const result = await gateway.execute({
        actor,
        action,
        resource,
        data: {
          ...data,
          _ip: req.ip,
          _userAgent: req.headers['user-agent'] || '',
          _resolvedUser: req.resolvedUser || undefined,
        },
        session: req.headers['x-session-id'],
      });

      if (!result.success) {
        const err = new Error(result.error.message);
        err.statusCode = result.error.statusCode || 500;
        err.code = result.error.code;
        err.requestId = result.requestId;
        throw err;
      }

      return result;
    };

    next();
  };
}

export default gatewayMiddleware;
