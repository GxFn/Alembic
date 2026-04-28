import http from 'node:http';
import express from 'express';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockScanPlanService = {
  plan: vi.fn(() => ({ mode: 'maintenance', depth: 'light', reason: 'test plan' })),
};
const mockKnowledgeRetrievalPipeline = {
  retrieve: vi.fn(async () => ({
    project: { root: '/test', primaryLang: 'ts', fileCount: 0, modules: [] },
    files: [],
    knowledge: [],
    graph: { entities: [], edges: [] },
    gaps: [],
    diagnostics: { truncated: false, warnings: [], retrievalMs: 1 },
  })),
};
const mockIncrementalCorrectionWorkflow = {
  run: vi.fn(async () => ({
    mode: 'incremental-correction',
    reactiveReport: {
      fixed: 0,
      deprecated: 0,
      skipped: 0,
      needsReview: 0,
      suggestReview: false,
      details: [],
    },
    evidencePack: {
      project: { root: '/test', primaryLang: 'ts', fileCount: 1, modules: [] },
      files: [],
      knowledge: [],
      graph: { entities: [], edges: [] },
      gaps: [],
      diagnostics: { truncated: false, warnings: [], retrievalMs: 1 },
    },
    auditResult: null,
  })),
};
const mockDeepMiningWorkflow = {
  run: vi.fn(async (request: Record<string, unknown>) => ({
    mode: 'deep-mining',
    baseline: request.baseline ?? null,
    evidencePack: {
      project: { root: '/test', primaryLang: 'ts', fileCount: 0, modules: [] },
      files: [],
      knowledge: [],
      graph: { entities: [], edges: [] },
      gaps: [],
      diagnostics: { truncated: false, warnings: [], retrievalMs: 1 },
    },
    scanResult: null,
    skippedAgentReason: 'agent execution not requested',
  })),
};
const mockMaintenanceWorkflow = {
  run: vi.fn(async () => ({
    mode: 'maintenance',
    sourceRefs: { inserted: 0, active: 0, stale: 0, skipped: 0, recipesProcessed: 0 },
    repairedRenames: { renamed: 0, stillStale: 0 },
    proposals: { executed: [], rejected: [], expired: [], skipped: [] },
    decaySignals: 0,
    enhancementSuggestions: 0,
    redundancyFindings: 0,
    indexRefreshed: true,
    recommendedRuns: [
      {
        mode: 'incremental-correction' as const,
        reason: '1 source refs are stale',
        scope: {},
        priority: 'medium' as const,
      },
    ],
    warnings: [],
  })),
};
const mockScanRunRepository = {
  create: vi.fn((input: Record<string, unknown>) => ({
    id: 'scan-1',
    projectRoot: input.projectRoot,
    mode: input.mode,
    depth: input.depth,
    status: 'running',
    reason: input.reason ?? '',
    activeDimensions: input.activeDimensions ?? [],
    scope: input.scope ?? {},
    changeSet: input.changeSet ?? null,
    budgets: input.budgets ?? {},
    summary: {},
    errorMessage: null,
    parentSnapshotId: null,
    baselineSnapshotId: null,
    startedAt: 100,
    completedAt: null,
    durationMs: null,
  })),
  complete: vi.fn((id: string, summary: Record<string, unknown>) => ({
    id,
    projectRoot: '/test',
    mode: 'maintenance',
    depth: 'light',
    status: 'completed',
    reason: 'done',
    activeDimensions: [],
    scope: {},
    changeSet: null,
    budgets: {},
    summary,
    errorMessage: null,
    parentSnapshotId: null,
    baselineSnapshotId: null,
    startedAt: 100,
    completedAt: 150,
    durationMs: 50,
  })),
  fail: vi.fn(),
  find: vi.fn((filter: Record<string, unknown> = {}) => {
    if (filter.mode === 'cold-start') {
      return [
        {
          id: 'baseline-run-1',
          projectRoot: '/test',
          mode: 'cold-start',
          depth: 'standard',
          status: 'completed',
          reason: 'baseline ready',
          activeDimensions: ['architecture'],
          scope: {},
          changeSet: null,
          budgets: {},
          summary: { baselineSnapshotId: 'snap_baseline_1' },
          errorMessage: null,
          parentSnapshotId: null,
          baselineSnapshotId: 'snap_baseline_1',
          startedAt: 90,
          completedAt: 120,
          durationMs: 30,
        },
      ];
    }
    return [
      {
        id: 'scan-1',
        projectRoot: '/test',
        mode: 'maintenance',
        depth: 'light',
        status: 'completed',
        reason: 'done',
        activeDimensions: [],
        scope: {},
        changeSet: null,
        budgets: {},
        summary: {},
        errorMessage: null,
        parentSnapshotId: null,
        baselineSnapshotId: null,
        startedAt: 100,
        completedAt: 150,
        durationMs: 50,
      },
    ];
  }),
  findById: vi.fn((id: string) =>
    id === 'scan-1'
      ? {
          id: 'scan-1',
          projectRoot: '/test',
          mode: 'maintenance',
          depth: 'light',
          status: 'completed',
          reason: 'done',
          activeDimensions: [],
          scope: {},
          changeSet: null,
          budgets: {},
          summary: {},
          errorMessage: null,
          parentSnapshotId: null,
          baselineSnapshotId: null,
          startedAt: 100,
          completedAt: 150,
          durationMs: 50,
        }
      : null
  ),
};
const mockScanEvidencePackRepository = {
  create: vi.fn((input: Record<string, unknown>) => ({
    id: 'pack-1',
    runId: input.runId,
    packKind: input.packKind ?? 'retrieval',
    pack: input.pack,
    summary: input.summary ?? {},
    charCount: 100,
    truncated: false,
    createdAt: 120,
  })),
  findByRunId: vi.fn((runId: string) => [
    {
      id: 'pack-1',
      runId,
      packKind: 'incremental-correction',
      pack: {
        project: { root: '/test', primaryLang: 'ts', fileCount: 1, modules: [] },
        files: [],
        knowledge: [],
        graph: { entities: [], edges: [] },
        gaps: [],
        diagnostics: { truncated: false, warnings: [], retrievalMs: 1 },
      },
      summary: { fileCount: 0 },
      charCount: 100,
      truncated: false,
      createdAt: 120,
    },
  ]),
};
const mockScanRecommendationRepository = {
  createMany: vi.fn((inputs: Array<Record<string, unknown>>) =>
    inputs.map((input, index) => ({
      id: `scanrec-${index + 1}`,
      projectRoot: input.projectRoot,
      sourceRunId: input.sourceRunId ?? null,
      targetMode: input.mode,
      status: 'pending',
      reason: input.reason,
      scope: input.scope ?? {},
      priority: input.priority ?? 'medium',
      queuedJobId: null,
      executedRunId: null,
      dismissedReason: null,
      createdAt: 160,
      updatedAt: 160,
    }))
  ),
  find: vi.fn(() => [
    {
      id: 'scanrec-1',
      projectRoot: '/test',
      sourceRunId: 'scan-1',
      targetMode: 'deep-mining',
      status: 'pending',
      reason: 'gap found',
      scope: {},
      priority: 'medium',
      queuedJobId: null,
      executedRunId: null,
      dismissedReason: null,
      createdAt: 160,
      updatedAt: 160,
    },
  ]),
  markQueued: vi.fn((id: string, jobId?: string | null) => ({
    id,
    projectRoot: '/test',
    sourceRunId: 'scan-1',
    targetMode: 'deep-mining',
    status: 'queued',
    reason: 'gap found',
    scope: {},
    priority: 'medium',
    queuedJobId: jobId ?? null,
    executedRunId: null,
    dismissedReason: null,
    createdAt: 160,
    updatedAt: 170,
  })),
  markExecuted: vi.fn((id: string, runId?: string | null) => ({
    id,
    projectRoot: '/test',
    sourceRunId: 'scan-1',
    targetMode: 'deep-mining',
    status: 'executed',
    reason: 'gap found',
    scope: {},
    priority: 'medium',
    queuedJobId: 'job-1',
    executedRunId: runId ?? null,
    dismissedReason: null,
    createdAt: 160,
    updatedAt: 180,
  })),
  dismiss: vi.fn((id: string, reason?: string | null) => ({
    id,
    projectRoot: '/test',
    sourceRunId: 'scan-1',
    targetMode: 'deep-mining',
    status: 'dismissed',
    reason: 'gap found',
    scope: {},
    priority: 'medium',
    queuedJobId: null,
    executedRunId: null,
    dismissedReason: reason ?? null,
    createdAt: 160,
    updatedAt: 190,
  })),
};
const mockScanJobQueue = {
  enqueue: vi.fn((input: Record<string, unknown>) => ({
    id: 'job-1',
    mode: input.mode,
    label: input.label,
    status: 'queued',
    request: input.request,
    result: null,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 1,
    createdAt: 200,
    queuedAt: 200,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    cancelRequested: false,
    errorMessage: null,
  })),
  list: vi.fn(() => [
    {
      id: 'job-1',
      mode: 'deep-mining',
      label: 'HTTP deep mining scan',
      status: 'queued',
      request: {},
      result: null,
      attempts: 0,
      maxAttempts: 1,
      createdAt: 200,
      queuedAt: 200,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      cancelRequested: false,
      errorMessage: null,
    },
  ]),
  stats: vi.fn(() => ({ concurrency: 1, running: 0, queued: 1, total: 1 })),
  get: vi.fn((id: string) =>
    id === 'job-1'
      ? {
          id: 'job-1',
          mode: 'deep-mining',
          label: 'HTTP deep mining scan',
          status: 'queued',
          request: {},
          result: null,
          attempts: 0,
          maxAttempts: 1,
          createdAt: 200,
          queuedAt: 200,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          cancelRequested: false,
          errorMessage: null,
        }
      : null
  ),
  cancel: vi.fn((id: string, reason: string) =>
    id === 'job-1'
      ? {
          id: 'job-1',
          mode: 'deep-mining',
          label: 'HTTP deep mining scan',
          status: 'cancelled',
          request: {},
          result: null,
          attempts: 0,
          maxAttempts: 1,
          createdAt: 200,
          queuedAt: 200,
          startedAt: null,
          completedAt: 210,
          durationMs: 0,
          cancelRequested: false,
          errorMessage: reason,
        }
      : null
  ),
  retry: vi.fn((id: string) =>
    id === 'job-1'
      ? {
          id: 'job-1',
          mode: 'deep-mining',
          label: 'HTTP deep mining scan',
          status: 'queued',
          request: {},
          result: null,
          attempts: 0,
          maxAttempts: 1,
          createdAt: 200,
          queuedAt: 220,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          cancelRequested: false,
          errorMessage: null,
        }
      : null
  ),
};

