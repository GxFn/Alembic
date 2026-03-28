/**
 * PanoramaAggregator 单元测试
 */
import { describe, expect, it } from 'vitest';
import { CouplingAnalyzer } from '../../lib/service/panorama/CouplingAnalyzer.js';
import { LayerInferrer } from '../../lib/service/panorama/LayerInferrer.js';
import { PanoramaAggregator } from '../../lib/service/panorama/PanoramaAggregator.js';
import type { ModuleCandidate } from '../../lib/service/panorama/RoleRefiner.js';
import { RoleRefiner } from '../../lib/service/panorama/RoleRefiner.js';

/* ═══ Mock DB ═════════════════════════════════════════════ */

function createMockDb(
  opts: {
    moduleEdges?: Array<Record<string, unknown>>;
    recipeCount?: number;
    topCalled?: Array<Record<string, unknown>>;
  } = {}
) {
  return {
    transaction: (fn: () => void) => fn,
    exec: () => {},
    prepare: (sql: string) => ({
      run: () => ({ changes: 0 }),
      get: (..._params: unknown[]) => {
        if (sql.includes('COUNT(DISTINCT ke.id)')) {
          return { cnt: opts.recipeCount ?? 0 };
        }
        if (sql.includes('COUNT(*)') && sql.includes('from_id = ce.entity_id')) {
          return { cnt: 0 };
        }
        if (sql.includes('COUNT(*)') && sql.includes('to_id = ce.entity_id')) {
          return { cnt: 0 };
        }
        if (sql.includes('file_path') && sql.includes('code_entities') && !sql.includes('COUNT')) {
          return undefined;
        }
        return undefined;
      },
      all: (...params: unknown[]) => {
        if (sql.includes('knowledge_edges') && sql.includes('relation = ?')) {
          const relation = params[0] as string;
          return (opts.moduleEdges ?? []).filter((e) => e.relation === relation);
        }
        if (sql.includes("relation = 'calls'") && sql.includes('GROUP BY to_id')) {
          return opts.topCalled ?? [];
        }
        if (sql.includes('NOT IN')) {
          return [];
        }
        if (sql.includes("relation = 'data_flow'") && sql.includes('GROUP BY')) {
          return [];
        }
        return [];
      },
    }),
  };
}

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('PanoramaAggregator', () => {
  function makeAggregator(db: ReturnType<typeof createMockDb>) {
    const projectRoot = '/test';
    return new PanoramaAggregator({
      roleRefiner: new RoleRefiner(db as never, projectRoot),
      couplingAnalyzer: new CouplingAnalyzer(db as never, projectRoot),
      layerInferrer: new LayerInferrer(),
      db: db as never,
      projectRoot,
    });
  }

  it('should compute panorama for simple module set', () => {
    const db = createMockDb({
      moduleEdges: [
        {
          from_id: 'App',
          from_type: 'module',
          to_id: 'Core',
          to_type: 'module',
          relation: 'depends_on',
        },
      ],
    });
    const aggregator = makeAggregator(db);

    const candidates: ModuleCandidate[] = [
      { name: 'App', inferredRole: 'app', files: ['/test/app.swift'] },
      { name: 'Core', inferredRole: 'core', files: ['/test/core.swift'] },
    ];

    const result = aggregator.compute(candidates);

    expect(result.modules.size).toBe(2);
    expect(result.modules.has('App')).toBe(true);
    expect(result.modules.has('Core')).toBe(true);
    expect(result.layers.levels.length).toBeGreaterThanOrEqual(1);
    expect(result.computedAt).toBeGreaterThan(0);
  });

  it('should detect knowledge gaps for modules with no recipes', () => {
    const db = createMockDb({ recipeCount: 0 });
    const aggregator = makeAggregator(db);

    const candidates: ModuleCandidate[] = [
      { name: 'BigModule', inferredRole: 'service', files: ['/a', '/b', '/c', '/d', '/e'] },
    ];

    const result = aggregator.compute(candidates);

    expect(result.gaps.length).toBeGreaterThanOrEqual(1);
    expect(result.gaps[0].module).toBe('BigModule');
    expect(result.gaps[0].priority).toBe('high');
  });

  it('should compute call flow summary', () => {
    const db = createMockDb({
      topCalled: [{ to_id: 'doSomething', call_count: 42 }],
    });
    const aggregator = makeAggregator(db);

    const result = aggregator.compute([{ name: 'Mod', inferredRole: 'feature', files: [] }]);

    expect(result.callFlowSummary).toBeDefined();
    expect(result.callFlowSummary.topCalledMethods.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty module set', () => {
    const db = createMockDb();
    const aggregator = makeAggregator(db);

    const result = aggregator.compute([]);

    expect(result.modules.size).toBe(0);
    expect(result.gaps).toHaveLength(0);
    expect(result.cycles).toHaveLength(0);
  });

  it('should populate PanoramaModule fields correctly', () => {
    const db = createMockDb({
      recipeCount: 3,
      moduleEdges: [],
    });
    const aggregator = makeAggregator(db);

    const candidates: ModuleCandidate[] = [
      { name: 'TestMod', inferredRole: 'service', files: ['/a', '/b', '/c'] },
    ];

    const result = aggregator.compute(candidates);
    const mod = result.modules.get('TestMod')!;

    expect(mod.name).toBe('TestMod');
    expect(mod.inferredRole).toBe('service');
    expect(mod.fileCount).toBe(3);
    expect(mod.recipeCount).toBe(3);
    expect(mod.coverageRatio).toBe(1); // 3 recipes / 3 files
  });
});
