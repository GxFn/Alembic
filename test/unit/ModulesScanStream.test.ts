/**
 * AD6 regression test for the ruled AD4-MODULES-STREAM-PUSH-DEFECT fix:
 * POST /modules/scan-folder/stream events flow through the documented SSE
 * session contract (send/end/error). Before the fix the route called a
 * nonexistent session.push() and every stream event threw at runtime.
 */

import { vi } from 'vitest';

const moduleServiceMock = vi.hoisted(() => ({
  load: vi.fn(async () => {}),
  scanFolder: vi.fn(
    async (
      _path: string,
      options: { onProgress?: (evt: Record<string, unknown>) => void } = {}
    ) => {
      options.onProgress?.({ type: 'scan:progress', step: 'walk' });
      return { message: 'ok', recipes: [], scannedFiles: ['a.swift'] };
    }
  ),
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => ({
    get: (name: string) => {
      if (name === 'moduleService') {
        return moduleServiceMock;
      }
      return null;
    },
    services: {},
    singletons: {},
  })),
}));

import modulesRouter from '../../lib/http/routes/modules.js';
import {
  getStreamSession,
  resetDefaultSseConnectionRegistry,
} from '../../lib/http/utils/sse-connections.js';
import { invokeRouter } from '../helpers/express.js';

async function flushStream() {
  // The route pushes events from a setImmediate callback chain.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('POST /modules/scan-folder/stream SSE session contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDefaultSseConnectionRegistry();
  });

  test('events flow via send() and the session completes via end() (stream:done)', async () => {
    const response = await invokeRouter(modulesRouter, {
      body: { path: '/tmp/scan-me' },
      method: 'POST',
      mountPath: '/api/v1/modules',
      path: '/api/v1/modules/scan-folder/stream',
    });

    expect(response.status).toBe(200);
    const sessionId = (response.body as { sessionId?: string }).sessionId;
    expect(sessionId).toEqual(expect.any(String));

    await flushStream();

    const session = getStreamSession(sessionId as string);
    expect(session).toBeDefined();
    const types = (session as { buffer: Array<{ type?: unknown }> }).buffer.map((e) => e.type);
    expect(types).toContain('scan:progress');
    expect(types).toContain('scan:result');
    expect(types).toContain('stream:done');
    expect((session as { completed: boolean }).completed).toBe(true);
  });

  test('scan failures complete the session via error() (stream:error)', async () => {
    moduleServiceMock.scanFolder.mockRejectedValueOnce(new Error('disk exploded'));

    const response = await invokeRouter(modulesRouter, {
      body: { path: '/tmp/scan-me' },
      method: 'POST',
      mountPath: '/api/v1/modules',
      path: '/api/v1/modules/scan-folder/stream',
    });
    const sessionId = (response.body as { sessionId?: string }).sessionId;

    await flushStream();

    const session = getStreamSession(sessionId as string);
    const events = (session as { buffer: Array<Record<string, unknown>> }).buffer;
    const errorEvent = events.find((e) => e.type === 'stream:error');
    expect(errorEvent).toMatchObject({
      code: 'SCAN_FOLDER_STREAM_ERROR',
      message: 'disk exploded',
    });
    expect((session as { completed: boolean }).completed).toBe(true);
  });
});
