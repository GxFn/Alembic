import { describe, expect, test, vi } from 'vitest';
import {
  createStrictTestDimensionRouter,
  type StrictTestDimensionApiService,
} from '../../lib/http/routes/strict-test-dimension.js';
import { invokeRouter } from '../helpers/express.js';

const PROJECT_ROOT = '/workspace/project';
const PREFLIGHT_HASH = `sha256:${'a'.repeat(64)}`;

function createService() {
  const status = {
    schemaVersion: 1,
    profile: 'strict-test-dimension',
    demandKey: 'demand-1',
    runId: 'strict-run-1',
    phase: 'PRIVATE_WORKSPACE_READY',
    preflight: { preflightHash: PREFLIGHT_HASH },
    automaticSelection: {
      selectedDimensionId: 'architecture',
      selectedEligibleCellIds: ['core::architecture'],
      selectedEligibleCellsHash: `sha256:${'c'.repeat(64)}`,
      automaticSelectionHash: `sha256:${'d'.repeat(64)}`,
    },
    projection: {
      executionCellIds: ['core::architecture'],
      executionCellSetHash: `sha256:${'c'.repeat(64)}`,
      projectionHash: `sha256:${'e'.repeat(64)}`,
    },
    terminal: null,
    report: null,
    privateEvidenceRefs: [],
  };
  return {
    preflight: vi.fn(async () => ({
      preflight: {
        demandKey: 'demand-1',
        runId: 'strict-run-1',
        preflightHash: PREFLIGHT_HASH,
        fullCellUniverseHash: `sha256:${'f'.repeat(64)}`,
        dimensionResults: Array.from({ length: 26 }, (_, index) => ({
          dimensionId: `dimension-${index}`,
        })),
        cellUniverse: { universeCount: 1, eligibleCount: 1, excludedCount: 0 },
        recommendation: { dimensionId: 'architecture', reasonCode: 'fixture' },
      },
      preview: {
        canAutoSelect: true,
        previewHash: `sha256:${'b'.repeat(64)}`,
      },
    })),
    report: vi.fn(async () => ({
      schemaVersion: 1,
      profile: 'strict-test-dimension',
      demandKey: 'demand-1',
      runId: 'strict-run-1',
      terminalState: 'STRICT_TEST_COMPLETED_PRIVATE',
      terminalHash: `sha256:${'a'.repeat(64)}`,
      reportHash: `sha256:${'b'.repeat(64)}`,
      preflightHash: PREFLIGHT_HASH,
      automaticSelectionHash: `sha256:${'d'.repeat(64)}`,
      projectionHash: `sha256:${'e'.repeat(64)}`,
      fullUniverse: null,
      executedProjection: null,
      unexecutedDimensionIds: null,
      failure: null,
      privateArtifactRefs: [],
    })),
    start: vi.fn(async () => status),
    status: vi.fn(async () => status),
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

  test('never serializes the private checkpoint, source bytes, trust material, or filesystem paths', async () => {
    const privateCheckpoint = {
      schemaVersion: 1,
      profile: 'strict-test-dimension',
      demandKey: 'demand-1',
      runId: 'strict-run-1',
      phase: 'PRIVATE_WORKSPACE_READY',
      runRoot: '/private/control/strict-test-runs/demand-1/strict-run-1',
      executionContext: {
        projection: {
          files: [
            {
              relativePath: 'src/secret.ts',
              contentBase64: Buffer.from('private source').toString('base64'),
            },
          ],
        },
        credentialLocationSymbol: 'config-ref:private-reviewer',
        reviewer: { trustPolicy: { policyHash: `sha256:${'f'.repeat(64)}` } },
      },
      preflight: {
        preflightHash: PREFLIGHT_HASH,
        dimensionResults: Array.from({ length: 26 }, (_, index) => ({
          dimensionId: `dimension-${index}`,
        })),
        cellUniverse: { universeCount: 2, eligibleCount: 2, excludedCount: 0 },
        recommendation: { dimensionId: 'architecture', reasonCode: 'fixture' },
      },
      preview: {
        canAutoSelect: true,
        previewHash: `sha256:${'b'.repeat(64)}`,
      },
      automaticSelection: {
        selectedDimensionId: 'architecture',
        selectedEligibleCellIds: ['module-a::architecture', 'module-b::architecture'],
        automaticSelectionHash: `sha256:${'c'.repeat(64)}`,
      },
      projection: {
        executionCellIds: ['module-a::architecture', 'module-b::architecture'],
        executionCellSetHash: `sha256:${'d'.repeat(64)}`,
        projectionHash: `sha256:${'e'.repeat(64)}`,
      },
      terminal: null,
      report: null,
    };
    const service = {
      preflight: vi.fn(async () => privateCheckpoint),
      start: vi.fn(async () => privateCheckpoint),
      status: vi.fn(async () => privateCheckpoint),
      report: vi.fn(async () => ({
        ...privateCheckpoint,
        privateArtifactRefs: ['/private/control/strict-test-runs/demand-1/strict-run-1'],
      })),
    } satisfies StrictTestDimensionApiService;
    const router = createStrictTestDimensionRouter(() => service);

    const responses = await Promise.all([
      invokeRouter(router, {
        method: 'POST',
        path: '/preflight',
        body: { demandKey: 'demand-1', projectRoot: PROJECT_ROOT, runId: 'strict-run-1' },
      }),
      invokeRouter(router, {
        method: 'POST',
        path: '/runs',
        body: { demandKey: 'demand-1', preflightHash: PREFLIGHT_HASH, runId: 'strict-run-1' },
      }),
      invokeRouter(router, { method: 'GET', path: '/runs/strict-run-1' }),
      invokeRouter(router, { method: 'GET', path: '/runs/strict-run-1/report' }),
    ]);

    for (const response of responses) {
      expect(JSON.stringify(response.body)).not.toMatch(
        /contentBase64|executionContext|credentialLocationSymbol|trustPolicy|runRoot|\/private\//u
      );
    }
    expect(responses[1]?.body).toMatchObject({
      success: true,
      data: {
        runId: 'strict-run-1',
        phase: 'PRIVATE_WORKSPACE_READY',
        automaticSelection: {
          selectedDimensionId: 'architecture',
          selectedCellIds: ['module-a::architecture', 'module-b::architecture'],
        },
      },
    });
  });
});
