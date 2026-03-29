/**
 * Phase 5: Presentation Layer HTTP Routes — 单元测试
 *
 * 测试 panorama / guardReport / audit 三个新路由对 DI 服务的调用
 */
import http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ═══ Mock data ═══════════════════════════════════════════ */

const mockOverview = {
  projectRoot: '/test',
  moduleCount: 5,
  layerCount: 3,
  totalFiles: 100,
  totalRecipes: 20,
  overallCoverage: 0.2,
  layers: [
    {
      level: 0,
      name: 'Foundation',
      modules: [{ name: 'Utils', role: 'utility', fileCount: 10, recipeCount: 2 }],
    },
  ],
  cycleCount: 1,
  gapCount: 2,
  healthRadar: {
    dimensions: [],
    overallScore: 20,
    totalRecipes: 20,
    coveredDimensions: 2,
    totalDimensions: 11,
    dimensionCoverage: 0.18,
  },
  computedAt: Date.now(),
  stale: false,
};

const mockHealth = {
  healthRadar: {
    dimensions: [],
    overallScore: 20,
    totalRecipes: 20,
    coveredDimensions: 2,
    totalDimensions: 11,
    dimensionCoverage: 0.18,
  },
  avgCoupling: 3.5,
  cycleCount: 1,
  gapCount: 2,
  highPriorityGaps: 1,
  moduleCount: 5,
  healthScore: 65,
};

const mockGaps = [
  {
    dimension: 'error-handling',
    dimensionName: '错误处理',
    recipeCount: 0,
    status: 'missing',
    priority: 'high',
    suggestedTopics: ['exception-pattern'],
    affectedRoles: ['service'],
  },
  {
    dimension: 'concurrency',
    dimensionName: '并发与线程',
    recipeCount: 1,
    status: 'weak',
    priority: 'medium',
    suggestedTopics: ['thread-safety'],
    affectedRoles: [],
  },
];

const mockModuleDetail = {
  module: { name: 'Utils', fileCount: 10 },
  layerName: 'Foundation',
  neighbors: [],
  fileGroups: [{ group: '(root)', files: [], count: 10 }],
  recipes: [],
  uncoveredFileCount: 10,
  summary: 'Utils is a Foundation layer module.',
};

const mockReport = {
  timestamp: '2024-01-01T00:00:00.000Z',
  projectRoot: '/test',
  qualityGate: { status: 'PASS', score: 85, thresholds: {} },
  complianceScore: 85,
  coverageScore: 90,
  confidenceScore: 95,
  summary: { filesScanned: 50, errors: 2, warnings: 5, infos: 3, totalViolations: 10 },
  topViolations: [],
  fileHotspots: [],
  ruleHealth: [],
  trend: { errorsChange: 0, warningsChange: 0, hasHistory: false },
};

const mockAuditLogs = [
  {
    id: 'audit_1',
    timestamp: Date.now(),
    actor: 'agent',
    action: 'check',
    resource: '/file.ts',
    result: 'success',
  },
  {
    id: 'audit_2',
    timestamp: Date.now(),
    actor: 'user',
    action: 'create',
    resource: '/recipe',
    result: 'success',
  },
];

/* ═══ Mock services ════════════════════════════════════════ */

const mockPanoramaService = {
  getOverview: vi.fn().mockReturnValue(mockOverview),
  getHealth: vi.fn().mockReturnValue(mockHealth),
  getGaps: vi.fn().mockReturnValue(mockGaps),
  getModule: vi
    .fn()
    .mockImplementation((name: string) => (name === 'Utils' ? mockModuleDetail : null)),
};

const mockComplianceReporter = {
  generate: vi.fn().mockResolvedValue(mockReport),
};

const mockAuditStore = {
  query: vi.fn().mockReturnValue(mockAuditLogs),
};

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => ({
    get: (name: string) => {
      const map: Record<string, unknown> = {
        panoramaService: mockPanoramaService,
        complianceReporter: mockComplianceReporter,
        auditStore: mockAuditStore,
      };
      return map[name] ?? null;
    },
    singletons: { _projectRoot: '/test' },
    logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  })),
}));

vi.mock('../../lib/shared/resolveProjectRoot.js', () => ({
  resolveProjectRoot: vi.fn(() => '/test'),
}));

/* ═══ Import routes (after mocks) ═════════════════════════ */

import express from 'express';
import auditRouter from '../../lib/http/routes/audit.js';
import guardReportRouter from '../../lib/http/routes/guardReport.js';
import panoramaRouter from '../../lib/http/routes/panorama.js';

/* ═══ Test helper ═════════════════════════════════════════ */

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/panorama', panoramaRouter);
  app.use('/api/v1/guard/report', guardReportRouter);
  app.use('/api/v1/audit', auditRouter);
  return app;
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

/* ═══ Tests ════════════════════════════════════════════════ */

describe('Phase 5: Panorama Route', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
  });

  it('GET /panorama returns overview', async () => {
    const { status, body } = await testGet(app, '/api/v1/panorama');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as Record<string, unknown>).moduleCount).toBe(5);
    expect(mockPanoramaService.getOverview).toHaveBeenCalled();
  });

  it('GET /panorama/health returns health', async () => {
    const { status, body } = await testGet(app, '/api/v1/panorama/health');
    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).healthScore).toBe(65);
    expect(mockPanoramaService.getHealth).toHaveBeenCalled();
  });

  it('GET /panorama/gaps returns gaps', async () => {
    const { status, body } = await testGet(app, '/api/v1/panorama/gaps');
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(2);
  });

  it('GET /panorama/module/:name returns detail', async () => {
    const { status, body } = await testGet(app, '/api/v1/panorama/module/Utils');
    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).layerName).toBe('Foundation');
    expect(mockPanoramaService.getModule).toHaveBeenCalledWith('Utils');
  });

  it('GET /panorama/module/:name 404 for unknown', async () => {
    const { status, body } = await testGet(app, '/api/v1/panorama/module/Unknown');
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });
});

describe('Phase 5: Guard Report Route', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
  });

  it('GET /guard/report returns compliance report', async () => {
    const { status, body } = await testGet(app, '/api/v1/guard/report');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as Record<string, unknown>).complianceScore).toBe(85);
    expect(mockComplianceReporter.generate).toHaveBeenCalled();
  });

  it('GET /guard/report passes query params', async () => {
    await testGet(app, '/api/v1/guard/report?minScore=80&maxFiles=100');
    expect(mockComplianceReporter.generate).toHaveBeenCalledWith(
      '/test',
      expect.objectContaining({
        qualityGate: { minScore: 80, maxErrors: undefined },
        maxFiles: 100,
      })
    );
  });
});

describe('Phase 5: Audit Route', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
  });

  it('GET /audit returns logs', async () => {
    const { status, body } = await testGet(app, '/api/v1/audit');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as { logs: unknown[]; total: number };
    expect(data.logs.length).toBe(2);
    expect(data.total).toBe(2);
  });

  it('GET /audit passes filter params', async () => {
    await testGet(app, '/api/v1/audit?actor=agent&action=check&limit=50');
    expect(mockAuditStore.query).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'agent', action: 'check', limit: 50 })
    );
  });

  it('GET /audit caps limit at 500', async () => {
    await testGet(app, '/api/v1/audit?limit=999');
    expect(mockAuditStore.query).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
  });
});
