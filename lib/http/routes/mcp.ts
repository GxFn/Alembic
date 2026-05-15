import { timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { McpServer } from '../../external/mcp/McpServer.js';
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

let bridgeServer: McpServer | null = null;

/**
 * POST /api/v1/mcp/call
 * Local-only daemon bridge used by alembic-codex-mcp.
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
  try {
    const server = getBridgeServer();
    const result = await server._handleToolCall(name, args, {
      surface: 'codex',
      source: { kind: 'codex', name: '/api/v1/mcp/call' },
      actor: {
        role: actor?.role || 'external_agent',
        user: actor?.user,
        sessionId: actor?.sessionId,
      },
    });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      error: {
        code: 'MCP_BRIDGE_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
});

function getBridgeServer(): McpServer {
  if (!bridgeServer) {
    bridgeServer = new McpServer({
      actorRole: 'external_agent',
      container: getServiceContainer(),
      source: { kind: 'codex', name: '/api/v1/mcp/call' },
      surface: 'codex',
    });
  }
  return bridgeServer;
}

function isDaemonBridgeAuthorized(req: Request): boolean {
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

export default router;
