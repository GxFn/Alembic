/**
 * roleResolver 中间件 — 请求来源解析
 *
 * req.resolvedRole 是旧 HTTP 调用面保留的来源标签字段，不再表示 Alembic
 * runtime 权限角色，也不再由 git/probe/login 决定权限。
 */

import Logger from '@alembic/core/logging';
import type { NextFunction, Request, Response } from 'express';

const logger = Logger.getInstance();

const TRUST_X_USER_ID = process.env.ALEMBIC_TRUST_X_USER_ID === 'true';

function getHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0] || '';
  }
  return value || '';
}

function hasTrustedInternalToken(req: Request) {
  const expected = process.env.ALEMBIC_INTERNAL_TOKEN;
  if (!expected) {
    return false;
  }
  return getHeaderValue(req.headers['x-alembic-internal-token']) === expected;
}

function getTrustedHeaderActor(req: Request) {
  const actor = getHeaderValue(req.headers['x-user-id']);
  if (!actor || actor === 'anonymous' || actor === 'dashboard') {
    return null;
  }
  if (!TRUST_X_USER_ID && !hasTrustedInternalToken(req)) {
    logger.warn('roleResolver: ignored untrusted x-user-id header', { actor });
    return null;
  }
  return actor;
}

/** 创建请求来源解析中间件 */
export function roleResolverMiddleware(_options: Record<string, unknown> = {}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    // x-user-id 仅在显式可信内部通道中生效，避免外部 HTTP 客户端自报身份。
    const trustedHeaderActor = getTrustedHeaderActor(req);
    if (trustedHeaderActor) {
      req.resolvedRole = trustedHeaderActor;
      req.resolvedUser = `header:${trustedHeaderActor}`;
    } else {
      req.resolvedRole = 'http-request';
      req.resolvedUser = 'http-request';
    }

    logger.debug('roleResolver: resolved source', {
      source: req.resolvedRole,
      user: req.resolvedUser,
    });

    next();
  };
}

export default roleResolverMiddleware;
