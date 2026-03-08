/**
 * 错误处理中间件
 */

import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import {
  ConflictError,
  NotFoundError,
  PermissionDenied,
  ValidationError,
} from '../../shared/errors/index.js';

/** Minimal logger interface (compatible with winston.Logger) */
interface AppLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

export function errorHandler(logger: AppLogger): ErrorRequestHandler {
  return (error, req, res, _next) => {
    const status = error.statusCode || error.status || 500;
    const code = error.code || 'INTERNAL_ERROR';
    const message = error.message || 'Internal server error';

    // 记录错误
    logger.error('Request error', {
      method: req.method,
      path: req.path,
      status,
      code,
      message,
      error: error.stack,
      timestamp: new Date().toISOString(),
    });

    // 响应错误
    res.status(status).json({
      success: false,
      error: {
        code,
        message,
        details: process.env.NODE_ENV === 'development' ? error.details || {} : undefined,
      },
    });
  };
}

/**
 * 将领域错误转换为 HTTP 错误
 */
export function mapDomainError(error: Error) {
  if (error instanceof ValidationError) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof ConflictError) {
    return {
      status: 409,
      code: 'CONFLICT_ERROR',
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof NotFoundError) {
    return {
      status: 404,
      code: 'NOT_FOUND_ERROR',
      message: error.message,
    };
  }

  if (error instanceof PermissionDenied) {
    return {
      status: 403,
      code: 'PERMISSION_DENIED_ERROR',
      message: error.message,
    };
  }

  // 默认内部错误
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: error.message || 'Internal server error',
  };
}
