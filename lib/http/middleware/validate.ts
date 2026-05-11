/**
 * validate.ts — Express Zod 校验中间件
 *
 * 用法：
 *   import { validate, validateQuery } from '../middleware/validate.js';
 *   router.post('/batch-enable', validate(BatchEnableBody), async (req, res) => { ... });
 *   router.get('/search', validateQuery(SearchQuery), async (req, res) => { ... });
 *
 * 校验通过后：
 *   - req.body / req.query 被替换为 Zod parse 后的数据（已应用 defaults + coercion）
 *   - handler 中直接使用，类型安全
 *
 * 校验失败：
 *   - 返回 400 + 结构化 VALIDATION_ERROR（包含 fieldErrors / formErrors）
 *
 * @module http/middleware/validate
 */

import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';

/**
 * 校验 req.body 的中间件工厂
 *
 * @param schema Zod schema（通常为 z.object）
 * @returns Express 中间件
 */
export function validate<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body validation failed',
          details: result.error.flatten(),
        },
      });
      return;
    }
    // 替换为 parsed + defaulted 数据
    req.body = result.data;
    next();
  };
}

/**
 * 校验 req.query 的中间件工厂
 *
 * @param schema Zod schema
 * @returns Express 中间件
 */
export function validateQuery<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Query parameter validation failed',
          details: result.error.flatten(),
        },
      });
      return;
    }
    // Express 5: req.query is a read-only getter, use defineProperty to override
    Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
    next();
  };
}

/**
 * 校验 req.params 的中间件工厂
 *
 * @param schema Zod schema
 * @returns Express 中间件
 */
export function validateParams<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Path parameter validation failed',
          details: result.error.flatten(),
        },
      });
      return;
    }
    Object.defineProperty(req, 'params', {
      value: result.data,
      writable: true,
      configurable: true,
    });
    next();
  };
}
