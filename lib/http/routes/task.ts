/**
 * Task HTTP API 路由 (v3.3 — Intent Lifecycle)
 *
 * 为 VS Code Extension `taskTool.ts` 提供 HTTP 转发端点。
 * 5 operations: prime, create, close, fail, record_decision
 *
 * 端点:
 *   POST /api/v1/task  — 统一入口（operation 路由）
 */

import express, { type Request, type Response } from 'express';
import type { McpContext } from '#external/mcp/handlers/types.js';
import { TaskDispatchBody } from '#shared/schemas/http-requests.js';
import { taskHandler } from '../../external/mcp/handlers/task.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

/**
 * POST /api/v1/task
 *
 * 请求体:
 *   { operation: string, ...params }
 *
 * 响应:
 *   { success: boolean, data?: unknown, message?: string }
 */
router.post('/', validate(TaskDispatchBody), async (req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();

  // Build a minimal McpContext for the task handler
  const ctx: McpContext = {
    container,
    session:
      ((req as unknown as Record<string, unknown>).__mcpSession as McpContext['session']) ??
      undefined,
    startedAt: Date.now(),
  };

  try {
    const result = await taskHandler(ctx, req.body);
    const envelope = result as Record<string, unknown>;
    if (envelope.success === false) {
      return void res.status(400).json(envelope);
    }
    return void res.json(envelope);
  } catch (err: unknown) {
    return void res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : String(err),
      operation: req.body.operation,
    });
  }
});

export default router;
