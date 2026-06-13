/**
 * sourceResolver 中间件 — 请求来源解析
 *
 * req.resolvedSource / req.resolvedSourceActor 只表达请求来源，不表达
 * Alembic runtime 权限角色，也不由 git/probe/login 决定权限。
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
    logger.warn('sourceResolver: ignored untrusted x-user-id header', { actor });
    return null;
  }
  return actor;
}

/** 创建请求来源解析中间件 */
export function sourceResolverMiddleware(_options: Record<string, unknown> = {}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    // x-user-id 仅在显式可信内部通道中生效，避免外部 HTTP 客户端自报身份。
    const trustedHeaderSource = getTrustedHeaderActor(req);
    if (trustedHeaderSource) {
      req.resolvedSource = trustedHeaderSource;
      req.resolvedSourceActor = `header:${trustedHeaderSource}`;
    } else {
      req.resolvedSource = 'http-request';
      req.resolvedSourceActor = 'http-request';
    }

    logger.debug('sourceResolver: resolved request source', {
      source: req.resolvedSource,
      sourceActor: req.resolvedSourceActor,
    });

    next();
  };
}

export default sourceResolverMiddleware;
