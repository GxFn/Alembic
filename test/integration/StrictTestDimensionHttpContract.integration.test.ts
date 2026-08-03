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
    const statusFixture = {
      schemaVersion: 1,
      profile: 'strict-test-dimension',
      demandKey: 'demand-http',
      runId: 'strict-run-http',
      phase: 'PRIVATE_WORKSPACE_READY',
      preflight: { preflightHash: PREFLIGHT_HASH },
      automaticSelection: null,
      projection: null,
      terminal: null,
      report: null,
      privateEvidenceRefs: [],
    };
    const service = {
      preflight: vi.fn(async () => ({
        preflight: {
          demandKey: 'demand-http',
          runId: 'strict-run-http',
          preflightHash: PREFLIGHT_HASH,
          fullCellUniverseHash: `sha256:${'b'.repeat(64)}`,
          dimensionResults: Array.from({ length: 26 }, (_, index) => ({
            dimensionId: `dimension-${index}`,
          })),
          cellUniverse: { universeCount: 1, eligibleCount: 1, excludedCount: 0 },
          recommendation: { dimensionId: 'architecture', reasonCode: 'fixture' },
        },
        preview: { canAutoSelect: true, previewHash: `sha256:${'c'.repeat(64)}` },
      })),
      start: vi.fn(async () => statusFixture),
      status: vi.fn(async () => statusFixture),
      report: vi.fn(async () => ({
        schemaVersion: 1,
        profile: 'strict-test-dimension',
        demandKey: 'demand-http',
        runId: 'strict-run-http',
        terminalState: 'STRICT_TEST_COMPLETED_PRIVATE',
        terminalHash: `sha256:${'d'.repeat(64)}`,
        reportHash: `sha256:${'e'.repeat(64)}`,
        preflightHash: PREFLIGHT_HASH,
        automaticSelectionHash: null,
        projectionHash: null,
        fullUniverse: null,
        executedProjection: null,
        unexecutedDimensionIds: null,
        failure: null,
        privateArtifactRefs: [],
      })),
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
