import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { HttpServer } from '../../lib/http/HttpServer.js';
import { getServiceContainer } from '../../lib/injection/ServiceContainer.js';

const PREFLIGHT_HASH = `sha256:${'a'.repeat(64)}`;
let server: HttpServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

describe('strict-test-dimension real Main HTTP entry', () => {
  test('mounts preflight/start/status/report without a DaemonJob transport', async () => {
    const service = {
      preflight: vi.fn(async () => ({ preflightHash: PREFLIGHT_HASH })),
      start: vi.fn(async () => ({ runId: 'strict-run-http', state: 'PRIVATE_WORKSPACE_READY' })),
      status: vi.fn(async () => ({ runId: 'strict-run-http', state: 'PRIVATE_WORKSPACE_READY' })),
      report: vi.fn(async () => ({ terminalState: 'STRICT_TEST_COMPLETED_PRIVATE' })),
    };
    const container = getServiceContainer();
    container.singletons.strictTestDimensionOrchestrator = service;
    container.register('strictTestDimensionOrchestrator', () => service);

    server = new HttpServer({ host: '127.0.0.1', port: 0 });
    server.setupMiddleware();
    server.setupRoutes();
    server.setupErrorHandling();
    const listener = await server.start();
    const port = (listener.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/v1/strict-test-dimension`;

    const preflight = await fetch(`${base}/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        demandKey: 'demand-http',
        projectRoot: '/workspace/project',
        runId: 'strict-run-http',
      }),
    });
    const start = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        demandKey: 'demand-http',
        preflightHash: PREFLIGHT_HASH,
        runId: 'strict-run-http',
      }),
    });
    const status = await fetch(`${base}/runs/strict-run-http`);
    const report = await fetch(`${base}/runs/strict-run-http/report`);

    expect([preflight.status, start.status, status.status, report.status]).toEqual([
      200, 202, 200, 200,
    ]);
    expect(service.preflight).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.status).toHaveBeenCalledTimes(1);
    expect(service.report).toHaveBeenCalledTimes(1);
  });
});
