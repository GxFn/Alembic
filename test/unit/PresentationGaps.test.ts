/**
 * Phase 5 补齐: Knowledge Lifecycle 路由 + 6 态统计 + Lifecycle 状态机
 *
 * 测试文档与实现差异补齐的新代码
 */
import http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ═══ Mock data ════════════════════════════════════════════ */

const mockStats = {
  total: 211,
  pending: 23,
  staging: 5,
  active: 142,
  evolving: 3,
  decaying: 7,
  deprecated: 31,
  rules: 80,
  patterns: 91,
  facts: 40,
};

const mockStagingEntries = [
  { id: 'stg-1', title: 'BD prefix for custom classes', lifecycle: 'staging' },
  { id: 'stg-2', title: 'Use nonatomic for properties', lifecycle: 'staging' },
];

const mockEvolvingEntries = [
  { id: 'evo-1', title: 'Use @weakify/@strongify', lifecycle: 'evolving' },
];

const mockDecayingEntries = [{ id: 'dec-1', title: 'Old dispatch pattern', lifecycle: 'decaying' }];

/* ═══ Mock services ════════════════════════════════════════ */

const mockKnowledgeService = {
  getStats: vi.fn().mockResolvedValue(mockStats),
  list: vi.fn().mockImplementation(async (filters: { lifecycle?: string }) => {
    const map: Record<string, unknown[]> = {
      staging: mockStagingEntries,
      evolving: mockEvolvingEntries,
      decaying: mockDecayingEntries,
    };
    const items = map[filters.lifecycle ?? ''] ?? [];
    return { items, total: items.length, page: 1, pageSize: 20 };
  }),
};

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => ({
    get: (name: string) => {
      const map: Record<string, unknown> = {
        knowledgeService: mockKnowledgeService,
      };
      return map[name] ?? null;
    },
    singletons: { _projectRoot: '/test' },
    logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  })),
}));

/* ═══ Import routes (after mocks) ═════════════════════════ */

import express from 'express';
import knowledgeRouter from '../../lib/http/routes/knowledge.js';

/* ═══ Test helper ═════════════════════════════════════════ */

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/knowledge', knowledgeRouter);
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

/* ═══ Tests ═════════════════════════════════════════════════ */

describe('Knowledge Stats 6-State', () => {
  let app: express.Application;
  beforeEach(() => {
    vi.clearAllMocks();
    mockKnowledgeService.getStats.mockResolvedValue(mockStats);
    app = makeApp();
  });

  it('GET /stats returns all 6 lifecycle states', async () => {
    const { status, body } = await testGet(app, '/api/v1/knowledge/stats');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, number>;
    expect(data.staging).toBe(5);
    expect(data.evolving).toBe(3);
    expect(data.decaying).toBe(7);
    expect(data.pending).toBe(23);
    expect(data.active).toBe(142);
    expect(data.deprecated).toBe(31);
  });
});

