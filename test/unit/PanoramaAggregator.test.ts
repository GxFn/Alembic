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
    projectRecipeCount?: number;
    /** DimensionAnalyzer 查询返回的 recipe 元数据 */
    recipeRows?: Array<Record<string, unknown>>;
    topCalled?: Array<Record<string, unknown>>;
  } = {}
) {
  return {
    transaction: (fn: () => void) => fn,
    exec: () => {},
    prepare: (sql: string) => ({
      run: () => ({ changes: 0 }),
      get: (..._params: unknown[]) => {
        if (
          sql.includes('COUNT(*)') &&
          sql.includes('knowledge_entries') &&
          sql.includes('lifecycle')
        ) {
          return { cnt: opts.projectRecipeCount ?? 0 };
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
        // DimensionAnalyzer: SELECT title, category, topicHint, kind FROM knowledge_entries
        if (
          sql.includes('title') &&
          sql.includes('topicHint') &&
          sql.includes('knowledge_entries')
        ) {
          return opts.recipeRows ?? [];
        }
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
    expect(result.healthRadar).toBeDefined();
    expect(result.healthRadar.dimensions.length).toBe(25);
    expect(result.computedAt).toBeGreaterThan(0);
  });

  it('should detect dimension-based gaps when no recipes exist', () => {
    const db = createMockDb({ projectRecipeCount: 0, recipeRows: [] });
    const aggregator = makeAggregator(db);

    const candidates: ModuleCandidate[] = [
      { name: 'BigModule', inferredRole: 'service', files: ['/a', '/b', '/c', '/d', '/e'] },
    ];

    const result = aggregator.compute(candidates);

    // 所有 25 个维度都应为 gap (missing)
    expect(result.gaps.length).toBe(25);
    expect(result.gaps[0].status).toBe('missing');
    expect(result.gaps[0].dimension).toBeDefined();
    expect(result.gaps[0].dimensionName).toBeDefined();
    // service 角色关联 error-handling, concurrency, security → 高优
    const highGaps = result.gaps.filter((g) => g.priority === 'high');
    expect(highGaps.length).toBeGreaterThanOrEqual(1);
    // healthRadar 维度覆盖为 0
    expect(result.healthRadar.coveredDimensions).toBe(0);
    expect(result.healthRadar.overallScore).toBe(0);
  });

  it('should score dimensions based on recipe topicHint', () => {
    const db = createMockDb({
      projectRecipeCount: 8,
      recipeRows: [
        {
          title: 'SPM 模块化',
          category: 'architecture',
          topicHint: 'architecture',
          kind: 'pattern',
        },
        { title: '依赖注入', category: 'architecture', topicHint: 'architecture', kind: 'pattern' },
        { title: '分层策略', category: 'architecture', topicHint: 'architecture', kind: 'pattern' },
        { title: 'URL 路由', category: 'architecture', topicHint: 'architecture', kind: 'pattern' },
        { title: '入口架构', category: 'architecture', topicHint: 'architecture', kind: 'pattern' },
        { title: '命名规范', category: 'code-standard', topicHint: 'conventions', kind: 'rule' },
        { title: 'MARK 分段', category: 'code-standard', topicHint: 'conventions', kind: 'rule' },
        {
          title: '错误恢复',
          category: 'best-practice',
          topicHint: 'error-handling',
          kind: 'pattern',
        },
      ],
    });
    const aggregator = makeAggregator(db);

    const candidates: ModuleCandidate[] = [
      { name: 'TestMod', inferredRole: 'service', files: ['/a', '/b', '/c'] },
    ];

    const result = aggregator.compute(candidates);
    const radar = result.healthRadar;

    // architecture: 5 recipes → strong (score=100)
    const arch = radar.dimensions.find((d) => d.id === 'architecture')!;
    expect(arch.recipeCount).toBe(5);
    expect(arch.score).toBe(100);
    expect(arch.status).toBe('strong');
    expect(arch.level).toBe('adopt');

    // coding-standards: 2 recipes → adequate (score=40)
    const cs = radar.dimensions.find((d) => d.id === 'coding-standards')!;
    expect(cs.recipeCount).toBe(2);
    expect(cs.score).toBe(40);
    expect(cs.status).toBe('adequate');

    // error-resilience: 1 recipe → weak (score=20)
    const eh = radar.dimensions.find((d) => d.id === 'error-resilience')!;
    expect(eh.recipeCount).toBe(1);
    expect(eh.score).toBe(20);
    expect(eh.status).toBe('weak');

    // concurrency-async: 0 → missing
    const cc = radar.dimensions.find((d) => d.id === 'concurrency-async')!;
    expect(cc.recipeCount).toBe(0);
    expect(cc.status).toBe('missing');

    // 维度覆盖: 3 / 25
    expect(radar.coveredDimensions).toBe(3);
    expect(radar.totalDimensions).toBe(25);
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
    expect(result.cycles).toHaveLength(0);
    // 即使 0 个模块，维度雷达仍会生成
    expect(result.healthRadar.dimensions.length).toBe(25);
  });

  it('should populate PanoramaModule fields correctly', () => {
    const db = createMockDb({
      projectRecipeCount: 3,
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
