import { evaluateProjectAnalysisIncrementalPlan } from '@alembic/core/project-intelligence';
import { describe, expect, test, vi } from 'vitest';

function createSnapshotDb() {
  const get = vi.fn(() => null);
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    get,
  };
  const drizzle = {
    select: vi.fn(() => chain),
  };
  const db = {
    marker: 'database',
    getDrizzle: vi.fn(() => drizzle),
  };

  return { db, get };
}

describe('ProjectIntelligenceIncrementalPlanner', () => {
  test('resolves the workflow database from container.get("database")', async () => {
    const { db } = createSnapshotDb();
    const report = { phases: {}, startTime: Date.now() };

    const result = await evaluateProjectAnalysisIncrementalPlan({
      enabled: true,
      projectRoot: '/repo',
      ctx: {
        container: { get: (name: string) => (name === 'database' ? db : null) },
        logger: { info: vi.fn() },
      },
      allFiles: [{ path: '/repo/a.ts', relativePath: 'a.ts', content: 'export {}' }],
      report,
    });

    expect(db.getDrizzle).toHaveBeenCalledOnce();
    expect(result.incrementalPlan?.mode).toBe('full');
    expect(result.warnings).toEqual([]);
    expect(report.phases.incremental).toEqual({ plan: result.incrementalPlan });
  });

  test('preserves this binding when resolving database from a ServiceContainer-like object', async () => {
    const { db } = createSnapshotDb();
    const container = {
      get(name: string) {
        return this === container && name === 'database' ? db : null;
      },
    };

    const result = await evaluateProjectAnalysisIncrementalPlan({
      enabled: true,
      projectRoot: '/repo',
      ctx: {
        container,
        logger: { info: vi.fn() },
      },
      allFiles: [],
      report: null,
    });

    expect(db.getDrizzle).toHaveBeenCalledOnce();
    expect(result.incrementalPlan?.mode).toBe('full');
    expect(result.warnings).toEqual([]);
  });

  test('falls back through resolver aliases before reporting missing db', async () => {
    const { db } = createSnapshotDb();

    await evaluateProjectAnalysisIncrementalPlan({
      enabled: true,
      projectRoot: '/repo',
      ctx: {
        container: {
          get: () => {
            throw new Error('missing');
          },
        },
        db,
        logger: { info: vi.fn() },
      },
      allFiles: [],
      report: null,
    });

    expect(db.getDrizzle).toHaveBeenCalledOnce();

    const result = await evaluateProjectAnalysisIncrementalPlan({
      enabled: true,
      projectRoot: '/repo',
      ctx: {
        container: { get: () => null, resolve: () => null },
        logger: { info: vi.fn() },
      },
      allFiles: [],
      report: null,
    });

    expect(result.incrementalPlan).toBeNull();
    expect(result.warnings).toEqual(['incremental: db not available, falling back to full']);
  });
});
