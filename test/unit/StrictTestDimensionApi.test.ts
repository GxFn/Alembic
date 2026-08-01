import { describe, expect, test, vi } from 'vitest';
import {
  createStrictTestDimensionRouter,
  type StrictTestDimensionApiService,
} from '../../lib/http/routes/strict-test-dimension.js';
import { invokeRouter } from '../helpers/express.js';

const PROJECT_ROOT = '/workspace/project';
const PREFLIGHT_HASH = `sha256:${'a'.repeat(64)}`;

function createService() {
  return {
    preflight: vi.fn(async () => ({ preflight: { preflightHash: PREFLIGHT_HASH }, preview: {} })),
    report: vi.fn(async () => ({ reportHash: `sha256:${'b'.repeat(64)}` })),
    start: vi.fn(async () => ({ runId: 'strict-run-1', state: 'PRIVATE_WORKSPACE_READY' })),
    status: vi.fn(async () => ({ runId: 'strict-run-1', state: 'PRIVATE_WORKSPACE_READY' })),
  } satisfies StrictTestDimensionApiService;
}

describe('strict-test-dimension HTTP API', () => {
  test('exposes the four independent Main operations', async () => {
    const service = createService();
    const router = createStrictTestDimensionRouter(() => service);

    const preflight = await invokeRouter(router, {
      method: 'POST',
      path: '/preflight',
      body: { demandKey: 'demand-1', projectRoot: PROJECT_ROOT, runId: 'strict-run-1' },
    });
    const start = await invokeRouter(router, {
      method: 'POST',
      path: '/runs',
      body: { demandKey: 'demand-1', preflightHash: PREFLIGHT_HASH, runId: 'strict-run-1' },
    });
    const status = await invokeRouter(router, { method: 'GET', path: '/runs/strict-run-1' });
    const report = await invokeRouter(router, {
      method: 'GET',
      path: '/runs/strict-run-1/report',
    });

    expect(preflight.status).toBe(200);
    expect(start.status).toBe(202);
    expect(status.status).toBe(200);
    expect(report.status).toBe(200);
    expect(service.preflight).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.status).toHaveBeenCalledWith('strict-run-1');
    expect(service.report).toHaveBeenCalledWith('strict-run-1');
  });

  test.each([
    ['dimension', { dimension: 'architecture' }],
    ['confirmation', { confirmation: 'confirm' }],
    ['test mode', { testMode: true }],
    ['strict production', { strictProduction: {} }],
    ['caller root', { privateRoot: '/tmp/private' }],
  ])('rejects forbidden %s before calling the service', async (_label, extra) => {
    const service = createService();
    const result = await invokeRouter(
      createStrictTestDimensionRouter(() => service),
      {
        method: 'POST',
        path: '/preflight',
        body: {
          demandKey: 'demand-1',
          projectRoot: PROJECT_ROOT,
          runId: 'strict-run-1',
          ...extra,
        },
      }
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      success: false,
      error: { code: 'STRICT_TEST_REQUEST_INVALID' },
    });
    expect(service.preflight).not.toHaveBeenCalled();
  });

  test('rejects unknown start fields and query parameters before service access', async () => {
    const service = createService();
    const router = createStrictTestDimensionRouter(() => service);
    const start = await invokeRouter(router, {
      method: 'POST',
      path: '/runs',
      body: {
        demandKey: 'demand-1',
        preflightHash: PREFLIGHT_HASH,
        runId: 'strict-run-1',
        dimension: 'architecture',
      },
    });
    const status = await invokeRouter(router, {
      method: 'GET',
      path: '/runs/strict-run-1?testMode=true',
    });
    const preflight = await invokeRouter(router, {
      method: 'POST',
      path: '/preflight?profile=strict-test-dimension',
      body: { demandKey: 'demand-1', projectRoot: PROJECT_ROOT, runId: 'strict-run-1' },
    });

    expect(start.status).toBe(400);
    expect(status.status).toBe(400);
    expect(preflight.status).toBe(400);
    expect(service.start).not.toHaveBeenCalled();
    expect(service.preflight).not.toHaveBeenCalled();
    expect(service.status).not.toHaveBeenCalled();
  });

  test('returns typed not-found and report-not-ready responses', async () => {
    const service = createService();
    service.status.mockRejectedValueOnce(new Error('STRICT_TEST_RUN_NOT_FOUND'));
    service.report.mockRejectedValueOnce(new Error('STRICT_TEST_REPORT_NOT_READY'));
    const router = createStrictTestDimensionRouter(() => service);

    const status = await invokeRouter(router, { method: 'GET', path: '/runs/missing-run' });
    const report = await invokeRouter(router, {
      method: 'GET',
      path: '/runs/strict-run-1/report',
    });

    expect(status.status).toBe(404);
    expect(status.body).toMatchObject({
      success: false,
      error: { code: 'STRICT_TEST_RUN_NOT_FOUND' },
    });
    expect(report.status).toBe(409);
    expect(report.body).toMatchObject({
      success: false,
      error: { code: 'STRICT_TEST_REPORT_NOT_READY' },
    });
  });
});
