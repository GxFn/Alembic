import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { invokeRouter } from '../helpers/express.js';

const mockContainer = {
  get: vi.fn(() => null),
  getServiceNames: vi.fn(() => []),
};

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mockContainer),
}));

import mcpRouter, { resetMcpBridgeDispatcherForTests } from '../../lib/http/routes/mcp.js';

describe('MCP bridge route', () => {
  beforeEach(() => {
    process.env.ALEMBIC_DAEMON_TOKEN = 'bridge-test-token';
    mockContainer.get.mockReturnValue(null);
    resetMcpBridgeDispatcherForTests();
  });

  afterEach(() => {
    delete process.env.ALEMBIC_DAEMON_TOKEN;
    resetMcpBridgeDispatcherForTests();
  });

  test('rejects missing daemon token before dispatching the tool call', async () => {
    const response = await invokeRouter(mcpRouter, {
      method: 'POST',
      mountPath: '/api/v1/mcp',
      path: '/api/v1/mcp/call',
      body: {
        name: 'alembic_task',
        args: { operation: 'prime', userQuery: 'BiliDili prime' },
      },
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'UNAUTHORIZED' },
    });
  });

  test('dispatches alembic_task prime through the real MCP handler', async () => {
    const response = await invokeRouter(mcpRouter, {
      method: 'POST',
      mountPath: '/api/v1/mcp',
      path: '/api/v1/mcp/call',
      headers: {
        'x-alembic-daemon-token': 'bridge-test-token',
      },
      body: {
        name: 'alembic_task',
        args: { operation: 'prime', userQuery: 'BiliDili prime shout' },
        actor: { role: 'external_agent', user: 'codex-test', sessionId: 'ses-test' },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
        }),
      ])
    );

    const firstContent = (response.body.content as Array<{ text: string }>)[0];
    const payload = JSON.parse(firstContent.text) as Record<string, unknown>;
    expect(payload).toMatchObject({
      success: true,
      meta: { tool: 'alembic_task' },
    });
    expect(payload.message).toBe('No matching recipes found.');
  });

  test('returns a tool error instead of route 404 for unknown MCP tools', async () => {
    const response = await invokeRouter(mcpRouter, {
      method: 'POST',
      mountPath: '/api/v1/mcp',
      path: '/api/v1/mcp/call',
      headers: {
        'x-alembic-daemon-token': 'bridge-test-token',
      },
      body: {
        name: 'alembic_missing_tool',
        args: {},
      },
    });

    expect(response.status).toBe(400);
    const firstContent = (response.body.content as Array<{ text: string }>)[0];
    const payload = JSON.parse(firstContent.text) as Record<string, unknown>;
    expect(payload).toMatchObject({
      success: false,
      errorCode: 'TOOL_ERROR',
    });
    expect(payload.message).toContain('Unknown tool');
  });
});