function makeContainer() {
  const services: Record<string, unknown> = {
    scanPlanService: mockScanPlanService,
    knowledgeRetrievalPipeline: mockKnowledgeRetrievalPipeline,
    scanJobQueue: mockScanJobQueue,
    scanRunRepository: mockScanRunRepository,
    scanEvidencePackRepository: mockScanEvidencePackRepository,
    scanRecommendationRepository: mockScanRecommendationRepository,
    incrementalCorrectionWorkflow: mockIncrementalCorrectionWorkflow,
    deepMiningWorkflow: mockDeepMiningWorkflow,
    maintenanceWorkflow: mockMaintenanceWorkflow,
  };
  return {
    singletons: { _projectRoot: '/test' },
    get: (name: string) => services[name],
  };
}

vi.mock('#inject/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => makeContainer()),
}));
vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => makeContainer()),
}));

import scanRouter from '../../lib/http/routes/scan.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/scan', scanRouter);
  return app;
}

async function postJson(
  app: express.Application,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: string) => {
            data += chunk;
          });
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 500, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode ?? 500, body: {} });
            }
          });
        }
      );
      req.on('error', (err: Error) => {
        server.close();
        reject(err);
      });
      req.write(payload);
      req.end();
    });
  });
}

async function testGet(
  app: express.Application,
  path: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      http
        .get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
          let data = '';
          res.on('data', (chunk: string) => {
            data += chunk;
          });
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 500, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode ?? 500, body: {} });
            }
          });
        })
        .on('error', (err: Error) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('scan routes', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
  });

  test('POST /scan/plan delegates to ScanPlanService', async () => {
    const { status, body } = await postJson(app, '/api/v1/scan/plan', {
      intent: 'maintenance',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockScanPlanService.plan).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/test', intent: 'maintenance' })
    );
  });

  test('POST /scan/retrieve delegates to KnowledgeRetrievalPipeline', async () => {
    const { status, body } = await postJson(app, '/api/v1/scan/retrieve', {
      mode: 'incremental-correction',
      query: 'api',
      changeSet: { added: [], modified: ['src/api.ts'], deleted: [] },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockKnowledgeRetrievalPipeline.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/test',
        mode: 'incremental-correction',
        intent: 'audit-impacted-recipes',
      })
    );
  });

  test('POST /scan/incremental-correction keeps Agent disabled by default', async () => {
    const { status, body } = await postJson(app, '/api/v1/scan/incremental-correction', {
      events: [{ type: 'modified', path: 'src/api.ts', eventSource: 'ide-edit' }],
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockIncrementalCorrectionWorkflow.run).toHaveBeenCalledWith(
      expect.objectContaining({ runAgent: false, runDeterministic: true })
    );
    expect(mockScanRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'incremental-correction' })
    );
    expect(mockScanRunRepository.complete).toHaveBeenCalledWith(
      'scan-1',
      expect.objectContaining({ needsReview: 0 })
    );
    expect(mockScanEvidencePackRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'scan-1', packKind: 'incremental-correction' })
    );
  });

  test('POST /scan/maintenance delegates to MaintenanceWorkflow', async () => {
    const { status, body } = await postJson(app, '/api/v1/scan/maintenance', {
      includeRedundancy: true,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockMaintenanceWorkflow.run).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/test', includeRedundancy: true })
    );
    expect(body.run).toEqual(expect.objectContaining({ status: 'completed' }));
    expect(body.recommendations).toEqual([
      expect.objectContaining({ id: 'scanrec-1', status: 'pending' }),
    ]);
    expect(mockScanRecommendationRepository.createMany).toHaveBeenCalledWith([
      expect.objectContaining({
        projectRoot: '/test',
        sourceRunId: 'scan-1',
        mode: 'incremental-correction',
      }),
    ]);
  });

  test('GET /scan/recommendations lists persisted scan recommendations', async () => {
    const { status, body } = await testGet(
      app,
      '/api/v1/scan/recommendations?status=pending&mode=deep-mining'
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockScanRecommendationRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', mode: 'deep-mining' })
    );
    expect(body.data).toEqual([expect.objectContaining({ id: 'scanrec-1' })]);
  });

  test('POST /scan/recommendations/:id/queue marks recommendations queued', async () => {
    const { status, body } = await postJson(app, '/api/v1/scan/recommendations/scanrec-1/queue', {
      jobId: 'job-1',
    });

    expect(status).toBe(200);
    expect(body.data).toEqual(expect.objectContaining({ status: 'queued', queuedJobId: 'job-1' }));
    expect(mockScanRecommendationRepository.markQueued).toHaveBeenCalledWith('scanrec-1', 'job-1');
  });

  test('POST /scan/recommendations/:id/execute marks recommendations executed', async () => {
    const { status, body } = await postJson(app, '/api/v1/scan/recommendations/scanrec-1/execute', {
      runId: 'scan-2',
    });

    expect(status).toBe(200);
    expect(body.data).toEqual(
      expect.objectContaining({ status: 'executed', executedRunId: 'scan-2' })
    );
    expect(mockScanRecommendationRepository.markExecuted).toHaveBeenCalledWith(
      'scanrec-1',
      'scan-2'
    );
  });

  test('POST /scan/recommendations/:id/dismiss marks recommendations dismissed', async () => {
    const { status, body } = await postJson(app, '/api/v1/scan/recommendations/scanrec-1/dismiss', {
      reason: 'not now',
    });

    expect(status).toBe(200);
    expect(body.data).toEqual(
      expect.objectContaining({ status: 'dismissed', dismissedReason: 'not now' })
    );
    expect(mockScanRecommendationRepository.dismiss).toHaveBeenCalledWith('scanrec-1', 'not now');
  });

  test('POST /scan/deep-mining queues async jobs without running immediately', async () => {
    const { status, body } = await postJson(app, '/api/v1/scan/deep-mining', {
      async: true,
      query: 'routing',
      maxAttempts: 2,
    });

    expect(status).toBe(202);
    expect(body.success).toBe(true);
    expect(body.job).toEqual(expect.objectContaining({ id: 'job-1', status: 'queued' }));
    expect(mockScanJobQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'deep-mining',
        maxAttempts: 2,
        request: expect.objectContaining({
          baselineRunId: 'baseline-run-1',
          baselineSnapshotId: 'snap_baseline_1',
        }),
      })
    );
    expect(mockDeepMiningWorkflow.run).not.toHaveBeenCalled();
  });

  test('POST /scan/deep-mining runs against the latest cold-start baseline', async () => {
    const { status, body } = await postJson(app, '/api/v1/scan/deep-mining', {
      query: 'routing',
      dimensions: ['architecture'],
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockDeepMiningWorkflow.run).toHaveBeenCalledWith(
      expect.objectContaining({
        baseline: {
          runId: 'baseline-run-1',
          snapshotId: 'snap_baseline_1',
          source: 'latest-cold-start',
        },
        baselineRunId: 'baseline-run-1',
        baselineSnapshotId: 'snap_baseline_1',
      })
    );
    expect(mockScanRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'deep-mining',
        parentSnapshotId: 'snap_baseline_1',
        baselineSnapshotId: 'snap_baseline_1',
      })
    );
    expect(mockScanRunRepository.complete).toHaveBeenCalledWith(
      'scan-1',
      expect.objectContaining({
        baseline: {
          runId: 'baseline-run-1',
          snapshotId: 'snap_baseline_1',
          source: 'latest-cold-start',
        },
      })
    );
  });

  test('GET /scan/jobs lists queued scan jobs', async () => {
    const { status, body } = await testGet(app, '/api/v1/scan/jobs?status=queued');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockScanJobQueue.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'queued' })
    );
    expect(body.data).toEqual([expect.objectContaining({ id: 'job-1' })]);
  });

  test('POST /scan/jobs/:id/cancel cancels queued scan jobs', async () => {
    const { status, body } = await postJson(app, '/api/v1/scan/jobs/job-1/cancel', {
      reason: 'user changed scope',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockScanJobQueue.cancel).toHaveBeenCalledWith('job-1', 'user changed scope');
    expect(body.data).toEqual(expect.objectContaining({ status: 'cancelled' }));
  });

  test('POST /scan/jobs/:id/retry requeues terminal jobs', async () => {
    const { status, body } = await postJson(app, '/api/v1/scan/jobs/job-1/retry', {
      maxAttempts: 3,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockScanJobQueue.retry).toHaveBeenCalledWith('job-1', 3);
    expect(body.data).toEqual(expect.objectContaining({ status: 'queued' }));
  });

  test('GET /scan/runs lists scan run records', async () => {
    const { status, body } = await testGet(app, '/api/v1/scan/runs?mode=maintenance');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockScanRunRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'maintenance' })
    );
  });

  test('GET /scan/runs/:id returns scan run detail', async () => {
    const { status, body } = await testGet(app, '/api/v1/scan/runs/scan-1');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(expect.objectContaining({ id: 'scan-1' }));
  });

  test('GET /scan/runs/:id/evidence returns persisted evidence packs', async () => {
    const { status, body } = await testGet(app, '/api/v1/scan/runs/scan-1/evidence');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockScanEvidencePackRepository.findByRunId).toHaveBeenCalledWith('scan-1');
    expect(body.data).toEqual([expect.objectContaining({ id: 'pack-1' })]);
  });
});
