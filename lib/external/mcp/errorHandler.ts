/**
 * MCP 工具统一错误处理
 *
 * 提供 wrapHandler() 包装函数，将所有 handler 的异常统一转换为
 * envelope 格式的错误响应，确保：
 *   1. Zod schema 校验 → 结构化 VALIDATION_ERROR (外部输入防御)
 *   2. 已知业务错误 → 结构化 errorCode + message
 *   3. 未知异常 → 通用 INTERNAL_ERROR + 原始 message
 *   4. 一致的 meta.tool + meta.responseTimeMs
 *
 * @module external/mcp/errorHandler
 */

import { z } from 'zod';
import Logger from '#infra/logging/Logger.js';
import {
  ConflictError,
  ConstitutionViolation,
  NotFoundError,
  PermissionDenied,
  ValidationError,
} from '#shared/errors/index.js';
import { TOOL_SCHEMAS } from '#shared/schemas/mcp-tools.js';

const logger = Logger.getInstance();

/** Error-like object with optional code and details */
interface ErrorWithDetails extends Error {
  code?: string;
  details?: unknown;
}

/** Handler function signature for MCP tools */
type McpHandlerFn = (
  ctx: Record<string, unknown>,
  args: Record<string, unknown>
) => Promise<unknown>;

/**
 * 从已知错误类型推断 errorCode
 * @param {Error} err
 * @returns {string}
 */
function inferErrorCode(err: unknown): string {
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
  const errRecord = err as ErrorWithDetails;
  if (errRecord.code) {
    return errRecord.code;
  }
  return 'INTERNAL_ERROR';
}

/**
 * 包装 MCP handler 函数，提供 Zod 输入校验 + 统一错误处理
 *
 * 如果 TOOL_SCHEMAS 中存在 toolName 对应的 Zod schema，
 * 则在 handler 执行前自动校验并 parse（应用 defaults + coercion），
 * 校验失败返回结构化 VALIDATION_ERROR，不会到达 handler。
 *
 * @param {string} toolName 工具名（用于 meta.tool + schema 查找）
 * @param {Function} handlerFn 原始 handler: (ctx, args) => Promise<unknown>
 * @param {ZodType} [schema] 可选的显式 schema 覆盖（优先于 TOOL_SCHEMAS 自动查找）
 * @returns {Function} 包装后的 handler，保证 *不会* throw
 */
export function wrapHandler(toolName: string, handlerFn: McpHandlerFn, schema?: z.ZodType) {
  // 确定使用的 schema：显式传入 > TOOL_SCHEMAS 自动查找
  const zodSchema = schema || TOOL_SCHEMAS[toolName];

  return async function wrappedHandler(
    ctx: Record<string, unknown>,
    rawArgs: Record<string, unknown>
  ) {
    const t0 = Date.now();
    try {
      // ★ Zod 校验（如果存在 schema），null/undefined 兜底空对象
      const safeArgs = rawArgs ?? {};
      const args = zodSchema ? zodSchema.parse(safeArgs) : safeArgs;

      return await handlerFn(ctx, args as Record<string, unknown>);
    } catch (err: unknown) {
      const elapsed = Date.now() - t0;

      // Zod 校验错误 → 结构化 VALIDATION_ERROR
      if (err instanceof z.ZodError) {
        const details = err.issues
          .map((e: z.core.$ZodIssue) => `${e.path.join('.')}: ${e.message}`)
          .join('; ');
        const msg = `输入校验失败: ${details}`;
        logger.warn(`[MCP:${toolName}] VALIDATION_ERROR: ${msg}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                message: msg,
                errorCode: 'VALIDATION_ERROR',
                meta: { tool: toolName, responseTimeMs: elapsed },
              }),
            },
          ],
          isError: true,
        };
      }

      // 业务错误 / 未知异常
      const errorCode = inferErrorCode(err);
      const message = (err instanceof Error ? err.message : '') || 'Unknown error';
      const errDetails = err instanceof Error ? (err as ErrorWithDetails).details : undefined;

      logger.error(`[MCP:${toolName}] ${errorCode}: ${message}`, {
        tool: toolName,
        errorCode,
        durationMs: elapsed,
        ...(errDetails ? { details: errDetails } : {}),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              message,
              errorCode,
              meta: {
                tool: toolName,
                responseTimeMs: elapsed,
              },
            }),
          },
        ],
        isError: true,
      };
    }
  };
}

export default { wrapHandler };
