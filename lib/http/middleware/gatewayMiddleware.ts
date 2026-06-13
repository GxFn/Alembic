/**
 * Gateway 中间件
 * 为 Express 请求注入 Gateway 执行能力
 * 路由层通过 req.gw(action, resource, data) 发起 Gateway 请求
 *
 * actor 是审计来源标签，不是运行时权限角色。
 */

import type { NextFunction, Request, Response } from 'express';
import { getServiceContainer } from '../../injection/ServiceContainer.js';

/** Error subclass with Gateway-specific properties */
class GatewayError extends Error {
  statusCode: number;
  code: string;
  requestId: string;
  constructor(message: string, statusCode: number, code: string, requestId: string) {
    super(message);
    this.name = 'GatewayError';
    this.statusCode = statusCode;
    this.code = code;
    this.requestId = requestId;
  }
}

/** Express 中间件：将 Gateway 注入到 req 对象 */
export function gatewayMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    /**
     * Gateway 快捷执行方法
     * @param action 操作标识 (如 'candidate:create')
     * @param resource 资源类型 (如 'candidates')
     * @param data 请求数据
     * @returns >}
     */
    req.gw = async (action: string, resource: string, data: Record<string, unknown> = {}) => {
      const container = getServiceContainer();
      const gateway = container.get('gateway');

      const actor = req.resolvedSourceActor || req.resolvedSource || 'http-request';

      const result = await gateway.execute({
        actor,
        action,
        resource,
        data: {
          ...data,
          _ip: req.ip,
          _userAgent: req.headers['user-agent'] || '',
          _resolvedSourceActor: req.resolvedSourceActor || undefined,
        },
        session: req.headers['x-session-id'] as string | undefined,
      });

      if (!result.success) {
        throw new GatewayError(
          result.error?.message || 'Gateway error',
          result.error?.statusCode || 500,
          result.error?.code || '',
          result.requestId
        );
      }

      return result;
    };

    next();
  };
}

export default gatewayMiddleware;