describe('Knowledge Lifecycle Route', () => {
  let app: express.Application;
  beforeEach(() => {
    vi.clearAllMocks();
    mockKnowledgeService.getStats.mockResolvedValue(mockStats);
    app = makeApp();
  });

  it('GET /lifecycle returns counts for all 6 states', async () => {
    const { status, body } = await testGet(app, '/api/v1/knowledge/lifecycle');
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const data = body.data as {
      counts: Record<string, number>;
      entries: Record<string, unknown[]>;
    };
    expect(data.counts.pending).toBe(23);
    expect(data.counts.staging).toBe(5);
    expect(data.counts.active).toBe(142);
    expect(data.counts.evolving).toBe(3);
    expect(data.counts.decaying).toBe(7);
    expect(data.counts.deprecated).toBe(31);
  });

  it('GET /lifecycle returns transitional state entries', async () => {
    const { status, body } = await testGet(app, '/api/v1/knowledge/lifecycle');
    expect(status).toBe(200);

    const data = body.data as { entries: Record<string, unknown[]> };
    expect(data.entries.staging).toHaveLength(2);
    expect(data.entries.staging[0]).toHaveProperty('id', 'stg-1');
    expect(data.entries.evolving).toHaveLength(1);
    expect(data.entries.decaying).toHaveLength(1);
  });

  it('GET /lifecycle returns empty entries when transitional counts are 0', async () => {
    mockKnowledgeService.getStats.mockResolvedValue({
      ...mockStats,
      staging: 0,
      evolving: 0,
      decaying: 0,
    });

    const { body } = await testGet(app, '/api/v1/knowledge/lifecycle');
    const data = body.data as { entries: Record<string, unknown[]> };
    expect(data.entries.staging).toEqual([]);
    expect(data.entries.evolving).toEqual([]);
    expect(data.entries.decaying).toEqual([]);
    // list() should not be called at all for 0-count states
    expect(mockKnowledgeService.list).not.toHaveBeenCalled();
  });
});

describe('Lifecycle 6-State Module', () => {
  it('exports all 6 lifecycle states', async () => {
    const { Lifecycle } = await import('../../lib/domain/knowledge/Lifecycle.js');
    expect(Lifecycle.PENDING).toBe('pending');
    expect(Lifecycle.STAGING).toBe('staging');
    expect(Lifecycle.ACTIVE).toBe('active');
    expect(Lifecycle.EVOLVING).toBe('evolving');
    expect(Lifecycle.DECAYING).toBe('decaying');
    expect(Lifecycle.DEPRECATED).toBe('deprecated');
  });

  it('defines valid transitions for all 6 states', async () => {
    const { isValidTransition, Lifecycle } = await import(
      '../../lib/domain/knowledge/Lifecycle.js'
    );
    // pending → staging (valid)
    expect(isValidTransition(Lifecycle.PENDING, Lifecycle.STAGING)).toBe(true);
    // staging → active (valid)
    expect(isValidTransition(Lifecycle.STAGING, Lifecycle.ACTIVE)).toBe(true);
    // active → evolving (valid)
    expect(isValidTransition(Lifecycle.ACTIVE, Lifecycle.EVOLVING)).toBe(true);
    // active → decaying (valid)
    expect(isValidTransition(Lifecycle.ACTIVE, Lifecycle.DECAYING)).toBe(true);
    // decaying → deprecated (valid)
    expect(isValidTransition(Lifecycle.DECAYING, Lifecycle.DEPRECATED)).toBe(true);
    // evolving → active (valid — evolution complete)
    expect(isValidTransition(Lifecycle.EVOLVING, Lifecycle.ACTIVE)).toBe(true);
    // deprecated → pending (valid — revival)
    expect(isValidTransition(Lifecycle.DEPRECATED, Lifecycle.PENDING)).toBe(true);
  });

  it('rejects invalid transitions', async () => {
    const { isValidTransition, Lifecycle } = await import(
      '../../lib/domain/knowledge/Lifecycle.js'
    );
    // pending → evolving (not allowed)
    expect(isValidTransition(Lifecycle.PENDING, Lifecycle.EVOLVING)).toBe(false);
    // staging → deprecated (not allowed)
    expect(isValidTransition(Lifecycle.STAGING, Lifecycle.DEPRECATED)).toBe(false);
    // deprecated → active (not allowed — must go through pending)
    expect(isValidTransition(Lifecycle.DEPRECATED, Lifecycle.ACTIVE)).toBe(false);
  });

  it('normalizes unknown lifecycle values to pending', async () => {
    const { normalizeLifecycle, Lifecycle } = await import(
      '../../lib/domain/knowledge/Lifecycle.js'
    );
    expect(normalizeLifecycle('invalid')).toBe(Lifecycle.PENDING);
    expect(normalizeLifecycle('active')).toBe(Lifecycle.ACTIVE);
  });
});
