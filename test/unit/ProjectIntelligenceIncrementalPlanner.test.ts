import { beforeEach, describe, expect, test, vi } from 'vitest';
import { evaluateProjectAnalysisIncrementalPlan } from '#workflows/capabilities/project-intelligence/ProjectIntelligenceIncrementalPlanner.js';

const fileDiffPlannerMock = vi.hoisted(() => {
  const evaluate = vi.fn();
  const constructorArgs: unknown[][] = [];
  class FileDiffPlanner {
    constructor(...args: unknown[]) {
      constructorArgs.push(args);
    }

    evaluate(...args: unknown[]) {
      return evaluate(...args);
    }
  }
  return { evaluate, constructorArgs, FileDiffPlanner };
});

vi.mock('#workflows/capabilities/project-intelligence/FileDiffPlanner.js', () => ({
  FileDiffPlanner: fileDiffPlannerMock.FileDiffPlanner,
}));

describe('ProjectIntelligenceIncrementalPlanner', () => {
  beforeEach(() => {
    fileDiffPlannerMock.evaluate.mockReset();
    fileDiffPlannerMock.constructorArgs.length = 0;
  });

  test('resolves the workflow database from container.get("database")', async () => {
    const db = { marker: 'database' };
    const plan = {
      canIncremental: true,
      mode: 'incremental',
      affectedDimensions: ['architecture'],
      skippedDimensions: [],
      previousSnapshot: null,
      diff: null,
      reason: 'test',
      restoredEpisodic: null,
    };
    const report = { phases: {}, startTime: Date.now() };
    fileDiffPlannerMock.evaluate.mockReturnValue(plan);

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

    expect(fileDiffPlannerMock.constructorArgs[0]?.[0]).toBe(db);
    expect(result).toEqual({ incrementalPlan: plan, warnings: [] });
    expect(report.phases.incremental).toEqual({ plan });
  });

  test('preserves this binding when resolving database from a ServiceContainer-like object', async () => {
    const db = { marker: 'bound-database' };
    const plan = {
      canIncremental: true,
      mode: 'incremental',
      affectedDimensions: ['architecture'],
      skippedDimensions: [],
      previousSnapshot: null,
      diff: null,
      reason: 'bound',
      restoredEpisodic: null,
    };
    const container = {
      get(name: string) {
        return this === container && name === 'database' ? db : null;
      },
    };
    fileDiffPlannerMock.evaluate.mockReturnValue(plan);

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

    expect(fileDiffPlannerMock.constructorArgs[0]?.[0]).toBe(db);
    expect(result).toEqual({ incrementalPlan: plan, warnings: [] });
  });

  test('falls back through resolver aliases before reporting missing db', async () => {
    const db = { marker: 'ctx-db' };
    fileDiffPlannerMock.evaluate.mockReturnValue({
      canIncremental: false,
      mode: 'full',
      affectedDimensions: [],
      skippedDimensions: [],
      previousSnapshot: null,
      diff: null,
      reason: 'full',
      restoredEpisodic: null,
    });

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

    expect(fileDiffPlannerMock.constructorArgs[0]?.[0]).toBe(db);

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
