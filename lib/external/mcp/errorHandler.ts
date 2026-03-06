/**
 * MCP 工具统一错误处理
 *
 * 提供 wrapHandler() 包装函数，将所有 handler 的异常统一转换为
 * envelope 格式的错误响应，确保：
 *   1. 已知业务错误 → 结构化 errorCode + message
 *   2. 未知异常 → 通用 INTERNAL_ERROR + 原始 message
 *   3. 一致的 meta.tool + meta.responseTimeMs
 *
 * @module external/mcp/errorHandler
 */

import Logger from '../../infrastructure/logging/Logger.js';
import {
  ConflictError,
  ConstitutionViolation,
  NotFoundError,
  PermissionDenied,
  ValidationError,
} from '../../shared/errors/index.js';
import { envelope } from './envelope.js';

const logger = Logger.getInstance();

/**
 * 从已知错误类型推断 errorCode
 * @param {Error} err
 * @returns {string}
 */
function inferErrorCode(err: any) {
  if (err instanceof ValidationError) {
    return 'VALIDATION_ERROR';
  }
  if (err instanceof NotFoundError) {
    return 'NOT_FOUND';
  }
  if (err instanceof ConflictError) {
    return 'CONFLICT';
  }
  if (err instanceof PermissionDenied) {
    return 'PERMISSION_DENIED';
  }
  if (err instanceof ConstitutionViolation) {
    return 'CONSTITUTION_VIOLATION';
  }
  if (err.code) {
    return err.code;
  }
  return 'INTERNAL_ERROR';
}

/**
 * 包装 MCP handler 函数，提供统一错误处理
 *
 * @param {string} toolName 工具名（用于 meta.tool）
 * @param {Function} handlerFn 原始 handler: (ctx, args) => Promise<any>
 * @returns {Function} 包装后的 handler，保证 *不会* throw
 *
 * @example
 *   import { wrapHandler } from '../errorHandler.js';
 *   export const search = wrapHandler('autosnippet_search', async (ctx, args) => {
 *     // ... 正常返回 envelope(...)
 *   });
 */
export function wrapHandler(toolName: any, handlerFn: any) {
  return async function wrappedHandler(ctx: any, args: any) {
    const t0 = Date.now();
    try {
      return await handlerFn(ctx, args);
    } catch (err: any) {
      const elapsed = Date.now() - t0;
      const errorCode = inferErrorCode(err);
      const message = err.message || 'Unknown error';

      logger.error(`[MCP:${toolName}] ${errorCode}: ${message}`, {
        tool: toolName,
        errorCode,
        durationMs: elapsed,
        ...(err.details ? { details: err.details } : {}),
      });

      return envelope({
        success: false,
        message,
        errorCode,
        meta: {
          tool: toolName,
          responseTimeMs: elapsed,
        },
      });
    }
  };
}

/**
 * 批量包装一个模块的所有 handler 函数
 *
 * @param {string} prefix 工具名前缀（如 'autosnippet_search'）
 * @param {Record<string, Function>} handlersModule - handler 模块 exports
 * @returns {Record<string, Function>} 包装后的 handlers
 *
 * @example
 *   import * as rawSearchHandlers from './handlers/search.js';
 *   const searchHandlers = wrapHandlers('autosnippet', rawSearchHandlers);
 */
export function wrapHandlers(prefix: any, handlersModule: any) {
  const wrapped: Record<string, any> = {};
  for (const [key, fn] of Object.entries(handlersModule)) {
    if (typeof fn === 'function') {
      wrapped[key] = wrapHandler(`${prefix}_${key}`, fn);
    } else {
      wrapped[key] = fn; // 非函数属性原样透传
    }
  }
  return wrapped;
}

export default { wrapHandler, wrapHandlers };
