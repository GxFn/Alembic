import http from 'node:http';
import express from 'express';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const reactiveReport = {
  fixed: 0,
  deprecated: 0,
  skipped: 0,
  needsReview: 1,
  suggestReview: true,
  details: [
    {
      recipeId: 'recipe-1',
      recipeTitle: 'Recipe 1',
      action: 'needs-review' as const,
      reason: 'pattern changed',
      impactLevel: 'pattern' as const,
      modifiedPath: 'src/api.ts',
    },
  ],
  eventSource: 'ide-edit' as const,
};

const evidencePack = {
  project: { root: '/test', primaryLang: 'typescript', fileCount: 1, modules: [] },
  changes: {
    files: ['src/api.ts'],
    impactedDimensions: [],
    impactedRecipeIds: ['recipe-1'],
    impactDetails: [],
  },
  files: [],
  knowledge: [],
  graph: { entities: [], edges: [] },
  gaps: [],
  diagnostics: { truncated: false, warnings: [], retrievalMs: 1 },
};

const mockFileChangeDispatcher = {
  dispatch: vi.fn(async () => reactiveReport),
};
const mockIncrementalCorrectionWorkflow = {
  run: vi.fn(async () => ({
    mode: 'incremental-correction',
    reactiveReport,
    evidencePack,
    auditResult: null,
    skippedAgentReason: 'reactive report did not request review',
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
    mode: 'incremental-correction',
    depth: 'standard',
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
};
const mockScanEvidencePackRepository = {
  create: vi.fn((input: Record<string, unknown>) => ({
    id: 'pack-1',
    runId: input.runId,
    packKind: input.packKind,
    pack: input.pack,
    summary: input.summary ?? {},
    charCount: 100,
    truncated: false,
    createdAt: 120,
  })),
};

function makeContainer() {
  const services: Record<string, unknown> = {
    fileChangeDispatcher: mockFileChangeDispatcher,
    incrementalCorrectionWorkflow: mockIncrementalCorrectionWorkflow,
    scanRunRepository: mockScanRunRepository,
    scanEvidencePackRepository: mockScanEvidencePackRepository,
  };
  return {
    singletons: { _projectRoot: '/test' },
    get: (name: string) => services[name],
  };
}

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => makeContainer()),
}));

import fileChangesRouter from '../../lib/http/routes/file-changes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/file-changes', fileChangesRouter);
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

describe('file changes route', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
  });

  test('keeps the default path limited to dispatcher handling', async () => {
    const { status, body } = await postJson(app, '/api/v1/file-changes', {
      events: [{ type: 'modified', path: 'src/api.ts', eventSource: 'ide-edit' }],
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ needsReview: 1, suggestReview: true });
    expect(body.scan).toBeUndefined();
    expect(mockFileChangeDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(mockIncrementalCorrectionWorkflow.run).not.toHaveBeenCalled();
  });

  test('optionally runs incremental correction with the dispatcher report', async () => {
    const { status, body } = await postJson(app, '/api/v1/file-changes', {
      events: [{ type: 'modified', path: 'src/api.ts', eventSource: 'ide-edit' }],
      scan: { enabled: true, runAgent: false, depth: 'standard' },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scan).toMatchObject({ success: true, run: { status: 'completed' } });
    expect(mockIncrementalCorrectionWorkflow.run).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/test',
        reactiveReport,
        runDeterministic: false,
        runAgent: false,
        depth: 'standard',
      })
    );
    expect(mockScanRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'incremental-correction',
        reason: 'HTTP file changes incremental scan',
      })
    );
    expect(mockScanRunRepository.complete).toHaveBeenCalledWith(
      'scan-1',
      expect.objectContaining({ needsReview: 1, impactedRecipeCount: 1 })
    );
    expect(mockScanEvidencePackRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'scan-1', packKind: 'incremental-correction' })
    );
  });
});
