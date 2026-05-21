import { timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { McpBridgeDispatcher } from '../../external/mcp/McpBridgeDispatcher.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

const McpCallBody = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  actor: z
    .object({
      role: z.string().optional(),
      user: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .optional(),
});

let bridgeDispatcher: McpBridgeDispatcher | null = null;

/**
 * POST /api/v1/mcp/call
 *
 * Codex Plugin 调用本地 Alembic daemon 的 MCP bridge 入口。
 * 请求通过 daemon token 鉴权后，转入本仓库真实 MCP handler。
 */
router.post('/call', validate(McpCallBody), async (req: Request, res: Response): Promise<void> => {
  if (!isDaemonBridgeAuthorized(req)) {
    res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing Alembic daemon token',
      },
    });
    return;
  }

  const { actor, args, name } = req.body as z.infer<typeof McpCallBody>;
  const result = await getBridgeDispatcher().callTool(name, args, {
    surface: 'codex',
    source: { kind: 'codex', name: '/api/v1/mcp/call' },
    actor: {
      role: actor?.role || 'external_agent',
      user: actor?.user,
      sessionId: actor?.sessionId,
    },
  });
  res.status(result.isError ? 400 : 200).json(result);
});

export function resetMcpBridgeDispatcherForTests(): void {
  bridgeDispatcher = null;
}

export function isDaemonBridgeAuthorized(req: Request): boolean {
  const expected = process.env.ALEMBIC_DAEMON_TOKEN;
  const providedHeader = req.headers['x-alembic-daemon-token'];
  const provided = Array.isArray(providedHeader) ? providedHeader[0] : providedHeader;
  if (!expected || typeof provided !== 'string') {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function getBridgeDispatcher(): McpBridgeDispatcher {
  if (!bridgeDispatcher) {
    bridgeDispatcher = new McpBridgeDispatcher(getServiceContainer());
  }
  return bridgeDispatcher;
}

export default router;
