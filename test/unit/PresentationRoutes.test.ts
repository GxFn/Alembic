/**
 * Phase 5: Presentation Layer HTTP Routes — 单元测试
 *
 * 测试 governance / audit 路由对 DI 服务的调用（guardReport 路由已随 CCR-1 下线）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRouter, invokeRouter } from '../helpers/express.js';

/* ═══ Mock data ═══════════════════════════════════════════ */

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

const mockDecayDetector = {
  scanAll: vi.fn().mockResolvedValue([{ id: 'decay-1', status: 'watch' }]),
};

const mockStagingManager = {
  checkAndPromote: vi.fn().mockResolvedValue({ promoted: 1 }),
  listStaging: vi.fn().mockResolvedValue([{ id: 'staging-1' }]),
};

const mockEnhancementSuggester = {
  analyzeAll: vi.fn().mockResolvedValue([{ id: 'enhancement-1' }]),
};

const mockAuditStore = {
  query: vi.fn().mockReturnValue(mockAuditLogs),
};

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => ({
    get: (name: string) => {
      const map: Record<string, unknown> = {
        auditStore: mockAuditStore,
        decayDetector: mockDecayDetector,
        enhancementSuggester: mockEnhancementSuggester,
        stagingManager: mockStagingManager,
      };
      return map[name] ?? null;
    },
    singletons: { _projectRoot: '/test' },
    logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  })),
}));

vi.mock('@alembic/core/workspace', () => ({
  resolveProjectRoot: vi.fn(() => '/test'),
}));

/* ═══ Import routes (after mocks) ═════════════════════════ */

import auditRouter from '../../lib/http/routes/audit.js';
import governanceRouter from '../../lib/http/routes/governance.js';

/* ═══ Test helper ═════════════════════════════════════════ */

async function testGet(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (path.startsWith('/api/v1/governance')) {
    return getRouter(governanceRouter, path, { mountPath: '/api/v1/governance' });
  }
  if (path.startsWith('/api/v1/audit')) {
    return getRouter(auditRouter, path, { mountPath: '/api/v1/audit' });
  }
  throw new Error(`Unknown route under test: ${path}`);
}

async function testPost(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (path.startsWith('/api/v1/governance')) {
    return invokeRouter(governanceRouter, {
      method: 'POST',
      mountPath: '/api/v1/governance',
      path,
    });
  }
  throw new Error(`Unknown route under test: ${path}`);
}

/* ═══ Tests ════════════════════════════════════════════════ */

describe('Phase 5: Governance Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /governance/cycle returns the retired metabolism signal', async () => {
    const { status, body } = await testPost('/api/v1/governance/cycle');
    expect(status).toBe(410);
    expect(body.success).toBe(false);
    expect(body.error).toMatchObject({ code: 'REMOVED' });
  });

  it('GET /governance/decay returns active decay results', async () => {
    const { status, body } = await testGet('/api/v1/governance/decay');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ results: [{ id: 'decay-1', status: 'watch' }] });
    expect(mockDecayDetector.scanAll).toHaveBeenCalledTimes(1);
  });

  it('POST /governance/staging-check keeps staging governance active', async () => {
    const { status, body } = await testPost('/api/v1/governance/staging-check');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      checkResult: { promoted: 1 },
      currentStaging: [{ id: 'staging-1' }],
    });
    expect(mockStagingManager.checkAndPromote).toHaveBeenCalledTimes(1);
    expect(mockStagingManager.listStaging).toHaveBeenCalledTimes(1);
  });

  it('GET /governance/enhancements returns active enhancement suggestions', async () => {
    const { status, body } = await testGet('/api/v1/governance/enhancements');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ suggestions: [{ id: 'enhancement-1' }] });
    expect(mockEnhancementSuggester.analyzeAll).toHaveBeenCalledTimes(1);
  });
});

describe('Phase 5: Audit Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /audit returns logs', async () => {
    const { status, body } = await testGet('/api/v1/audit');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as { logs: unknown[]; total: number };
    expect(data.logs.length).toBe(2);
    expect(data.total).toBe(2);
  });

  it('GET /audit passes filter params', async () => {
    await testGet('/api/v1/audit?actor=agent&action=check&limit=50');
    expect(mockAuditStore.query).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'agent', action: 'check', limit: 50 })
    );
  });

  it('GET /audit caps limit at 500', async () => {
    await testGet('/api/v1/audit?limit=999');
    expect(mockAuditStore.query).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
  });

  it('GET /audit rejects invalid numeric query', async () => {
    const { status, body } = await testGet('/api/v1/audit?limit=abc');
    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
